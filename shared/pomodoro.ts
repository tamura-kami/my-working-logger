import type { PomodoroSettings } from './contracts';
export const defaultPomodoro: PomodoroSettings = {
  focus_minutes: 25, short_break_minutes: 5, long_break_minutes: 15, long_break_every: 4,
};
export function validPomodoro(value: unknown): value is PomodoroSettings {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return ['focus_minutes', 'short_break_minutes', 'long_break_minutes', 'long_break_every'].every((key) => {
    const n = v[key];
    return typeof n === 'number' && Number.isInteger(n) && n >= 1 && n <= (key === 'long_break_every' ? 20 : 180);
  });
}
