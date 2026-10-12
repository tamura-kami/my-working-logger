export interface Category { id: string; name: string }
export interface Project { id: string; name: string; category_id: string; color: string; archived: boolean }
export interface TimerState {
  revision: number;
  timer_id: string | null;
  project_id: string | null;
  project_name: string | null;
  color: string | null;
  status: 'idle' | 'running' | 'paused';
  started_at: number | null;
  changed_at: number | null;
  paused_ms: number;
}
export interface TimerSnapshot { timer: TimerState; server_now: number }
export type TimerCommand = { operation_id: string; revision: number } & (
  { action: 'start'; project_id: string } |
  { action: 'pause' | 'resume' | 'finish'; timer_id: string }
);
export interface TimerResult extends TimerSnapshot {
  outcome: { action: TimerCommand['action']; session_id: string | null; discarded: boolean };
}
export interface WorkSession {
  id: string; project_id: string; project_name: string; color: string;
  started_at: number; ended_at: number; paused_ms: number; active_seconds: number;
}
