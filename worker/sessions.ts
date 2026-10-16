import { Hono } from 'hono';
import { z } from 'zod';
import type { Bindings } from './env';
import { ApiError, body } from './http';
import { dateStart, DAY_MS } from '../shared/sessionTime';
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
const editInput = z.strictObject({ started_at: timestamp, ended_at: timestamp, paused_ms: timestamp })
  .refine((v) => v.ended_at - v.started_at - v.paused_ms >= 1000);
api.patch('/sessions/:id', async (c) => {
  const value = await body(c, editInput);
  const result = await c.env.DB.prepare('UPDATE work_sessions SET started_at = ?, ended_at = ?, paused_ms = ? WHERE id = ?')
    .bind(value.started_at, value.ended_at, value.paused_ms, c.req.param('id')).run();
  if (!result.meta.changes) throw new ApiError(404, '実績が見つかりません。');
  return c.json({ updated: true });
});
api.delete('/sessions/:id', async (c) => {
  const result = await c.env.DB.prepare('DELETE FROM work_sessions WHERE id = ?').bind(c.req.param('id')).run();
  if (!result.meta.changes) throw new ApiError(404, '実績が見つかりません。');
  return c.json({ deleted: true });
});
api.get('/sessions', async (c) => {
  const date = c.req.query('date');
  const overlapStart = c.req.query('overlap_start');
  const overlapEnd = c.req.query('overlap_end');
  let filter = ''; let values: number[] = [];
  if (date !== undefined) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(dateStart(date)) || new Date(dateStart(date) + 9 * 3600000).toISOString().slice(0, 10) !== date)
      throw new ApiError(400, '日付を確認してください。');
    filter = 'WHERE s.started_at < ? AND s.ended_at > ?'; values = [dateStart(date) + DAY_MS, dateStart(date)];
  } else if (overlapStart !== undefined || overlapEnd !== undefined) {
    const start = Number(overlapStart), end = Number(overlapEnd);
    if (overlapStart === undefined || overlapEnd === undefined || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end <= start || end > 8640000000000000)
      throw new ApiError(400, '時刻を確認してください。');
    filter = 'WHERE s.started_at < ? AND s.ended_at > ?'; values = [end, start];
  }
  const { results } = await c.env.DB.prepare(`SELECT s.*, p.name AS project_name, p.color
    FROM work_sessions s JOIN projects p ON p.id = s.project_id ${filter}
    ORDER BY s.started_at DESC, s.id DESC ${filter ? '' : 'LIMIT 100'}`).bind(...values).all();
  return c.json({ sessions: results });
});
export default api;
