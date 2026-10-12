import { Hono } from 'hono';

export type Bindings = { DB: D1Database; ASSETS: Fetcher };
const app = new Hono<{ Bindings: Bindings }>();

app.get('/api/health', async (c) => {
  c.header('Cache-Control', 'no-store');
  try {
    // 接続だけでなく初期マイグレーションの適用も確認する。
    const row = await c.env.DB.prepare(
      'SELECT version FROM app_metadata WHERE id = 1',
    ).first<{ version: number }>();
    if (row?.version !== 1) return c.json({ status: 'error', database: 'unavailable' }, 503);
    return c.json({ status: 'ok', database: 'ok' });
  } catch {
    return c.json({ status: 'error', database: 'unavailable' }, 503);
  }
});
app.all('/api', (c) => c.json({ error: 'Not found' }, 404));
app.all('/api/*', (c) => c.json({ error: 'Not found' }, 404));
app.all('*', (c) => c.env.ASSETS.fetch(c.req.raw));
export default app;
