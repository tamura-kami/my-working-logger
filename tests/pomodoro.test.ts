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
    env.DB.prepare("UPDATE timer_state SET revision = 0, timer_id = NULL, project_id = NULL, status = 'idle', started_at = NULL, changed_at = NULL, paused_ms = 0, last_operation_id = NULL, mode = 'normal', phase = NULL, completed_focus = 0, focus_minutes = NULL, short_break_minutes = NULL, long_break_minutes = NULL, long_break_every = NULL, duration_ms = NULL, deadline_at = NULL"),
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

describe('ポモドーロの状態保存と実績', () => {
  it('開始時の設定を固定し、途中で設定や別作業を送れない', async () => {
    const started = await start();
    expect(started.timer).toMatchObject({ mode: 'pomodoro', phase: 'focus', pomodoro: settings, duration_ms: 60000, deadline_at: now + 60000 });
    expect((await request('/timer', { ...await makeCommand('pause'), pomodoro: { ...settings, focus_minutes: 10 } })).status).toBe(400);
    expect((await status()).timer.pomodoro).toEqual(settings);
    expect((await request('/timer', { action: 'start', operation_id: crypto.randomUUID(), revision: started.timer.revision, project_id: projectId })).status).toBe(409);
  });
  it('ブラウザを閉じていても次の API で予定時刻に集中を保存し、休憩を自動開始しない', async () => {
    const started = await start(); const deadline = started.timer.deadline_at!;
    now += 3600000;
    expect((await request('/categories')).status).toBe(200);
    const expired = await status();
    expect(expired.timer).toMatchObject({ status: 'waiting', phase: 'short_break', started_at: null, deadline_at: null, completed_focus: 1, timer_id: started.timer.timer_id });
    expect(await sessions()).toEqual([expect.objectContaining({ id: started.timer.timer_id, ended_at: deadline, active_seconds: 60, paused_ms: 0 })]);
    now += 86400000;
    expect((await status()).timer).toEqual(expired.timer);
    expect(await sessions()).toHaveLength(1);
  });
  it('一時停止中は残り時間を減らさず、再開すると予定時刻を延期する', async () => {
    const started = await start(); now += 10000;
    const paused = await action('pause');
    expect(paused.timer).toMatchObject({ status: 'paused', deadline_at: null });
    now += 3600000;
    expect((await status()).timer).toEqual(paused.timer);
    expect(await sessions()).toHaveLength(0);
    const resumed = await action('resume');
    expect(resumed.timer).toMatchObject({ paused_ms: 3600000, deadline_at: now + 50000 });
    now += 50000;
    await status();
    expect((await sessions())[0]).toMatchObject({ started_at: started.timer.started_at, ended_at: resumed.timer.deadline_at, paused_ms: 3600000, active_seconds: 60 });
  });
  it('途中終了の集中は実作業を保存し、サイクルを終了する', async () => {
    await start(); now += 12500; await action('pause'); now += 8000;
    const result = await action('finish');
    expect(result.timer).toMatchObject({ status: 'idle', mode: 'normal', pomodoro: null, completed_focus: 0 });
    expect(result.outcome.session_id).not.toBeNull();
    expect((await sessions())[0]).toMatchObject({ active_seconds: 12, paused_ms: 8000 });
  });
  it('0秒の途中終了は実績を破棄し、集中回数にも含めない', async () => {
    await start(); now += 999;
    expect((await action('finish')).outcome.discarded).toBe(true);
    expect(await sessions()).toHaveLength(0);
  });
  it('休憩は一時停止・再開・満了しても実績に混ざらない', async () => {
    await start(); now += 60000;
    await status();
    const breakStart = await action('start_break');
    expect(breakStart.timer).toMatchObject({ phase: 'short_break', duration_ms: 120000 });
    now += 30000; await action('pause'); now += 1000000;
    const resumed = await action('resume'); now = resumed.timer.deadline_at! + 1000;
    const ready = await status();
    expect(ready.timer).toMatchObject({ status: 'waiting', phase: 'focus', completed_focus: 1 });
    expect(await sessions()).toHaveLength(1);
    const next = await action('start_focus');
    expect(next.timer).toMatchObject({ status: 'running', phase: 'focus', pomodoro: settings, completed_focus: 1 });
    expect(next.timer.timer_id).not.toBe(breakStart.timer.timer_id);
  });
  it.each(['waiting', 'running', 'paused'] as const)('休憩の %s 状態からスキップでき、次の集中は手動開始', async (state) => {
    await start(); now += 60000; await status();
    if (state !== 'waiting') await action('start_break');
    if (state === 'paused') { now += 5000; await action('pause'); }
    expect((await action('skip')).timer).toMatchObject({ status: 'waiting', phase: 'focus', completed_focus: 1, deadline_at: null });
    expect(await sessions()).toHaveLength(1);
    expect((await request('/timer', await makeCommand('skip'))).status).toBe(409);
  });
  it('指定回数ごとに長休憩を選び、長休憩後も固定した設定で次の集中を開始', async () => {
    await start(); now += 60000; await status();
    await action('skip'); await action('start_focus'); now += 60000;
    const waiting = await status();
    expect(waiting.timer).toMatchObject({ phase: 'long_break', completed_focus: 2, duration_ms: 180000, status: 'waiting' });
    await action('start_break'); now += 180000;
    expect((await status()).timer).toMatchObject({ phase: 'focus', status: 'waiting', completed_focus: 2 });
    await action('start_focus'); now += 60000;
    expect((await status()).timer).toMatchObject({ phase: 'short_break', completed_focus: 3 });
    expect(await sessions()).toHaveLength(3);
  });
  it('休憩中/開始待ちに全体終了しても追加実績を作らない', async () => {
    await start(); now += 60000; await status(); await action('start_break'); now += 5000;
    const ended = await action('finish');
    expect(ended.outcome).toMatchObject({ session_id: null, discarded: false });
    expect(await sessions()).toHaveLength(1);
    await start(); now += 60000; await status(); await action('finish');
    expect(await sessions()).toHaveLength(2);
  });
  it('待機中に pause/resume や誤った開始フェーズを拒否する', async () => {
    await start(); now += 60000; await status();
    for (const name of ['pause', 'resume', 'start_focus'] as const) expect((await request('/timer', await makeCommand(name))).status).toBe(409);
    await action('skip');
    expect((await request('/timer', await makeCommand('start_break'))).status).toBe(409);
  });
  it('設定の不正値・省略を API と DB 制約で拒否する', async () => {
    const base = { action: 'start', project_id: projectId, mode: 'pomodoro', revision: 0, operation_id: crypto.randomUUID() };
    for (const invalid of [undefined, { ...settings, focus_minutes: 0 }, { ...settings, short_break_minutes: 181 }, { ...settings, long_break_every: 1.5 }]) {
      expect((await request('/timer', { ...base, pomodoro: invalid })).status).toBe(400);
    }
    expect((await request('/timer', { ...base, mode: 'normal', pomodoro: settings })).status).toBe(400);
    await start();
    await expect(env.DB.prepare('UPDATE timer_state SET focus_minutes = 0').run()).rejects.toThrow();
    await expect(env.DB.prepare('UPDATE timer_state SET deadline_at = deadline_at + 1000').run()).rejects.toThrow();
  });
});

