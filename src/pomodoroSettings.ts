import type { PomodoroSettings } from '../shared/contracts';
import { defaultPomodoro, validPomodoro } from '../shared/pomodoro';
export const pomodoroKey = (projectId: string) => `my-working-logger.pomodoro.${projectId}`;
export function loadPomodoro(projectId: string): PomodoroSettings {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(pomodoroKey(projectId)) ?? 'null');
    if (validPomodoro(value)) return {
      focus_minutes: value.focus_minutes, short_break_minutes: value.short_break_minutes,
      long_break_minutes: value.long_break_minutes, long_break_every: value.long_break_every,
    };
  } catch { /* 未保存・破損・Storage 無効時は初期値。 */ }
  return { ...defaultPomodoro };
}
export function savePomodoro(projectId: string, value: PomodoroSettings): boolean {
  if (!validPomodoro(value)) return false;
  try { localStorage.setItem(pomodoroKey(projectId), JSON.stringify(value)); return true; }
  catch { return false; }
}
