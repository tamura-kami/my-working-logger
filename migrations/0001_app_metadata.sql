-- 基盤の疎通確認用。業務テーブルは後続 issue でスキーマを確定する。
CREATE TABLE app_metadata (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  version INTEGER NOT NULL CHECK (version > 0)
);
INSERT INTO app_metadata (id, version) VALUES (1, 1);
