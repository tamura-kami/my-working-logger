import { Hono } from 'hono';
import { z } from 'zod';
import type { Bindings } from './env';
import { ApiError, body, categoryIdSchema, nameSchema } from './http';

const api = new Hono<{ Bindings: Bindings }>();
const categoryInput = z.strictObject({ name: nameSchema });
const projectInput = z.strictObject({
  name: nameSchema, category_id: categoryIdSchema,
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/), archived: z.boolean().optional(),
});
const projectPatch = projectInput.partial().refine((value) => Object.keys(value).length > 0);
async function exists(db: D1Database, table: 'categories' | 'projects', id: string) {
  return !!await db.prepare(`SELECT id FROM ${table} WHERE id = ?`).bind(id).first();
}
api.get('/categories', async (c) => {
  const { results } = await c.env.DB.prepare("SELECT id, name FROM categories ORDER BY (id = 'uncategorized') DESC, name, id").all();
  return c.json({ categories: results });
});
api.post('/categories', async (c) => {
  const input = await body(c, categoryInput);
  const id = crypto.randomUUID();
  await c.env.DB.prepare('INSERT INTO categories (id, name) VALUES (?, ?)').bind(id, input.name).run();
  return c.json({ category: { id, name: input.name } }, 201);
});
api.patch('/categories/:id', async (c) => {
  const id = c.req.param('id');
  if (id === 'uncategorized') throw new ApiError(409, '標準の未分類カテゴリは変更できません。');
  const input = await body(c, categoryInput);
  const result = await c.env.DB.prepare('UPDATE categories SET name = ? WHERE id = ?').bind(input.name, id).run();
  if (!result.meta.changes) throw new ApiError(404, 'カテゴリが見つかりません。');
  return c.json({ category: { id, name: input.name } });
});
api.delete('/categories/:id', async (c) => {
  const id = c.req.param('id');
  if (id === 'uncategorized') throw new ApiError(409, '未分類カテゴリは削除できません。');
  // 外部キー ON DELETE SET DEFAULT が同一 SQL 内で所属作業を移す。
  const result = await c.env.DB.prepare('DELETE FROM categories WHERE id = ?').bind(id).run();
  if (!result.meta.changes) throw new ApiError(404, 'カテゴリが見つかりません。');
  return c.json({ deleted: true });
});
api.get('/projects', async (c) => {
  const scope = c.req.query('scope') ?? 'active';
  if (!['active', 'all'].includes(scope)) throw new ApiError(400, 'scope は active または all を指定してください。');
  const { results } = await c.env.DB.prepare(`SELECT * FROM projects ${scope === 'active' ? 'WHERE archived = 0' : ''} ORDER BY name, id`).all<{ archived: number }>();
  return c.json({ projects: results.map((p) => ({ ...p, archived: !!p.archived })) });
});
api.post('/projects', async (c) => {
  const input = await body(c, projectInput);
  const id = crypto.randomUUID();
  if (!await exists(c.env.DB, 'categories', input.category_id)) throw new ApiError(400, 'カテゴリが見つかりません。');
  // カテゴリの同時削除も条件付き INSERT で処理し、外部キー違反を避ける。
  const result = await c.env.DB.prepare(`INSERT INTO projects (id, name, category_id, color, archived)
    SELECT ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM categories WHERE id = ?)`)
    .bind(id, input.name, input.category_id, input.color, input.archived ? 1 : 0, input.category_id).run();
  if (!result.meta.changes) throw new ApiError(409, 'カテゴリが変更されました。再読み込みしてください。');
  return c.json({ project: { ...input, id, archived: input.archived ?? false } }, 201);
});
api.patch('/projects/:id', async (c) => {
  const id = c.req.param('id');
  const input = await body(c, projectPatch);
  if (!await exists(c.env.DB, 'projects', id)) throw new ApiError(404, '作業が見つかりません。');
  if (input.category_id && !await exists(c.env.DB, 'categories', input.category_id)) throw new ApiError(400, 'カテゴリが見つかりません。');
  const result = await c.env.DB.prepare(`UPDATE projects SET
    name = COALESCE(?, name), category_id = COALESCE(?, category_id),
    color = COALESCE(?, color), archived = COALESCE(?, archived)
    WHERE id = ? AND (? IS NULL OR EXISTS (SELECT 1 FROM categories WHERE id = ?))`)
    .bind(input.name ?? null, input.category_id ?? null, input.color ?? null,
      input.archived === undefined ? null : Number(input.archived), id, input.category_id ?? null, input.category_id ?? null).run();
  if (!result.meta.changes) throw new ApiError(409, '作業またはカテゴリが変更されました。再読み込みしてください。');
  return c.json({ updated: true });
});
export default api;
