import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import app from '../worker/index';
import type { Bindings } from '../worker/env';
import type { TimerCommand, TimerResult, TimerSnapshot } from '../shared/contracts';
import { bindings, databaseRuntime, migrate } from './database';

const runtime = databaseRuntime();
let env: Bindings;
let now = 1800000000000;
beforeAll(async () => { env = await bindings(runtime); await migrate(env.DB); });
afterAll(async () => { await runtime.dispose(); });
beforeEach(async () => {
  now = 1800000000000;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  await env.DB.batch([
    env.DB.prepare('DELETE FROM timer_operations'),
    env.DB.prepare('DELETE FROM work_sessions'),
    env.DB.prepare("UPDATE timer_state SET revision = 0, timer_id = NULL, project_id = NULL, status = 'idle', started_at = NULL, changed_at = NULL, paused_ms = 0, last_operation_id = NULL"),
    env.DB.prepare('DELETE FROM projects'),
    env.DB.prepare("DELETE FROM categories WHERE id != 'uncategorized'"),
  ]);
});
afterEach(() => vi.restoreAllMocks());
async function request(path: string, method = 'GET', input?: unknown, headers?: Record<string, string>) {
  return app.request(`/api${path}`, { method, headers: { ...(input ? { 'Content-Type': 'application/json' } : {}), ...headers }, ...(input ? { body: JSON.stringify(input) } : {}) }, env);
}
async function category(name = '開発') {
  const response = await request('/categories', 'POST', { name });
  expect(response.status).toBe(201);
  return (await response.json() as { category: { id: string } }).category.id;
}
async function project(categoryId = 'uncategorized') {
  const response = await request('/projects', 'POST', { name: '実装', color: '#175c50', category_id: categoryId });
  expect(response.status).toBe(201);
  return (await response.json() as { project: { id: string } }).project.id;
}
async function state() { return await (await request('/timer')).json() as TimerSnapshot; }
async function command(action: TimerCommand['action'], extra: string, previous?: TimerSnapshot): Promise<TimerCommand> {
  const snapshot = previous ?? await state();
  const base = { action, operation_id: crypto.randomUUID(), revision: snapshot.timer.revision };
  return action === 'start' ? { ...base, action, project_id: extra } : { ...base, action, timer_id: extra };
}
async function execute(input: TimerCommand) {
  const response = await request('/timer', 'POST', input);
  expect(response.status, await response.clone().text()).toBe(200);
  return await response.json() as TimerResult;
}
async function start(id: string) { return execute(await command('start', id)); }
async function sessions() { return (await (await request('/sessions')).json() as { sessions: Record<string, unknown>[] }).sessions; }

