-- 既存の通常タイマー、revision、再送 ID を保持して状態の種類を拡張する。
CREATE TABLE timer_state_next (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  timer_id TEXT,
  project_id TEXT REFERENCES projects(id) ON DELETE RESTRICT,
  status TEXT NOT NULL DEFAULT 'idle' CHECK (status IN ('idle', 'running', 'paused', 'waiting')),
  started_at INTEGER,
  changed_at INTEGER,
  paused_ms INTEGER NOT NULL DEFAULT 0 CHECK (paused_ms >= 0),
  last_operation_id TEXT,
  mode TEXT NOT NULL DEFAULT 'normal' CHECK (mode IN ('normal', 'pomodoro')),
  phase TEXT CHECK (phase IN ('focus', 'short_break', 'long_break')),
  completed_focus INTEGER NOT NULL DEFAULT 0 CHECK (completed_focus >= 0),
  focus_minutes INTEGER,
  short_break_minutes INTEGER,
  long_break_minutes INTEGER,
  long_break_every INTEGER,
  duration_ms INTEGER,
  deadline_at INTEGER,
  CHECK (
    (status = 'idle' AND timer_id IS NULL AND project_id IS NULL AND started_at IS NULL AND changed_at IS NULL AND paused_ms = 0)
    OR
    (status IN ('running', 'paused') AND timer_id IS NOT NULL AND project_id IS NOT NULL AND started_at IS NOT NULL AND changed_at IS NOT NULL AND changed_at >= started_at AND paused_ms <= changed_at - started_at)
    OR
    (status = 'waiting' AND mode = 'pomodoro' AND timer_id IS NOT NULL AND project_id IS NOT NULL AND started_at IS NULL AND changed_at IS NOT NULL AND paused_ms = 0)
  ),
  CHECK (
    (mode = 'normal' AND phase IS NULL AND completed_focus = 0 AND focus_minutes IS NULL AND short_break_minutes IS NULL AND long_break_minutes IS NULL AND long_break_every IS NULL AND duration_ms IS NULL AND deadline_at IS NULL)
    OR
    (mode = 'pomodoro' AND status != 'idle' AND phase IS NOT NULL
      AND focus_minutes IS NOT NULL AND focus_minutes BETWEEN 1 AND 180
      AND short_break_minutes IS NOT NULL AND short_break_minutes BETWEEN 1 AND 180
      AND long_break_minutes IS NOT NULL AND long_break_minutes BETWEEN 1 AND 180
      AND long_break_every IS NOT NULL AND long_break_every BETWEEN 1 AND 20
      AND duration_ms IS NOT NULL AND duration_ms = CASE phase WHEN 'focus' THEN focus_minutes * 60000 WHEN 'short_break' THEN short_break_minutes * 60000 ELSE long_break_minutes * 60000 END
      AND ((status = 'running' AND deadline_at IS NOT NULL AND deadline_at = started_at + paused_ms + duration_ms) OR (status IN ('paused', 'waiting') AND deadline_at IS NULL)))
  )
);
INSERT INTO timer_state_next (id, revision, timer_id, project_id, status, started_at, changed_at, paused_ms, last_operation_id)
SELECT id, revision, timer_id, project_id, status, started_at, changed_at, paused_ms, last_operation_id FROM timer_state;
DROP TRIGGER protect_timer_delete;
DROP TABLE timer_state;
ALTER TABLE timer_state_next RENAME TO timer_state;
CREATE TRIGGER protect_timer_delete BEFORE DELETE ON timer_state
BEGIN SELECT RAISE(ABORT, 'Cannot delete singleton timer'); END;
UPDATE app_metadata SET version = 3 WHERE id = 1;
