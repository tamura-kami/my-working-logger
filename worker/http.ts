import type { Context } from 'hono';
import { z } from 'zod';
import type { Bindings } from './env';
export class ApiError extends Error {
  constructor(public status: 400 | 404 | 409, message: string) { super(message); }
}
export async function body<T>(c: Context<{ Bindings: Bindings }>, schema: z.ZodType<T>): Promise<T> {
  if (c.req.header('Content-Type')?.split(';')[0].trim().toLowerCase() !== 'application/json') {
    throw new ApiError(400, 'JSON 形式で送信してください。');
  }
  let value: unknown;
  try { value = await c.req.json(); } catch { throw new ApiError(400, 'JSON を読み取れません。'); }
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new ApiError(400, '入力内容を確認してください。');
  return parsed.data;
}
export const nameSchema = z.string().trim().min(1).max(80);
export const categoryIdSchema = z.union([z.literal('uncategorized'), z.uuid()]);
