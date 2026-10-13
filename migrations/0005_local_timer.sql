-- 進行中タイマーは以降ブラウザが管理する。確定済み実績は保持する。
DROP TRIGGER protect_timer_delete;
DROP TABLE timer_state;
DROP TABLE timer_operations;
-- 実績が後で編集・削除されても、同じ確定実績の再送を識別する。
CREATE TABLE session_receipts (
  id TEXT PRIMARY KEY NOT NULL,
  payload TEXT NOT NULL
);
UPDATE app_metadata SET version = 5 WHERE id = 1;
