CREATE TABLE categories (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 80)
);
INSERT INTO categories (id, name) VALUES ('uncategorized', '未分類');
CREATE TRIGGER protect_uncategorized_delete BEFORE DELETE ON categories
WHEN OLD.id = 'uncategorized'
BEGIN SELECT RAISE(ABORT, 'Cannot delete uncategorized'); END;
CREATE TRIGGER protect_uncategorized_update BEFORE UPDATE ON categories
WHEN OLD.id = 'uncategorized'
BEGIN SELECT RAISE(ABORT, 'Cannot change uncategorized'); END;

CREATE TABLE projects (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 80),
  category_id TEXT NOT NULL DEFAULT 'uncategorized' REFERENCES categories(id) ON DELETE SET DEFAULT,
  color TEXT NOT NULL CHECK (length(color) = 7 AND substr(color, 1, 1) = '#' AND substr(color, 2) NOT GLOB '*[^0-9a-fA-F]*'),
  archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1))
);
CREATE INDEX projects_category ON projects(category_id);

CREATE TABLE work_sessions (
  id TEXT PRIMARY KEY NOT NULL,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  started_at INTEGER NOT NULL,
  ended_at INTEGER NOT NULL CHECK (ended_at > started_at),
  paused_ms INTEGER NOT NULL CHECK (paused_ms >= 0 AND paused_ms < ended_at - started_at),
  active_seconds INTEGER GENERATED ALWAYS AS (CAST((ended_at - started_at - paused_ms) / 1000 AS INTEGER)) STORED CHECK (active_seconds > 0)
);
CREATE INDEX sessions_started ON work_sessions(started_at);
CREATE INDEX sessions_project ON work_sessions(project_id);

-- 行を削除せず revision を単調増加させ、終了後の古い操作も検出する。
CREATE TABLE timer_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  timer_id TEXT,
  project_id TEXT REFERENCES projects(id) ON DELETE RESTRICT,
  status TEXT NOT NULL DEFAULT 'idle' CHECK (status IN ('idle', 'running', 'paused')),
  started_at INTEGER,
  changed_at INTEGER,
  paused_ms INTEGER NOT NULL DEFAULT 0 CHECK (paused_ms >= 0),
  last_operation_id TEXT,
  CHECK (
    (status = 'idle' AND timer_id IS NULL AND project_id IS NULL AND started_at IS NULL AND changed_at IS NULL AND paused_ms = 0)
    OR
    (status IN ('running', 'paused') AND timer_id IS NOT NULL AND project_id IS NOT NULL AND started_at IS NOT NULL AND changed_at IS NOT NULL AND changed_at >= started_at AND paused_ms <= changed_at - started_at)
  )
);
INSERT INTO timer_state (id) VALUES (1);
CREATE TRIGGER protect_timer_delete BEFORE DELETE ON timer_state
BEGIN SELECT RAISE(ABORT, 'Cannot delete singleton timer'); END;

-- 操作結果を保存し、通信失敗後の同じ操作の再送を安全に扱う。
CREATE TABLE timer_operations (
  id TEXT PRIMARY KEY NOT NULL,
  payload TEXT NOT NULL,
  session_id TEXT,
  discarded INTEGER NOT NULL CHECK (discarded IN (0, 1))
);

UPDATE app_metadata SET version = 2 WHERE id = 1;
