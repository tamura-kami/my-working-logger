import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import app from '../worker/index';
import type { Bindings } from '../worker/env';
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
    env.DB.prepare('DELETE FROM work_sessions'),
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
    const cat = await category(); const id = await project(cat);
    await request('/sessions', 'POST', { id: crypto.randomUUID(), project_id: id, started_at: now, ended_at: now + 5000, paused_ms: 0 });
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
  it('同一オリジンの JSON 操作だけを受け付ける', async () => {
    expect((await request('/categories', 'POST', { name: '外部' }, { Origin: 'https://evil.example' })).status).toBe(403);
    expect((await request('/categories', 'POST', { name: '外部' }, { 'Sec-Fetch-Site': 'cross-site' })).status).toBe(403);
    const invalid = await app.request('/api/categories', { method: 'POST', body: '{', headers: { 'Content-Type': 'application/json' } }, env);
    expect(invalid.status).toBe(400);
    expect((await request('/categories', 'POST', { name: 'テスト' }, { 'Content-Type': 'text/plain' })).status).toBe(400);
  });
});