describe('カテゴリ・作業と参照整合性', () => {
  it('カテゴリ・作業の作成、改名、色・所属変更、アーカイブ解除', async () => {
    const cat = await category(); const next = await category('調査'); const id = await project(cat);
    expect((await request(`/categories/${cat}`, 'PATCH', { name: '設計' })).status).toBe(200);
    expect((await request(`/projects/${id}`, 'PATCH', { name: 'API', color: '#ab12EF', category_id: next, archived: true })).status).toBe(200);
    const all = await (await request('/projects?scope=all')).json() as { projects: Record<string, unknown>[] };
    expect(all.projects[0]).toMatchObject({ name: 'API', color: '#ab12EF', category_id: next, archived: true });
    expect(await (await request('/projects')).json()).toEqual({ projects: [] });
    await request(`/projects/${id}`, 'PATCH', { archived: false });
    const active = await (await request('/projects')).json() as { projects: unknown[] };
    expect(active.projects).toHaveLength(1);
  });
  it('標準カテゴリを API と DB の両方で保護する', async () => {
    expect((await request('/categories/uncategorized', 'DELETE')).status).toBe(409);
    expect((await request('/categories/uncategorized', 'PATCH', { name: '変更' })).status).toBe(409);
    await expect(env.DB.prepare("DELETE FROM categories WHERE id = 'uncategorized'").run()).rejects.toThrow();
    await expect(env.DB.prepare("UPDATE categories SET name = '変更' WHERE id = 'uncategorized'").run()).rejects.toThrow();
  });
  it('カテゴリ削除後も作業・実績・アーカイブ状態を保持する', async () => {
    const cat = await category(); const id = await project(cat); const timer = await start(id);
    now += 5000; await execute(await command('finish', timer.timer.timer_id!));
    await request(`/projects/${id}`, 'PATCH', { archived: true });
    expect((await request(`/categories/${cat}`, 'DELETE')).status).toBe(200);
    const row = await env.DB.prepare('SELECT * FROM projects WHERE id = ?').bind(id).first();
    expect(row).toMatchObject({ category_id: 'uncategorized', archived: 1 });
    expect(await sessions()).toHaveLength(1);
    await expect(env.DB.prepare('DELETE FROM projects WHERE id = ?').bind(id).run()).rejects.toThrow();
  });
  it('無効な入力と孤立参照を拒否する', async () => {
    expect((await request('/categories', 'POST', { name: '  ' })).status).toBe(400);
    expect((await request('/projects', 'POST', { name: '作業', category_id: crypto.randomUUID(), color: '#123456' })).status).toBe(400);
    expect((await request('/projects', 'POST', { name: '作業', category_id: 'uncategorized', color: 'red' })).status).toBe(400);
    expect((await request('/projects', 'POST', { name: '作業', category_id: 'uncategorized', color: '#123456', memo: '不要' })).status).toBe(400);
    const id = await project();
    await expect(env.DB.prepare('UPDATE projects SET category_id = ? WHERE id = ?').bind('missing', id).run()).rejects.toThrow();
    await expect(env.DB.prepare('UPDATE projects SET category_id = NULL WHERE id = ?').bind(id).run()).rejects.toThrow();
    await expect(env.DB.prepare("UPDATE projects SET color = '#zzzzzz' WHERE id = ?").bind(id).run()).rejects.toThrow();
    expect((await request(`/projects/${id}`, 'PATCH', {})).status).toBe(400);
  });
  it('アーカイブ済みの作業では新規開始できず、進行中は終了できる', async () => {
    const id = await project(); const timer = await start(id);
    await request(`/projects/${id}`, 'PATCH', { archived: true });
    now += 2000; await execute(await command('finish', timer.timer.timer_id!));
    expect((await request('/timer', 'POST', await command('start', id))).status).toBe(409);
    expect(await sessions()).toHaveLength(1);
  });
  it('同一オリジンの JSON 操作だけを受け付ける', async () => {
    expect((await request('/categories', 'POST', { name: '外部' }, { Origin: 'https://evil.example' })).status).toBe(403);
    expect((await request('/categories', 'POST', { name: '外部' }, { 'Sec-Fetch-Site': 'cross-site' })).status).toBe(403);
    const invalid = await app.request('/api/categories', { method: 'POST', body: '{', headers: { 'Content-Type': 'application/json' } }, env);
    expect(invalid.status).toBe(400);
    expect((await request('/categories', 'POST', { name: 'テスト' }, { 'Content-Type': 'text/plain' })).status).toBe(400);
  });
});