describe('満了処理の競合・冪等性', () => {
  it('複数端末が別 API から同時に満了を処理しても1件だけ登録', async () => {
    const started = await start(); now += 60000;
    const responses = await Promise.all(['/timer', '/sessions', '/projects', '/health'].map((path) => request(path)));
    expect(responses.map((r) => r.status)).toEqual([200, 200, 200, 200]);
    expect(await sessions()).toHaveLength(1);
    expect((await status()).timer).toMatchObject({ revision: started.timer.revision + 1, completed_focus: 1 });
  });
  it('予定時刻で pause/finish が競合した場合は先に満了し、実績は二重保存されない', async () => {
    const started = await start();
    const pause = await makeCommand('pause', started); const finish = await makeCommand('finish', started);
    now = started.timer.deadline_at!;
    const responses = await Promise.all([request('/timer', pause), request('/timer', finish), request('/timer')]);
    expect(responses.slice(0, 2).map((r) => r.status)).toEqual([409, 409]);
    expect(await sessions()).toHaveLength(1);
    expect((await status()).timer.phase).toBe('short_break');
  });
  it('次フェーズ開始の再送は新しい期間を増やさず、古い再送は現在の期間を変更しない', async () => {
    await start(); now += 60000; await status();
    const nextBreak = await makeCommand('start_break');
    const breakStart = await execute(nextBreak);
    expect((await execute(nextBreak)).timer.timer_id).toBe(breakStart.timer.timer_id);
    await action('skip'); const next = await action('start_focus');
    expect((await execute(nextBreak)).timer.timer_id).toBe(next.timer.timer_id);
    expect(await sessions()).toHaveLength(1);
  });
  it('満了の状態更新が失敗した場合、実績 INSERT もロールバックする', async () => {
    const started = await start(); now += 60000;
    await env.DB.prepare("CREATE TRIGGER fail_expiry BEFORE UPDATE ON timer_state WHEN NEW.status = 'waiting' BEGIN SELECT RAISE(ABORT, 'simulated failure'); END;").run();
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect((await request('/timer')).status).toBe(500);
      expect((await env.DB.prepare('SELECT * FROM work_sessions').all()).results).toHaveLength(0);
      expect(await env.DB.prepare('SELECT revision, status FROM timer_state').first()).toEqual({ revision: started.timer.revision, status: 'running' });
    } finally { await env.DB.prepare('DROP TRIGGER fail_expiry').run(); log.mockRestore(); }
    await status(); expect(await sessions()).toHaveLength(1);
  });
});
