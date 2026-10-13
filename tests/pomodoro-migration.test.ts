import { expect, it } from 'vitest';
import { bindings, databaseRuntime, migrate } from './database';
it('ローカル移行で既存の確定実績・作業を保持し、サーバー状態を撤去する', async () => {
  const runtime = databaseRuntime();
  try {
    const env = await bindings(runtime);
    await migrate(env.DB, ['0001_app_metadata.sql', '0002_projects_and_timer.sql', '0003_pomodoro.sql', '0004_pomodoro_cycles.sql']);
    const id = crypto.randomUUID(); const session = crypto.randomUUID();
    await env.DB.batch([
      env.DB.prepare("INSERT INTO projects (id, name, color) VALUES (?, '作業', '#175c50')").bind(id),
      env.DB.prepare('INSERT INTO work_sessions (id, project_id, started_at, ended_at, paused_ms) VALUES (?, ?, 1000, 5000, 1000)').bind(session, id),
    ]);
    await migrate(env.DB, ['0005_local_timer.sql']);
    expect(await env.DB.prepare('SELECT id, active_seconds FROM work_sessions').first()).toEqual({ id: session, active_seconds: 3 });
    const tables = (await env.DB.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all<{name:string}>()).results.map((t) => t.name);
    expect(tables).not.toContain('timer_state'); expect(tables).not.toContain('timer_operations');
    expect(tables).toContain('session_receipts');
    expect(await env.DB.prepare('SELECT version FROM app_metadata').first()).toEqual({ version: 5 });
  } finally { await runtime.dispose(); }
});
