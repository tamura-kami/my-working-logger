import { Hono } from 'hono';
import { z } from 'zod';
import type { PomodoroSettings, TimerCommand, TimerSnapshot, TimerState } from '../shared/contracts';
import type { Bindings } from './env';
import { ApiError, body } from './http';

const api = new Hono<{ Bindings: Bindings }>();
const common = { operation_id: z.uuid(), revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER) };
const minutes = z.number().int().min(1).max(180);
const settingsSchema = z.strictObject({ focus_minutes: minutes, short_break_minutes: minutes, long_break_minutes: minutes, long_break_every: z.number().int().min(1).max(20) });
const commandSchema = z.discriminatedUnion('action', [
  z.strictObject({ ...common, action: z.literal('start'), project_id: z.uuid(), mode: z.enum(['normal', 'pomodoro']).optional(), pomodoro: settingsSchema.optional() }).superRefine((v, ctx) => {
    if ((v.mode === 'pomodoro') !== !!v.pomodoro) ctx.addIssue({ code: 'custom', message: 'ポモドーロ設定が必要です。' });
  }),
  ...(['pause', 'resume', 'finish', 'start_break', 'start_focus', 'skip'] as const).map((action) => z.strictObject({ ...common, action: z.literal(action), timer_id: z.uuid() })),
]);
interface Operation { payload: string; session_id: string | null; discarded: number }
type TimerRow = Omit<TimerState, 'pomodoro'> & {
  focus_minutes: number | null; short_break_minutes: number | null; long_break_minutes: number | null; long_break_every: number | null;
};
async function readState(db: D1Database): Promise<TimerState> {
  const row = await db.prepare(`SELECT t.*, p.name AS project_name, p.color
    FROM timer_state t LEFT JOIN projects p ON p.id = t.project_id WHERE t.id = 1`).first<TimerRow>();
  if (!row) throw new Error('Timer migration missing');
  const { focus_minutes, short_break_minutes, long_break_minutes, long_break_every, ...timer } = row;
  // id / last_operation_id は内部用途のためレスポンスから除く。
  return {
    revision: timer.revision, timer_id: timer.timer_id, project_id: timer.project_id, project_name: timer.project_name,
    color: timer.color, status: timer.status, started_at: timer.started_at, changed_at: timer.changed_at, paused_ms: timer.paused_ms,
    mode: timer.mode, phase: timer.phase, completed_focus: timer.completed_focus, duration_ms: timer.duration_ms, deadline_at: timer.deadline_at,
    pomodoro: timer.mode === 'pomodoro' ? { focus_minutes: focus_minutes!, short_break_minutes: short_break_minutes!, long_break_minutes: long_break_minutes!, long_break_every: long_break_every! } : null,
  };
}
const idleFields = `timer_id = NULL, project_id = NULL, status = 'idle', started_at = NULL, changed_at = NULL,
  paused_ms = 0, mode = 'normal', phase = NULL, completed_focus = 0, focus_minutes = NULL,
  short_break_minutes = NULL, long_break_minutes = NULL, long_break_every = NULL, duration_ms = NULL, deadline_at = NULL`;

