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

const change = (id: string, value?: unknown) => app.request(`/api/sessions/${id}`, {
  method: value === undefined ? 'DELETE' : 'PATCH', headers: { 'Content-Type': 'application/json' },
  ...(value === undefined ? {} : { body: JSON.stringify(value) }),
}, env);
it('編集で実作業を再計算し、重複も許可、削除後は再送しても復活しない', async () => {
  const record = input(); await post(record);
  const edit = { started_at: record.started_at, ended_at: 130000, paused_ms: 5000 };
  expect((await change(record.id, edit)).status).toBe(200);
  expect(await env.DB.prepare('SELECT active_seconds FROM work_sessions WHERE id = ?').bind(record.id).first()).toEqual({ active_seconds: 25 });
  for (const value of [{ ...edit, ended_at: edit.started_at }, { ...edit, paused_ms: -1 }, { ...edit, paused_ms: 30000 }, { ...edit, paused_ms: 29001 }]) {
    expect((await change(record.id, value)).status).toBe(400);
  }
  await post(record);
  expect(await env.DB.prepare('SELECT active_seconds FROM work_sessions WHERE id = ?').bind(record.id).first()).toEqual({ active_seconds: 25 });
  expect((await change(record.id)).status).toBe(200);
  await post(record);
  expect(await env.DB.prepare('SELECT id FROM work_sessions WHERE id = ?').bind(record.id).first()).toBeNull();
  expect((await change(record.id, edit)).status).toBe(404);
  expect((await change(record.id)).status).toBe(404);
});
it('日本時間の当日と交差する全件を取得し、日跨ぎと100件超を保持する', async () => {
  const start = Date.parse('2026-10-16T00:00:00+09:00');
  const records = Array.from({ length: 102 }, (_, i) => ({ ...input(), started_at: start + i * 1000, ended_at: start + i * 1000 + 10000 }));
  records.push({ ...input(), started_at: start + 86399000, ended_at: start + 90000000 });
  records.push({ ...input(), started_at: start - 1000, ended_at: start + 10000 });
  for (const record of records) await post(record);
  const response = await app.request('/api/sessions?date=2026-10-16', {}, env);
  const data = await response.json() as { sessions: { id: string }[] };
  expect(data.sessions).toHaveLength(104);
  expect(data.sessions.map((s) => s.id)).toContain(records[102].id);
  expect(data.sessions.map((s) => s.id)).toContain(records[103].id);
  const next = await app.request('/api/sessions?date=2026-10-17', {}, env);
  expect(((await next.json()) as { sessions: { id: string }[] }).sessions.map((s) => s.id)).toEqual([records[102].id]);
  const boundary = { ...input(), started_at: start - 10000, ended_at: start, paused_ms: 0 };
  await post(boundary);
  const again = await app.request('/api/sessions?date=2026-10-16', {}, env);
  expect(((await again.json()) as { sessions: { id: string }[] }).sessions.map((s) => s.id)).not.toContain(boundary.id);
  const overlap = await app.request(`/api/sessions?overlap_start=${start}&overlap_end=${start + 1000}`, {}, env);
  expect(((await overlap.json()) as { sessions: { id: string }[] }).sessions.map((s) => s.id)).toContain(records[103].id);
  for (const query of ['date=2026-02-30', 'date=bad', 'overlap_start=2&overlap_end=1']) expect((await app.request(`/api/sessions?${query}`, {}, env)).status).toBe(400);
});
