import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import app from '../worker/index';
import type { Bindings } from '../worker/env';
import type { PomodoroSettings, TimerCommand, TimerResult, TimerSnapshot } from '../shared/contracts';
import { bindings, databaseRuntime, migrate } from './database';

const runtime = databaseRuntime();
let env: Bindings;
let now = 1800000000000;
const projectId = 'a81cec60-b018-4c76-a70e-f8f7853f874b';
const settings: PomodoroSettings = { focus_minutes: 1, short_break_minutes: 2, long_break_minutes: 3, long_break_every: 2 };
beforeAll(async () => { env = await bindings(runtime); await migrate(env.DB); });
afterAll(async () => { await runtime.dispose(); });
beforeEach(async () => {
  now = 1800000000000;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  await env.DB.batch([
    env.DB.prepare('DELETE FROM timer_operations'), env.DB.prepare('DELETE FROM work_sessions'),
    env.DB.prepare("UPDATE timer_state SET revision = 0, timer_id = NULL, project_id = NULL, status = 'idle', started_at = NULL, changed_at = NULL, paused_ms = 0, last_operation_id = NULL, mode = 'normal', phase = NULL, completed_focus = 0, focus_minutes = NULL, short_break_minutes = NULL, long_break_minutes = NULL, long_break_every = NULL, duration_ms = NULL, deadline_at = NULL, cycle_id = NULL, cycle_started_at = NULL, cycle_active_ms = 0"),
    env.DB.prepare('DELETE FROM projects'),
    env.DB.prepare("INSERT INTO projects (id, name, color) VALUES (?, '開発', '#175c50')").bind(projectId),
  ]);
});
afterEach(() => vi.restoreAllMocks());
async function request(path: string, input?: unknown) {
  return app.request(`/api${path}`, input ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) } : {}, env);
}
async function status() {
  const response = await request('/timer'); expect(response.status).toBe(200);
  return await response.json() as TimerSnapshot;
}
async function sessions() { return (await (await request('/sessions')).json() as { sessions: Record<string, unknown>[] }).sessions; }
async function start(config = settings) {
  const command: TimerCommand = { action: 'start', operation_id: crypto.randomUUID(), revision: (await status()).timer.revision, project_id: projectId, mode: 'pomodoro', pomodoro: config };
  return execute(command);
}
async function makeCommand(action: Exclude<TimerCommand['action'], 'start'>, snapshot?: TimerSnapshot): Promise<TimerCommand> {
  const state = snapshot ?? await status();
  return { action, operation_id: crypto.randomUUID(), revision: state.timer.revision, timer_id: state.timer.timer_id! };
}
async function execute(input: TimerCommand) {
  const response = await request('/timer', input);
  expect(response.status, await response.clone().text()).toBe(200);
  return await response.json() as TimerResult;
}
async function action(name: Exclude<TimerCommand['action'], 'start'>) { return execute(await makeCommand(name)); }

