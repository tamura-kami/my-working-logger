import { expect, it } from 'vitest';
import { bindings, databaseRuntime, migrate } from './database';
import app from '../worker/index';
it.each(['running', 'paused'])('既存の %s 通常タイマー・実績・再送結果を移行後も保持する', async (status) => {
  const runtime = databaseRuntime();
  try {
    const env = await bindings(runtime);
    await migrate(env.DB, ['0001_app_metadata.sql', '0002_projects_and_timer.sql']);
    const id = crypto.randomUUID(); const timerId = crypto.randomUUID(); const operationId = crypto.randomUUID();
    await env.DB.batch([
      env.DB.prepare("INSERT INTO projects (id, name, color) VALUES (?, '継続作業', '#175c50')").bind(id),
      env.DB.prepare('UPDATE timer_state SET revision = 7, timer_id = ?, project_id = ?, status = ?, started_at = 1000, changed_at = 3000, paused_ms = 500, last_operation_id = ?').bind(timerId, id, status, operationId),
      env.DB.prepare('INSERT INTO work_sessions (id, project_id, started_at, ended_at, paused_ms) VALUES (?, ?, 1000, 5000, 1000)').bind(crypto.randomUUID(), id),
      env.DB.prepare("INSERT INTO timer_operations (id, payload, session_id, discarded) VALUES (?, '{}', NULL, 0)").bind(operationId),
    ]);
    await migrate(env.DB, ['0003_pomodoro.sql']);
    const response = await app.request('/api/timer', {}, env);
    expect(response.status).toBe(200);
    expect((await response.json() as { timer: unknown }).timer).toMatchObject({ status, revision: 7, timer_id: timerId, project_id: id, mode: 'normal', started_at: 1000, changed_at: 3000, paused_ms: 500, pomodoro: null });
    expect((await env.DB.prepare('SELECT * FROM work_sessions').all()).results).toHaveLength(1);
    expect(await env.DB.prepare('SELECT id FROM timer_operations').first()).toEqual({ id: operationId });
    expect(await env.DB.prepare('SELECT version FROM app_metadata').first()).toEqual({ version: 3 });
    await expect(env.DB.prepare('DELETE FROM timer_state').run()).rejects.toThrow();
  } finally { await runtime.dispose(); }
});
