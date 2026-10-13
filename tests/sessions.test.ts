import { afterAll, beforeAll, expect, it } from 'vitest';
import app from '../worker/index';
import type { Bindings } from '../worker/env';
import { bindings, databaseRuntime, migrate } from './database';
const runtime = databaseRuntime(); let env: Bindings; let project: string;
beforeAll(async () => {
  env = await bindings(runtime); await migrate(env.DB); project = crypto.randomUUID();
  await env.DB.prepare("INSERT INTO projects (id, name, color) VALUES (?, '作業', '#123456')").bind(project).run();
});
afterAll(async () => runtime.dispose());
const input = () => ({ id: crypto.randomUUID(), project_id: project, started_at: 100000, ended_at: 110000, paused_ms: 3000 });
const post = (value: unknown) => app.request('/api/sessions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) }, env);
it('再送・同時再送で実績を二重登録しない', async () => {
  const record = input();
  expect((await Promise.all([post(record), post(record)])).map((r) => r.status)).toEqual([200, 200]);
  expect((await post(record)).status).toBe(200);
  expect(await env.DB.prepare('SELECT active_seconds FROM work_sessions WHERE id = ?').bind(record.id).first()).toEqual({ active_seconds: 7 });
  expect((await post({ ...record, ended_at: 120000 })).status).toBe(409);
});
it('編集・削除後も元実績の再送で上書きや復活しない', async () => {
  const record = input(); await post(record);
  await env.DB.prepare('UPDATE work_sessions SET ended_at = 120000 WHERE id = ?').bind(record.id).run();
  await post(record);
  expect(await env.DB.prepare('SELECT ended_at FROM work_sessions WHERE id = ?').bind(record.id).first()).toEqual({ ended_at: 120000 });
  await env.DB.prepare('DELETE FROM work_sessions WHERE id = ?').bind(record.id).run();
  await post(record);
  expect(await env.DB.prepare('SELECT id FROM work_sessions WHERE id = ?').bind(record.id).first()).toBeNull();
});
it('アーカイブ後も確定実績を保存できる', async () => {
  await env.DB.prepare('UPDATE projects SET archived = 1 WHERE id = ?').bind(project).run();
  expect((await post(input())).status).toBe(200);
});
it('不正時刻、0秒実績、未知の作業を拒否', async () => {
  for (const record of [{ ...input(), ended_at: 100000 }, { ...input(), paused_ms: 10000 }, { ...input(), started_at: -1 }, { ...input(), ended_at: 100999, paused_ms: 0 }]) expect((await post(record)).status).toBe(400);
  expect((await post({ ...input(), project_id: crypto.randomUUID() })).status).toBe(404);
});
it('旧状態APIは撤去され、他APIでタイマー更新も起きない', async () => {
  expect((await app.request('/api/timer', {}, env)).status).toBe(404);
});
it('DBバッチ失敗時は実績・受領記録を両方ロールバックして再送できる', async () => {
  const record = input();
  await env.DB.prepare("CREATE TRIGGER fail_receipt BEFORE INSERT ON session_receipts BEGIN SELECT RAISE(ABORT, 'failure'); END;").run();
  try {
    expect((await post(record)).status).toBe(500);
    expect(await env.DB.prepare('SELECT id FROM work_sessions WHERE id = ?').bind(record.id).first()).toBeNull();
    expect(await env.DB.prepare('SELECT id FROM session_receipts WHERE id = ?').bind(record.id).first()).toBeNull();
  } finally { await env.DB.prepare('DROP TRIGGER fail_receipt').run(); }
  expect((await post(record)).status).toBe(200);
});