describe('自動ポモドーロとサイクル単位の実績', () => {
  it('集中→短休憩→集中→長休憩→集中へ自動移行し、集中合計を1件保存する', async () => {
    const first = await start(); const began = now;
    now += 60000;
    expect((await status()).timer).toMatchObject({ status: 'running', phase: 'short_break', completed_focus: 1, deadline_at: now + 120000 });
    expect(await sessions()).toHaveLength(0);
    now += 120000;
    expect((await status()).timer).toMatchObject({ status: 'running', phase: 'focus', deadline_at: now + 60000 });
    now += 60000;
    expect((await status()).timer).toMatchObject({ status: 'running', phase: 'long_break', completed_focus: 2, deadline_at: now + 180000, cycle_id: null });
    expect(await sessions()).toEqual([expect.objectContaining({ id: first.timer.cycle_id, started_at: began, ended_at: now, active_seconds: 120, paused_ms: 120000 })]);
    now += 180000;
    const next = await status();
    expect(next.timer).toMatchObject({ status: 'running', phase: 'focus', cycle_started_at: now, completed_focus: 2, pomodoro: settings });
    expect(next.timer.cycle_id).not.toBe(first.timer.cycle_id);
    now += 1000; await action('finish');
    expect((await sessions())[0]).toMatchObject({ started_at: next.timer.started_at, paused_ms: 0, active_seconds: 1 });
  });
  it('集中と短休憩の手動停止を含めた休止時間を合算する', async () => {
    const first = await start();
    now += 10000; await action('pause'); now += 10001;
    const resumed = await action('resume');
    expect(resumed.timer.deadline_at).toBe(now + 50000);
    now += 50000; await status();
    now += 30000; await action('pause'); now += 20002;
    const breakResume = await action('resume');
    expect(breakResume.timer.deadline_at).toBe(now + 90000);
    now += 90000; await status(); now += 60000; await status();
    expect(await sessions()).toEqual([expect.objectContaining({ started_at: first.timer.started_at, ended_at: now, active_seconds: 120, paused_ms: 150003 })]);
  });
  it.each(['focus', 'short_break', 'paused_focus', 'paused_break'])('%s 中の終了でそれまでの集中を1件保存し、再送でも増えない', async (phase) => {
    await start();
    if (phase.includes('break')) { now += 60000; await status(); }
    now += 12500;
    if (phase.startsWith('paused')) { await action('pause'); now += 8000; }
    const command = await makeCommand('finish');
    const result = await execute(command);
    expect(result.timer).toMatchObject({ status: 'idle', mode: 'normal', cycle_id: null });
    expect(result.outcome.session_id).not.toBeNull();
    expect((await sessions())[0]).toMatchObject({ ended_at: now, active_seconds: phase.includes('break') ? 60 : 12,
      paused_ms: phase.includes('break') ? 12500 + (phase.startsWith('paused') ? 8000 : 0) : phase.startsWith('paused') ? 8000 : 0 });
    expect((await execute(command)).outcome).toEqual(result.outcome);
    expect(await sessions()).toHaveLength(1);
  });
  it('0秒なら保存せず、一時停止中も満了しない', async () => {
    await start(); now += 999; const paused = await action('pause'); now += 3600000;
    expect((await status()).timer).toEqual(paused.timer);
    expect((await action('finish')).outcome.discarded).toBe(true);
    expect(await sessions()).toHaveLength(0);
  });
  it.each(['running', 'paused'])('短休憩の %s 状態からスキップすると即座に集中を開始する', async (state) => {
    await start(); now += 60000; await status(); now += 5000;
    if (state === 'paused') { await action('pause'); now += 7000; }
    const skip = await makeCommand('skip'); const next = await execute(skip);
    expect(next.timer).toMatchObject({ status: 'running', phase: 'focus', started_at: now, deadline_at: now + 60000 });
    expect((await execute(skip)).timer).toEqual(next.timer);
    now += 60000; await status();
    expect((await sessions())[0]).toMatchObject({ active_seconds: 120, paused_ms: state === 'paused' ? 12000 : 5000 });
    const nextCycle = await action('skip');
    expect(nextCycle.timer).toMatchObject({ phase: 'focus', status: 'running', cycle_started_at: now });
    now += 1000; await action('finish');
    expect((await sessions())[0]).toMatchObject({ active_seconds: 1, paused_ms: 0 });
  });
  it('長休憩の一時停止・再開・終了では確定済み実績を追加しない', async () => {
    await start({ ...settings, long_break_every: 1 }); now += 60000; await status();
    now += 10000; await action('pause'); now += 50000;
    const resumed = await action('resume'); expect(resumed.timer.deadline_at).toBe(now + 170000);
    expect((await action('finish')).outcome).toMatchObject({ session_id: null, discarded: false });
    expect(await sessions()).toHaveLength(1);
  });
  it('遅延した満了は1フェーズのみ進行し、集中時間を水増ししない', async () => {
    const first = await start(); now += 3600000;
    const rest = await status();
    expect(rest.timer).toMatchObject({ phase: 'short_break', started_at: now, deadline_at: now + 120000 });
    expect((await status()).timer).toEqual(rest.timer);
    now += 125000; await status(); now += 65000;
    const final = await status();
    expect(final.timer.phase).toBe('long_break');
    expect((await sessions())[0]).toMatchObject({ started_at: first.timer.started_at, ended_at: now - 5000, active_seconds: 120, paused_ms: 3665000 });
  });
  it('開始時設定を固定し、不正入力・フェーズ操作を拒否する', async () => {
    const started = await start();
    expect(started.timer.pomodoro).toEqual(settings);
    expect((await request('/timer', { ...await makeCommand('pause'), pomodoro: settings })).status).toBe(400);
    for (const name of ['skip', 'start_focus', 'start_break', 'resume'] as const) expect((await request('/timer', await makeCommand(name))).status).toBe(409);
    await action('finish');
    const base = { action: 'start', project_id: projectId, mode: 'pomodoro', revision: (await status()).timer.revision, operation_id: crypto.randomUUID() };
    for (const invalid of [undefined, { ...settings, focus_minutes: 0 }, { ...settings, short_break_minutes: 181 }, { ...settings, long_break_every: 1.5 }]) expect((await request('/timer', { ...base, pomodoro: invalid })).status).toBe(400);
    expect((await request('/timer', { ...base, mode: 'normal', pomodoro: settings })).status).toBe(400);
    await start();
    await expect(env.DB.prepare('UPDATE timer_state SET focus_minutes = 0').run()).rejects.toThrow();
    await expect(env.DB.prepare('UPDATE timer_state SET deadline_at = deadline_at + 1000').run()).rejects.toThrow();
  });
});

describe('満了処理の競合・冪等性', () => {
  it('複数端末の満了・終了が競合しても同一実績は1件だけ保存する', async () => {
    const started = await start({ ...settings, long_break_every: 1 });
    const pause = await makeCommand('pause', started); const finish = await makeCommand('finish', started);
    now += 60000;
    const responses = await Promise.all([request('/timer', pause), request('/timer', finish), ...['/timer', '/sessions', '/projects', '/health'].map((path) => request(path))]);
    expect(responses.map((r) => r.status)).toEqual([409, 409, 200, 200, 200, 200]);
    expect(await sessions()).toHaveLength(1);
    expect((await status()).timer).toMatchObject({ revision: started.timer.revision + 1, completed_focus: 1, phase: 'long_break' });
  });
  it('確定の状態更新に失敗したら実績 INSERT もロールバックする', async () => {
    const started = await start({ ...settings, long_break_every: 1 }); now += 60000;
    await env.DB.prepare("CREATE TRIGGER fail_expiry BEFORE UPDATE ON timer_state WHEN NEW.phase = 'long_break' BEGIN SELECT RAISE(ABORT, 'simulated failure'); END;").run();
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect((await request('/timer')).status).toBe(500);
      expect((await env.DB.prepare('SELECT * FROM work_sessions').all()).results).toHaveLength(0);
      expect(await env.DB.prepare('SELECT revision, status FROM timer_state').first()).toEqual({ revision: started.timer.revision, status: 'running' });
    } finally { await env.DB.prepare('DROP TRIGGER fail_expiry').run(); log.mockRestore(); }
    await status(); expect(await sessions()).toHaveLength(1);
  });
});
