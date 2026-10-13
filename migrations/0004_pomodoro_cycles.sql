-- フェーズの時計とは別に、長休憩までの実績を保持する。
ALTER TABLE timer_state ADD COLUMN cycle_id TEXT;
ALTER TABLE timer_state ADD COLUMN cycle_started_at INTEGER;
ALTER TABLE timer_state ADD COLUMN cycle_active_ms INTEGER NOT NULL DEFAULT 0 CHECK (cycle_active_ms >= 0);
-- 旧版の休憩以前の集中は既に保存済みなので取り込まない。
UPDATE timer_state SET cycle_id = timer_id, cycle_started_at = started_at
WHERE mode = 'pomodoro' AND phase = 'focus' AND status IN ('running', 'paused');
UPDATE app_metadata SET version = 4 WHERE id = 1;
