export interface Category { id: string; name: string }
export interface Project { id: string; name: string; category_id: string; color: string; archived: boolean }
export interface PomodoroSettings {
  focus_minutes: number;
  short_break_minutes: number;
  long_break_minutes: number;
  long_break_every: number;
}
export interface TimerState {
  cycle_id?: string | null;
  cycle_started_at?: number | null;
  cycle_active_ms?: number;
  mode: 'normal' | 'pomodoro';
  phase: 'focus' | 'short_break' | 'long_break' | null;
  completed_focus: number;
  pomodoro: PomodoroSettings | null;
  duration_ms: number | null;
  deadline_at: number | null;
  timer_id: string | null;
  project_id: string | null;
  project_name: string | null;
  color: string | null;
  status: 'idle' | 'running' | 'paused' | 'expired';
  started_at: number | null;
  changed_at: number | null;
  paused_ms: number;
}
export interface SessionInput {
  id: string; project_id: string; started_at: number; ended_at: number; paused_ms: number;
}
export interface WorkSession {
  id: string; project_id: string; project_name: string; color: string;
  started_at: number; ended_at: number; paused_ms: number; active_seconds: number;
}