describe('通常タイマー・原子的な実績確定', () => {
  it('サーバー時刻で開始→一時停止→再開→終了し、時間を確定する', async () => {
    const id = await project(); const started = await start(id); const timerId = started.timer.timer_id!;
    now += 10500; const paused = await execute(await command('pause', timerId));
    expect(paused.timer).toMatchObject({ status: 'paused', changed_at: now, paused_ms: 0 });
    now += 3250; const resumed = await execute(await command('resume', timerId));
    expect(resumed.timer.paused_ms).toBe(3250);
    now += 2750; const finished = await execute(await command('finish', timerId));
    expect(finished.timer.status).toBe('idle');
    expect(await sessions()).toEqual([expect.objectContaining({ id: timerId, project_id: id, started_at: 1800000000000, ended_at: now, paused_ms: 3250, active_seconds: 13 })]);
    const columns = await env.DB.prepare('PRAGMA table_info(work_sessions)').all<{ name: string }>();
    expect(columns.results.some((col) => ['mode', 'timer_type'].includes(col.name))).toBe(false);
  });
  it('ブラウザが閉じている間も進行/一時停止をサーバーから復元する', async () => {
    const id = await project(); const started = await start(id);
    now += 86400000;
    expect((await state()).timer).toEqual(started.timer);
    const paused = await execute(await command('pause', started.timer.timer_id!));
    now += 7200000;
    const restored = await state();
    expect(restored.timer).toEqual(paused.timer);
    expect(restored.server_now).toBe(now);
    const finished = await execute(await command('finish', paused.timer.timer_id!));
    expect(finished.outcome.discarded).toBe(false);
    expect((await sessions())[0]).toMatchObject({ paused_ms: 7200000, active_seconds: 86400 });
  });
  it('1秒未満の実作業は破棄し、操作結果を再送でも保持する', async () => {
    const started = await start(await project()); now += 999;
    const finish = await command('finish', started.timer.timer_id!);
    expect((await execute(finish)).outcome).toMatchObject({ discarded: true, session_id: null });
    expect((await execute(finish)).outcome.discarded).toBe(true);
    expect(await sessions()).toHaveLength(0);
  });
  it('一時停止中に終了すると停止した時間も加算される', async () => {
    const started = await start(await project()); now += 2000;
    await execute(await command('pause', started.timer.timer_id!)); now += 8000;
    await execute(await command('finish', started.timer.timer_id!));
    expect((await sessions())[0]).toMatchObject({ active_seconds: 2, paused_ms: 8000 });
  });
  it('同時開始は最大1件だけ成功する', async () => {
    const id = await project(); const old = await state();
    const commands = await Promise.all([command('start', id, old), command('start', id, old)]);
    const responses = await Promise.all(commands.map((input) => request('/timer', 'POST', input)));
    expect(responses.map((r) => r.status).sort()).toEqual([200, 409]);
    expect((await state()).timer.revision).toBe(1);
    expect((await env.DB.prepare('SELECT * FROM timer_state').all()).results).toHaveLength(1);
  });
  it('別 ID の同時終了でも実績は1件、同じ ID の再送では元の結果を返す', async () => {
    const started = await start(await project()); now += 5000;
    const one = await command('finish', started.timer.timer_id!); const two = { ...one, operation_id: crypto.randomUUID() };
    const responses = await Promise.all([request('/timer', 'POST', one), request('/timer', 'POST', two)]);
    expect(responses.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(await sessions()).toHaveLength(1);
    const successful = responses[0].status === 200 ? one : two;
    expect((await execute(successful)).outcome.session_id).toBe(started.timer.timer_id);
    expect(await sessions()).toHaveLength(1);
  });
  it('通信失敗後の開始再送は新しいタイマーを作らず、過去の再送で新タイマーを終わらせない', async () => {
    const id = await project(); const startCommand = await command('start', id);
    const started = await execute(startCommand);
    expect((await execute(startCommand)).timer.timer_id).toBe(started.timer.timer_id);
    now += 2000; const finish = await command('finish', started.timer.timer_id!); await execute(finish);
    const next = await start(id);
    expect((await execute(finish)).timer.timer_id).toBe(next.timer.timer_id);
    expect((await state()).timer.status).toBe('running');
    expect((await request('/timer', 'POST', { ...startCommand, project_id: crypto.randomUUID() })).status).toBe(409);
  });
  it('古い revision、タイマー ID、無効な状態遷移、端末時刻を拒否する', async () => {
    const id = await project(); const started = await start(id); const timerId = started.timer.timer_id!;
    expect((await request('/timer', 'POST', await command('start', id))).status).toBe(409);
    expect((await request('/timer', 'POST', await command('resume', timerId))).status).toBe(409);
    expect((await request('/timer', 'POST', await command('pause', crypto.randomUUID()))).status).toBe(409);
    expect((await request('/timer', 'POST', { ...await command('pause', timerId), now: now + 900000 })).status).toBe(400);
    const pause = await command('pause', timerId); await execute(pause);
    expect((await request('/timer', 'POST', { ...pause, operation_id: crypto.randomUUID() })).status).toBe(409);
    now += 1000; await execute(await command('resume', timerId));
  });
  it('同じ操作 ID の同時再送は同じ結果になり、同時終了も1件だけ保存', async () => {
    const id = await project(); const begin = await command('start', id);
    const responses = await Promise.all([request('/timer', 'POST', begin), request('/timer', 'POST', begin)]);
    expect(responses.map((r) => r.status)).toEqual([200, 200]);
    expect((await state()).timer.revision).toBe(1);
    const timerId = (await state()).timer.timer_id!; now += 5000;
    const finish = await command('finish', timerId);
    const endings = await Promise.all([request('/timer', 'POST', finish), request('/timer', 'POST', finish)]);
    expect(endings.map((r) => r.status)).toEqual([200, 200]);
    expect(await sessions()).toHaveLength(1);
  });
  it('バッチの後半が失敗した場合、実績と状態更新をまとめてロールバックする', async () => {
    const started = await start(await project()); now += 5000;
    const finish = await command('finish', started.timer.timer_id!);
    await env.DB.prepare("CREATE TRIGGER fail_operation BEFORE INSERT ON timer_operations BEGIN SELECT RAISE(ABORT, 'simulated failure'); END;").run();
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect((await request('/timer', 'POST', finish)).status).toBe(500);
      expect(await sessions()).toHaveLength(0);
      expect((await state()).timer).toEqual(started.timer);
    } finally {
      await env.DB.prepare('DROP TRIGGER fail_operation').run(); log.mockRestore();
    }
    await execute(finish);
    expect(await sessions()).toHaveLength(1);
  });
  it('DB の実績制約と singleton 制約を守る', async () => {
    const id = await project();
    await expect(env.DB.prepare('INSERT INTO timer_state (id) VALUES (2)').run()).rejects.toThrow();
    await expect(env.DB.prepare('DELETE FROM timer_state').run()).rejects.toThrow();
    await expect(env.DB.prepare('INSERT INTO work_sessions (id, project_id, started_at, ended_at, paused_ms) VALUES (?, ?, 1000, 1000, 0)').bind(crypto.randomUUID(), id).run()).rejects.toThrow();
    await expect(env.DB.prepare('INSERT INTO work_sessions (id, project_id, started_at, ended_at, paused_ms) VALUES (?, ?, 1000, 2000, 1000)').bind(crypto.randomUUID(), id).run()).rejects.toThrow();
  });
});
