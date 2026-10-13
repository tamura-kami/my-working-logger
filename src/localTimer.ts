import { z } from 'zod';
import type { PomodoroSettings, Project, SessionInput, TimerState } from '../shared/contracts';
import { durations } from '../shared/timing';
import { validPomodoro } from '../shared/pomodoro';
import { operationId } from './api';
export const timerStorageKey = 'my-working-logger.timer.v1';
export interface LocalTimer { version: 1; timer: TimerState | null; pending: SessionInput[] }
const number = z.number().int().nonnegative().max(8640000000000000);
const settings = z.custom<PomodoroSettings>(validPomodoro);
const sessionSchema = z.object({ id: z.uuid(), project_id: z.uuid(), started_at: number, ended_at: number, paused_ms: number })
  .refine((s) => s.ended_at - s.started_at - s.paused_ms >= 1000);
const timerSchema = z.object({
  timer_id: z.uuid(), project_id: z.uuid(), project_name: z.string(), color: z.string(),
  status: z.enum(['running', 'paused', 'expired']), mode: z.enum(['normal', 'pomodoro']),
  phase: z.enum(['focus', 'short_break', 'long_break']).nullable(), completed_focus: number,
  started_at: number, changed_at: number, paused_ms: number,
  duration_ms: number.nullable(), deadline_at: number.nullable(), pomodoro: settings.nullable(),
  cycle_id: z.uuid().nullable(), cycle_started_at: number.nullable(), cycle_active_ms: number,
}).refine((t) => t.changed_at >= t.started_at && t.paused_ms <= t.changed_at - t.started_at)
  .refine((t) => t.mode === 'normal' ? t.phase === null && t.pomodoro === null && t.status !== 'expired'
    : t.pomodoro !== null && t.phase !== null && t.duration_ms !== null && t.duration_ms > 0
      && t.completed_focus <= t.pomodoro.long_break_every
      && (t.status !== 'running' || t.deadline_at === t.started_at + t.paused_ms + t.duration_ms))
  .refine((t) => (t.cycle_id === null) === (t.cycle_started_at === null));
const schema = z.object({ version: z.literal(1), timer: timerSchema.nullable(), pending: z.array(sessionSchema) });
export const emptyLocalTimer = (): LocalTimer => ({ version: 1, timer: null, pending: [] });
export function readLocalTimer(): LocalTimer {
  const raw = localStorage.getItem(timerStorageKey);
  if (!raw) return emptyLocalTimer();
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new Error('保存されたタイマー情報を読み込めません。既存の保存内容は保護しています。'); }
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new Error('保存されたタイマー情報が破損しているか、未対応の形式です。保存内容を保護するため操作を停止しています。');
  return parsed.data;
}
export function writeLocalTimer(value: LocalTimer) {
  // 状態更新と実績の追加を1回の書込みで確定し、リロードで記録を失わない。
  if (!value.timer && !value.pending.length) localStorage.removeItem(timerStorageKey);
  else localStorage.setItem(timerStorageKey, JSON.stringify(value));
}
export function startLocalTimer(value: LocalTimer, project: Project, mode: 'normal' | 'pomodoro', config: PomodoroSettings, now: number): LocalTimer {
  const id = operationId();
  const duration = mode === 'pomodoro' ? config.focus_minutes * 60000 : null;
  return { ...value, timer: { timer_id: id, project_id: project.id, project_name: project.name, color: project.color,
    mode, phase: duration === null ? null : 'focus', status: 'running', completed_focus: 0,
    pomodoro: duration === null ? null : { ...config }, duration_ms: duration, deadline_at: duration === null ? null : now + duration,
    started_at: now, changed_at: now, paused_ms: 0,
    cycle_id: duration === null ? null : id, cycle_started_at: duration === null ? null : now, cycle_active_ms: 0 } };
}
function queue(value: LocalTimer, id: string, start: number, end: number, active: number): LocalTimer {
  if (active < 1000 || value.pending.some((s) => s.id === id)) return value;
  const record: SessionInput = { id, project_id: value.timer!.project_id!, started_at: start, ended_at: end, paused_ms: Math.max(0, end - start - active) };
  return { ...value, pending: [...value.pending, record] };
}
function nextPhase(timer: TimerState): NonNullable<TimerState['phase']> {
  return timer.phase === 'focus' ? timer.completed_focus === timer.pomodoro!.long_break_every ? 'long_break' : 'short_break' : 'focus';
}
export function beginNext(value: LocalTimer, now: number): LocalTimer {
  const t = value.timer!;
  const phase = nextPhase(t);
  const config = t.pomodoro!;
  now = Math.max(now, t.changed_at!);
  const duration = (phase === 'focus' ? config.focus_minutes : phase === 'short_break' ? config.short_break_minutes : config.long_break_minutes) * 60000;
  const newCycle = phase === 'focus' && t.cycle_id === null;
  return { ...value, timer: { ...t, timer_id: operationId(), phase, status: 'running', started_at: now, changed_at: now,
    duration_ms: duration, deadline_at: now + duration, paused_ms: 0,
    completed_focus: newCycle ? 0 : t.completed_focus,
    cycle_id: newCycle ? operationId() : t.cycle_id,
    cycle_started_at: newCycle ? now : t.cycle_started_at, cycle_active_ms: newCycle ? 0 : t.cycle_active_ms } };
}
export function expireLocalTimer(value: LocalTimer, now: number, automatic: boolean): LocalTimer {
  const t = value.timer;
  if (!t || t.mode !== 'pomodoro' || t.status !== 'running' || t.deadline_at === null || now < t.deadline_at) return value;
  const active = (t.cycle_active_ms ?? 0) + (t.phase === 'focus' ? t.duration_ms! : 0);
  const count = t.completed_focus + (t.phase === 'focus' ? 1 : 0);
  if (t.phase === 'focus' && count === t.pomodoro!.long_break_every && t.cycle_id) {
    value = queue(value, t.cycle_id, t.cycle_started_at!, t.deadline_at, active);
    value = { ...value, timer: { ...t, cycle_id: null, cycle_started_at: null, cycle_active_ms: 0 } };
  } else value = { ...value, timer: { ...t, cycle_active_ms: active } };
  value = { ...value, timer: { ...value.timer!, status: 'expired', changed_at: t.deadline_at, completed_focus: count } };
  return automatic ? beginNext(value, now) : value;
}
export function pauseLocalTimer(value: LocalTimer, now: number): LocalTimer {
  const t = value.timer!;
  now = Math.max(now, t.changed_at!);
  return { ...value, timer: { ...t, status: 'paused', changed_at: now, deadline_at: null } };
}
export function resumeLocalTimer(value: LocalTimer, now: number): LocalTimer {
  const t = value.timer!;
  now = Math.max(now, t.changed_at!);
  const paused = t.paused_ms + now - t.changed_at!;
  return { ...value, timer: { ...t, status: 'running', changed_at: now, paused_ms: paused,
    deadline_at: t.duration_ms === null ? null : t.started_at! + paused + t.duration_ms } };
}
export function finishLocalTimer(value: LocalTimer, now: number): LocalTimer {
  const t = value.timer!;
  now = Math.max(now, t.changed_at!);
  if (t.mode === 'normal') value = queue(value, t.timer_id!, t.started_at!, now, durations(t, now).active);
  else if (t.cycle_id) {
    const focus = t.phase === 'focus' && t.status !== 'expired' ? Math.min(t.duration_ms!, durations(t, now).active) : 0;
    value = queue(value, t.cycle_id, t.cycle_started_at!, now, (t.cycle_active_ms ?? 0) + focus);
  }
  return { ...value, timer: null };
}
