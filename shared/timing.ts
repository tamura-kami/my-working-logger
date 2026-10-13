import type { TimerState } from './contracts';
export function durations(timer: TimerState, now: number) {
  if (timer.status === 'idle' || timer.status === 'waiting' || timer.started_at === null || timer.changed_at === null) {
    return { active: 0, paused: 0, elapsed: 0 };
  }
  const safeNow = Math.max(now, timer.changed_at);
  const elapsed = safeNow - timer.started_at;
  const paused = timer.paused_ms + (timer.status === 'paused' ? safeNow - timer.changed_at : 0);
  return { active: Math.max(0, elapsed - paused), paused, elapsed };
}
export function formatDuration(milliseconds: number) {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  const hours = Math.floor(seconds / 3600).toString().padStart(2, '0');
  const minutes = Math.floor(seconds / 60 % 60).toString().padStart(2, '0');
  return `${hours}:${minutes}:${(seconds % 60).toString().padStart(2, '0')}`;
}

export function remainingTime(timer: TimerState, now: number) {
  if (timer.mode !== 'pomodoro' || timer.duration_ms === null) return null;
  if (timer.status === 'waiting') return timer.duration_ms;
  return Math.max(0, timer.duration_ms - durations(timer, now).active);
}

export function cycleDurations(timer: TimerState, now: number) {
  if (timer.mode !== 'pomodoro') return durations(timer, now);
  if (timer.cycle_started_at == null) return { active: 0, paused: 0, elapsed: 0 };
  const elapsed = Math.max(0, now - timer.cycle_started_at);
  const focus = timer.phase === 'focus' ? Math.min(timer.duration_ms ?? 0, durations(timer, now).active) : 0;
  const active = (timer.cycle_active_ms ?? 0) + focus;
  return { active, paused: Math.max(0, elapsed - active), elapsed };
}
