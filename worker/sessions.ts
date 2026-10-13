import { Hono } from 'hono';
import { z } from 'zod';
import type { Bindings } from './env';
import { ApiError, body } from './http';
const api = new Hono<{ Bindings: Bindings }>();
const timestamp = z.number().int().nonnegative().max(8640000000000000);
const input = z.strictObject({ id: z.uuid(), project_id: z.uuid(), started_at: timestamp,
  ended_at: timestamp, paused_ms: timestamp }).refine((v) => v.ended_at - v.started_at - v.paused_ms >= 1000,
  { message: '実作業時間は1秒以上必要です。' });
api.post('/sessions', async (c) => {
  const session = await body(c, input);
  const { id, project_id, started_at, ended_at, paused_ms } = session;
  const payload = JSON.stringify(session);
  const db = c.env.DB;
  const previous = await db.prepare('SELECT payload FROM session_receipts WHERE id = ?').bind(id).first<{ payload: string }>();
  if (!previous) {
    if (!await db.prepare('SELECT id FROM projects WHERE id = ?').bind(project_id).first()) throw new ApiError(404, '作業が見つかりません。');
    await db.batch([
      db.prepare(`INSERT INTO work_sessions (id, project_id, started_at, ended_at, paused_ms)
        SELECT ?, ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM session_receipts WHERE id = ?)`)
        .bind(id, project_id, started_at, ended_at, paused_ms, id),
      db.prepare('INSERT INTO session_receipts (id, payload) VALUES (?, ?) ON CONFLICT(id) DO NOTHING').bind(id, payload),
    ]);
  }
  const receipt = previous ?? await db.prepare('SELECT payload FROM session_receipts WHERE id = ?').bind(id).first<{ payload: string }>();
  if (receipt?.payload !== payload) throw new ApiError(409, '同じ実績 ID で別の実績は保存できません。');
  return c.json({ saved: true, id });
});
api.get('/sessions', async (c) => {
  const { results } = await c.env.DB.prepare(`SELECT s.*, p.name AS project_name, p.color
    FROM work_sessions s JOIN projects p ON p.id = s.project_id ORDER BY s.started_at DESC, s.id DESC LIMIT 100`).all();
  return c.json({ sessions: results });
});
export default api;
