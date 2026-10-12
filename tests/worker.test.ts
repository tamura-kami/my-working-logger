import { URL } from 'node:url';
import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import app, { type Bindings } from '../worker/index';

const runtime = new Miniflare(convertV4MiniflareOptions({
  modules: true,
  script: 'export default { fetch() { return new Response("test"); } }',
  d1Databases: { DB: 'test-db' },
}));
let env: Bindings;
beforeAll(async () => {
  const DB = await runtime.getD1Database('DB');
  const ASSETS = { fetch: async () => new Response('<!doctype html><title>App</title>', {
    headers: { 'Content-Type': 'text/html' },
  }) };
  env = { DB, ASSETS } as unknown as Bindings;
});
afterAll(async () => { await runtime.dispose(); });

describe('Worker と D1', () => {
  it('未適用の DB は 503 を返し、内部エラーを公開しない', async () => {
    const response = await app.request('/api/health', {}, env);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ status: 'error', database: 'unavailable' });
  });
  it('初期マイグレーションを適用すると health が成功する', async () => {
    const sql = await readFile(new URL('../migrations/0001_app_metadata.sql', import.meta.url), 'utf8');
    // D1 exec は行ごとの SQL を扱うため、ステートメントを prepare/batch で適用。
    const statements = sql.replace(/--[^\n]*/g, '').split(';').filter((s) => s.trim());
    await env.DB.batch(statements.map((s) => env.DB.prepare(s)));
    const response = await app.request('/api/health', {}, env);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'ok', database: 'ok' });
    expect(response.headers.get('Cache-Control')).toBe('no-store');
  });
  it.each(['/api', '/api/missing'])('未知の API %s は HTML ではなく JSON 404', async (path) => {
    const response = await app.request(path, {}, env);
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'Not found' });
  });
  it('画面パスは Static Assets に委譲する', async () => {
    const response = await app.request('/summary', {}, env);
    expect(response.headers.get('Content-Type')).toBe('text/html');
  });
});