// どの API からでも期限超過を解決する。休憩・次の集中は開始しない。
export async function resolveExpired(db: D1Database) {
  const state = await readState(db);
  if (state.mode !== 'pomodoro' || state.status !== 'running' || state.deadline_at === null || Date.now() < state.deadline_at) return;
  const guard = "id = 1 AND revision = ? AND timer_id = ? AND mode = 'pomodoro' AND status = 'running' AND deadline_at = ?";
  const args = [state.revision, state.timer_id, state.deadline_at];
  const statements: D1PreparedStatement[] = [];
  if (state.phase === 'focus') {
    statements.push(db.prepare(`INSERT INTO work_sessions (id, project_id, started_at, ended_at, paused_ms)
      SELECT timer_id, project_id, started_at, deadline_at, paused_ms FROM timer_state WHERE ${guard}`).bind(...args));
  }
  const count = state.completed_focus + (state.phase === 'focus' ? 1 : 0);
  const phase = state.phase === 'focus' ? (count % state.pomodoro!.long_break_every === 0 ? 'long_break' : 'short_break') : 'focus';
  const duration = phaseDuration(state.pomodoro!, phase);
  statements.push(db.prepare(`UPDATE timer_state SET revision = revision + 1, status = 'waiting', phase = ?,
    completed_focus = ?, started_at = NULL, changed_at = deadline_at, paused_ms = 0, duration_ms = ?, deadline_at = NULL
    WHERE ${guard}`).bind(phase, count, duration, ...args));
  await db.batch(statements);
}
function phaseDuration(settings: PomodoroSettings, phase: TimerState['phase']) {
  return (phase === 'focus' ? settings.focus_minutes : phase === 'short_break' ? settings.short_break_minutes : settings.long_break_minutes) * 60000;
}
export async function snapshot(db: D1Database): Promise<TimerSnapshot> {
  const timer = await readState(db);
  return { timer, server_now: Math.max(Date.now(), timer.changed_at ?? 0) };
}
async function operation(db: D1Database, id: string) {
  return db.prepare('SELECT payload, session_id, discarded FROM timer_operations WHERE id = ?').bind(id).first<Operation>();
}
async function operationResponse(db: D1Database, command: TimerCommand, payload: string, previous: Operation) {
  if (previous.payload !== payload) throw new ApiError(409, '同じ操作 ID で別の操作は送信できません。');
  return { ...await snapshot(db), outcome: { action: command.action, session_id: previous.session_id, discarded: !!previous.discarded } };
}
api.get('/timer', async (c) => c.json(await snapshot(c.env.DB)));
api.post('/timer', async (c) => {
  const command = await body(c, commandSchema) as TimerCommand;
  const payload = JSON.stringify(command);
  const db = c.env.DB;
  const previous = await operation(db, command.operation_id);
  if (previous) return c.json(await operationResponse(db, command, payload, previous));
  try {
    const { timer: state, server_now: now } = await snapshot(db);
    if (state.revision !== command.revision) throw new ApiError(409, '別の端末で状態が変更されたか、タイマーが満了しました。最新の状態を確認してください。');
    const statements: D1PreparedStatement[] = [];
    let sessionId: string | null = null;
    let discarded = false;
    const guard = 'id = 1 AND revision = ? AND NOT EXISTS (SELECT 1 FROM timer_operations WHERE id = ?)';
    if (command.action === 'start') {
      if (state.status !== 'idle') throw new ApiError(409, '現在のタイマーを終了してから開始してください。');
      const settings = command.mode === 'pomodoro' ? command.pomodoro : null;
      const duration = settings ? settings.focus_minutes * 60000 : null;
      statements.push(db.prepare(`UPDATE timer_state SET revision = revision + 1, timer_id = ?, project_id = ?,
        status = 'running', started_at = ?, changed_at = ?, paused_ms = 0, last_operation_id = ?, mode = ?, phase = ?,
        completed_focus = 0, focus_minutes = ?, short_break_minutes = ?, long_break_minutes = ?, long_break_every = ?, duration_ms = ?, deadline_at = ?
        WHERE ${guard} AND status = 'idle' AND EXISTS (SELECT 1 FROM projects WHERE id = ? AND archived = 0)`)
        .bind(crypto.randomUUID(), command.project_id, now, now, command.operation_id, settings ? 'pomodoro' : 'normal', settings ? 'focus' : null,
          settings?.focus_minutes ?? null, settings?.short_break_minutes ?? null, settings?.long_break_minutes ?? null, settings?.long_break_every ?? null,
          duration, duration === null ? null : now + duration, command.revision, command.operation_id, command.project_id));
    } else {
      if (state.timer_id !== command.timer_id || state.status === 'idle') throw new ApiError(409, '対象のタイマーは終了しています。');
      const active = state.status === 'running' || state.status === 'paused';
      const pausedMs = state.paused_ms + (state.status === 'paused' ? now - state.changed_at! : 0);
      if (command.action === 'finish') {
        const recordsWork = active && (state.mode === 'normal' || state.phase === 'focus');
        discarded = recordsWork && now - state.started_at! - pausedMs < 1000;
        sessionId = recordsWork && !discarded ? state.timer_id : null;
        if (sessionId) {
          statements.push(db.prepare(`INSERT INTO work_sessions (id, project_id, started_at, ended_at, paused_ms)
            SELECT timer_id, project_id, started_at, ?, ? FROM timer_state WHERE ${guard} AND timer_id = ?`)
            .bind(now, pausedMs, command.revision, command.operation_id, command.timer_id));
        }
        statements.push(db.prepare(`UPDATE timer_state SET revision = revision + 1, ${idleFields}, last_operation_id = ?
          WHERE ${guard} AND timer_id = ?`).bind(command.operation_id, command.revision, command.operation_id, command.timer_id));
      } else if (command.action === 'start_break' || command.action === 'start_focus') {
        if (state.mode !== 'pomodoro' || state.status !== 'waiting' || (command.action === 'start_focus') !== (state.phase === 'focus')) {
          throw new ApiError(409, '現在のフェーズでは開始できません。');
        }
        statements.push(db.prepare(`UPDATE timer_state SET revision = revision + 1, timer_id = ?, status = 'running',
          started_at = ?, changed_at = ?, paused_ms = 0, deadline_at = ? + duration_ms, last_operation_id = ?
          WHERE ${guard} AND timer_id = ? AND status = 'waiting'`)
          .bind(crypto.randomUUID(), now, now, now, command.operation_id, command.revision, command.operation_id, command.timer_id));
      } else if (command.action === 'skip') {
        if (state.mode !== 'pomodoro' || state.phase === 'focus') throw new ApiError(409, '休憩だけをスキップできます。');
        statements.push(db.prepare(`UPDATE timer_state SET revision = revision + 1, status = 'waiting', phase = 'focus',
          started_at = NULL, changed_at = ?, paused_ms = 0, duration_ms = focus_minutes * 60000, deadline_at = NULL, last_operation_id = ?
          WHERE ${guard} AND timer_id = ?`)
          .bind(now, command.operation_id, command.revision, command.operation_id, command.timer_id));
      } else {
        const expected = command.action === 'pause' ? 'running' : 'paused';
        if (state.status !== expected) throw new ApiError(409, '現在の状態ではこの操作はできません。');
        const deadline = state.mode === 'pomodoro' && command.action === 'resume' ? state.started_at! + pausedMs + state.duration_ms! : null;
        statements.push(db.prepare(`UPDATE timer_state SET revision = revision + 1, status = ?, changed_at = ?,
          paused_ms = ?, deadline_at = ?, last_operation_id = ? WHERE ${guard} AND timer_id = ? AND status = ?`)
          .bind(command.action === 'pause' ? 'paused' : 'running', now, pausedMs, deadline, command.operation_id,
            command.revision, command.operation_id, command.timer_id, expected));
      }
    }
    statements.push(db.prepare(`INSERT INTO timer_operations (id, payload, session_id, discarded)
      SELECT ?, ?, ?, ? FROM timer_state WHERE id = 1 AND revision = ? AND last_operation_id = ?
      AND NOT EXISTS (SELECT 1 FROM timer_operations WHERE id = ?)`)
      .bind(command.operation_id, payload, sessionId, Number(discarded), command.revision + 1, command.operation_id, command.operation_id));
    await db.batch(statements);
    const recorded = await operation(db, command.operation_id);
    if (!recorded) throw new ApiError(409, '状態が変更されたか、作業がアーカイブされています。再読み込みしてください。');
    return c.json(await operationResponse(db, command, payload, recorded));
  } catch (error) {
    if (error instanceof ApiError && error.status === 409) {
      const recorded = await operation(db, command.operation_id);
      if (recorded) return c.json(await operationResponse(db, command, payload, recorded));
    }
    throw error;
  }
});
api.get('/sessions', async (c) => {
  const { results } = await c.env.DB.prepare(`SELECT s.*, p.name AS project_name, p.color
    FROM work_sessions s JOIN projects p ON p.id = s.project_id ORDER BY s.started_at DESC, s.id DESC LIMIT 100`).all();
  return c.json({ sessions: results });
});
export default api;
