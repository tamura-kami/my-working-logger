import { Hono } from 'hono';
import { z } from 'zod';
import type { TimerCommand, TimerSnapshot, TimerState } from '../shared/contracts';
import type { Bindings } from './env';
import { ApiError, body } from './http';

const api = new Hono<{ Bindings: Bindings }>();
const common = { operation_id: z.uuid(), revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER) };
const commandSchema = z.discriminatedUnion('action', [
  z.strictObject({ ...common, action: z.literal('start'), project_id: z.uuid() }),
  ...(['pause', 'resume', 'finish'] as const).map((action) => z.strictObject({ ...common, action: z.literal(action), timer_id: z.uuid() })),
]);
interface Operation { payload: string; session_id: string | null; discarded: number }
export async function snapshot(db: D1Database): Promise<TimerSnapshot> {
  const timer = await db.prepare(`SELECT t.revision, t.timer_id, t.project_id, t.status, t.started_at,
    t.changed_at, t.paused_ms, p.name AS project_name, p.color
    FROM timer_state t LEFT JOIN projects p ON p.id = t.project_id WHERE t.id = 1`).first<TimerState>();
  if (!timer) throw new Error('Timer migration missing');
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
    if (state.revision !== command.revision) throw new ApiError(409, '別の端末で状態が変更されました。最新の状態を確認してください。');
    const statements: D1PreparedStatement[] = [];
    let sessionId: string | null = null;
    let discarded = false;
    // 全 SQL が同じ revision と未実行の operation_id を検証する。
    const guard = 'id = 1 AND revision = ? AND NOT EXISTS (SELECT 1 FROM timer_operations WHERE id = ?)';
    if (command.action === 'start') {
      if (state.status !== 'idle') throw new ApiError(409, '現在のタイマーを終了してから開始してください。');
      statements.push(db.prepare(`UPDATE timer_state SET revision = revision + 1, timer_id = ?, project_id = ?,
        status = 'running', started_at = ?, changed_at = ?, paused_ms = 0, last_operation_id = ?
        WHERE ${guard} AND status = 'idle' AND EXISTS (SELECT 1 FROM projects WHERE id = ? AND archived = 0)`)
        .bind(crypto.randomUUID(), command.project_id, now, now, command.operation_id, command.revision, command.operation_id, command.project_id));
    } else {
      if (state.timer_id !== command.timer_id || state.status === 'idle') throw new ApiError(409, '対象のタイマーは終了しています。');
      const pausedMs = state.paused_ms + (state.status === 'paused' ? now - state.changed_at! : 0);
      if (command.action === 'finish') {
        discarded = now - state.started_at! - pausedMs < 1000;
        sessionId = discarded ? null : state.timer_id;
        if (!discarded) {
          statements.push(db.prepare(`INSERT INTO work_sessions (id, project_id, started_at, ended_at, paused_ms)
            SELECT timer_id, project_id, started_at, ?, ? FROM timer_state
            WHERE ${guard} AND timer_id = ? AND status IN ('running', 'paused')`)
            .bind(now, pausedMs, command.revision, command.operation_id, command.timer_id));
        }
        statements.push(db.prepare(`UPDATE timer_state SET revision = revision + 1, timer_id = NULL,
          project_id = NULL, status = 'idle', started_at = NULL, changed_at = NULL, paused_ms = 0, last_operation_id = ?
          WHERE ${guard} AND timer_id = ? AND status IN ('running', 'paused')`)
          .bind(command.operation_id, command.revision, command.operation_id, command.timer_id));
      } else {
        const expected = command.action === 'pause' ? 'running' : 'paused';
        if (state.status !== expected) throw new ApiError(409, '現在の状態ではこの操作はできません。');
        statements.push(db.prepare(`UPDATE timer_state SET revision = revision + 1, status = ?, changed_at = ?,
          paused_ms = ?, last_operation_id = ? WHERE ${guard} AND timer_id = ? AND status = ?`)
          .bind(command.action === 'pause' ? 'paused' : 'running', now, pausedMs, command.operation_id,
            command.revision, command.operation_id, command.timer_id, expected));
      }
    }
    statements.push(db.prepare(`INSERT INTO timer_operations (id, payload, session_id, discarded)
      SELECT ?, ?, ?, ? FROM timer_state WHERE id = 1 AND revision = ? AND last_operation_id = ?
      AND NOT EXISTS (SELECT 1 FROM timer_operations WHERE id = ?)`)
      .bind(command.operation_id, payload, sessionId, Number(discarded), command.revision + 1, command.operation_id, command.operation_id));
    // D1 batch はトランザクション。実績 INSERT、状態更新、冪等結果をまとめて確定。
    await db.batch(statements);
    const recorded = await operation(db, command.operation_id);
    if (!recorded) throw new ApiError(409, '状態が変更されたか、作業がアーカイブされています。再読み込みしてください。');
    return c.json(await operationResponse(db, command, payload, recorded));
  } catch (error) {
    // 最初の読取後に同じ ID の操作が確定した場合も、元の結果を返す。
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
