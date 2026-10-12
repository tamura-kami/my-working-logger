import { URL } from 'node:url';
import { readFile } from 'node:fs/promises';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import type { Bindings } from '../worker/env';
export function databaseRuntime() {
  return new Miniflare(convertV4MiniflareOptions({
    modules: true, script: 'export default { fetch() { return new Response("test"); } }',
    d1Databases: { DB: 'test-db' },
  }));
}
export async function bindings(runtime: Miniflare): Promise<Bindings> {
  return { DB: await runtime.getD1Database('DB'), ASSETS: { fetch: async () => new Response('App') } } as unknown as Bindings;
}
export async function migrate(db: D1Database) {
  for (const file of ['0001_app_metadata.sql', '0002_projects_and_timer.sql']) {
    const sql = await readFile(new URL(`../migrations/${file}`, import.meta.url), 'utf8');
    const statements: string[] = [];
    let current = ''; let trigger = false;
    for (const line of sql.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('--')) continue;
      if (trimmed.startsWith('CREATE TRIGGER')) trigger = true;
      current += line + '\n';
      if (trimmed.endsWith(';') && (!trigger || trimmed.endsWith('END;'))) {
        statements.push(current); current = ''; trigger = false;
      }
    }
    if (current.trim()) throw new Error('Unterminated migration');
    await db.batch(statements.map((sql) => db.prepare(sql)));
  }
}
