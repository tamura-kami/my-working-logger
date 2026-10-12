import { Hono } from 'hono';

import type { Bindings } from './env';
import { ApiError } from './http';
import projects from './projects';
import timer from './timer';
export type { Bindings } from './env';
const app = new Hono<{ Bindings: Bindings }>();

app.use('/api/*', async (c, next) => {
  c.header('Cache-Control', 'no-store');
  if (!['GET', 'HEAD', 'OPTIONS'].includes(c.req.method)) {
    const origin = c.req.header('Origin');
    if ((origin && origin !== new URL(c.req.url).origin) || c.req.header('Sec-Fetch-Site') === 'cross-site') {
      return c.json({ error: '別のサイトからの操作は受け付けられません。' }, 403);
    }
  }
  await next();
});
app.onError((error, c) => {
  if (error instanceof ApiError) return c.json({ error: error.message }, error.status);
  console.error('API error:', error);
  return c.json({ error: '処理に失敗しました。通信状況と DB の設定を確認してください。' }, 500);
});
app.route('/api', projects);
app.route('/api', timer);

app.get('/api/health', async (c) => {
  c.header('Cache-Control', 'no-store');
  try {
    // 接続だけでなく初期マイグレーションの適用も確認する。
    const row = await c.env.DB.prepare(
      'SELECT version FROM app_metadata WHERE id = 1',
    ).first<{ version: number }>();
    if (row?.version !== 2) return c.json({ status: 'error', database: 'unavailable' }, 503);
    return c.json({ status: 'ok', database: 'ok' });
  } catch {
    return c.json({ status: 'error', database: 'unavailable' }, 503);
  }
});
app.all('/api', (c) => c.json({ error: 'Not found' }, 404));
app.all('/api/*', (c) => c.json({ error: 'Not found' }, 404));
app.all('*', (c) => c.env.ASSETS.fetch(c.req.raw));
export default app;
