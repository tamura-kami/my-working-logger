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
    await migrate(env.DB, ['0003_pomodoro.sql', '0004_pomodoro_cycles.sql']);
    const response = await app.request('/api/timer', {}, env);
    expect(response.status).toBe(200);
    expect((await response.json() as { timer: unknown }).timer).toMatchObject({ status, revision: 7, timer_id: timerId, project_id: id, mode: 'normal', started_at: 1000, changed_at: 3000, paused_ms: 500, pomodoro: null });
    expect((await env.DB.prepare('SELECT * FROM work_sessions').all()).results).toHaveLength(1);
    expect(await env.DB.prepare('SELECT id FROM timer_operations').first()).toEqual({ id: operationId });
    expect(await env.DB.prepare('SELECT version FROM app_metadata').first()).toEqual({ version: 4 });
    await expect(env.DB.prepare('DELETE FROM timer_state').run()).rejects.toThrow();
  } finally { await runtime.dispose(); }
});

it.each(['focus', 'short_break', 'long_break'] as const)('旧版の進行中 %s を移行し、保存済み実績を取り込まない', async (phase) => {
  const runtime = databaseRuntime();
  try {
    const env = await bindings(runtime);
    await migrate(env.DB, ['0001_app_metadata.sql', '0002_projects_and_timer.sql', '0003_pomodoro.sql']);
    const project = crypto.randomUUID(); const timer = crypto.randomUUID(); const previous = crypto.randomUUID();
    await env.DB.batch([
      env.DB.prepare("INSERT INTO projects (id, name, color) VALUES (?, '移行', '#175c50')").bind(project),
      env.DB.prepare('INSERT INTO work_sessions (id, project_id, started_at, ended_at, paused_ms) VALUES (?, ?, 0, 60000, 0)').bind(previous, project),
      env.DB.prepare(`UPDATE timer_state SET revision = 5, timer_id = ?, project_id = ?, status = 'paused', started_at = 100000,
        changed_at = 110000, paused_ms = 0, mode = 'pomodoro', phase = ?, completed_focus = 1,
        focus_minutes = 1, short_break_minutes = 1, long_break_minutes = 1, long_break_every = 2, duration_ms = 60000`).bind(timer, project, phase),
    ]);
    await migrate(env.DB, ['0004_pomodoro_cycles.sql']);
    expect(await env.DB.prepare('SELECT revision, timer_id, cycle_id, cycle_started_at, cycle_active_ms FROM timer_state').first()).toEqual({
      revision: 5, timer_id: timer, cycle_id: phase === 'focus' ? timer : null, cycle_started_at: phase === 'focus' ? 100000 : null, cycle_active_ms: 0,
    });
    const response = await app.request('/api/timer', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'finish', revision: 5, timer_id: timer, operation_id: crypto.randomUUID() }) }, env);
    expect(response.status).toBe(200);
    const rows = (await env.DB.prepare('SELECT id, active_seconds FROM work_sessions ORDER BY started_at').all()).results;
    expect(rows).toEqual(phase === 'focus' ? [{ id: previous, active_seconds: 60 }, { id: timer, active_seconds: 10 }] : [{ id: previous, active_seconds: 60 }]);
  } finally { await runtime.dispose(); }
});
