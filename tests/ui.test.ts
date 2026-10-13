// @vitest-environment happy-dom
import { createElement } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Timer from '../src/pages/Timer';
import Projects from '../src/pages/Projects';
import { pomodoroKey, loadPomodoro } from '../src/pomodoroSettings';
import type { PomodoroSettings, Project, TimerCommand, TimerSnapshot } from '../shared/contracts';

const project: Project = { id: 'a81cec60-b018-4c76-a70e-f8f7853f874b', name: '実装作業', category_id: 'uncategorized', color: '#175c50', archived: false };
const idle: TimerSnapshot = { server_now: 1800000000000, timer: { mode: 'normal', phase: null, completed_focus: 0, pomodoro: null, duration_ms: null, deadline_at: null, revision: 0, status: 'idle', timer_id: null, project_id: null, project_name: null, color: null, started_at: null, changed_at: null, paused_ms: 0 } };
const active: TimerSnapshot = { server_now: 1800000005000, timer: { ...idle.timer, revision: 1, status: 'running', timer_id: 'a81cec60-b018-4c76-a70e-f8f7853f874c', project_id: project.id, project_name: project.name, color: project.color, started_at: 1800000000000, changed_at: 1800000000000 } };
const json = (data: unknown) => new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } });
const mountTimer = () => render(createElement(MemoryRouter, null, createElement(Timer)));
beforeEach(() => { sessionStorage.clear(); localStorage.clear(); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('タイマー画面', () => {
  it('保存された一時停止状態を復元し、復帰時に再同期する', async () => {
    let snapshot: TimerSnapshot = { ...active, server_now: 1800000010000, timer: { ...active.timer, status: 'paused', changed_at: 1800000005000 } };
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => json(String(url) === '/api/timer' ? snapshot : { projects: [project] }));
    const view = mountTimer();
    await screen.findByRole('button', { name: '再開' });
    expect(screen.getByText('00:00:05', { selector: 'p' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '再開' })).toBeTruthy();
    view.unmount(); mountTimer();
    await screen.findByRole('button', { name: '再開' });
    snapshot = active;
    await act(async () => { window.dispatchEvent(new Event('pageshow')); });
    await screen.findByRole('button', { name: '一時停止' });
    expect(screen.getByRole('button', { name: '一時停止' })).toBeTruthy();
  });
  it('一時停止の通信待ちでは再送案内を表示せず、正常完了後も表示しない', async () => {
    let current = active;
    let resolvePause!: (response: Response) => void;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, options) => {
      if (String(url) !== '/api/timer') return json({ projects: [project] });
      if (options?.method !== 'POST') return json(current);
      return new Promise<Response>((resolve) => { resolvePause = resolve; });
    });
    mountTimer();
    fireEvent.click(await screen.findByRole('button', { name: '一時停止' }));
    await waitFor(() => expect((screen.getByRole('button', { name: '一時停止' }) as HTMLButtonElement).disabled).toBe(true));
    expect(screen.queryByText(/前の操作の結果を確認/)).toBeNull();
    expect(screen.queryByRole('button', { name: '送信結果を確認・再送' })).toBeNull();
    current = { ...active, timer: { ...active.timer, revision: 2, status: 'paused', changed_at: active.server_now } };
    await act(async () => { resolvePause(json({ ...current, outcome: { action: 'pause', session_id: null, discarded: false } })); });
    await screen.findByRole('button', { name: '再開' });
    expect(screen.queryByText(/前の操作の結果を確認/)).toBeNull();
    expect(screen.getByRole('button', { name: '再開' })).toBeTruthy();
  });
  it('終了確認をキャンセルすると終了 API を送信しない', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => json(String(url) === '/api/timer' ? active : { projects: [project] }));
    window.confirm = vi.fn(() => false);
    mountTimer(); await screen.findByRole('button', { name: '一時停止' });
    fireEvent.click(screen.getByRole('button', { name: '終了して保存' }));
    expect(fetchMock.mock.calls.some(([, options]) => options?.method === 'POST')).toBe(false);
    expect(screen.getByRole('button', { name: '一時停止' })).toBeTruthy();
  });
  it('終了確認を承認すると実績保存結果を表示する', async () => {
    let current = active;
    const commands: TimerCommand[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, options) => {
      if (String(url) !== '/api/timer') return json({ projects: [project] });
      if (options?.method !== 'POST') return json(current);
      commands.push(JSON.parse(options.body as string)); current = idle;
      return json({ ...idle, outcome: { action: 'finish', session_id: active.timer.timer_id, discarded: false } });
    });
    window.confirm = vi.fn(() => true);
    mountTimer(); await screen.findByRole('button', { name: '一時停止' });
    fireEvent.click(screen.getByRole('button', { name: '終了して保存' }));
    await screen.findByText('作業実績を保存しました。');
    expect(commands).toHaveLength(1);
    expect(commands[0]).toMatchObject({ action: 'finish', revision: active.timer.revision, timer_id: active.timer.timer_id });
    await screen.findByRole('button', { name: '開始' });
  });
  it('応答を失った開始をリロード後も同じ操作 ID で再送する', async () => {
    let current = idle;
    const commands: TimerCommand[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, options) => {
      if (String(url) !== '/api/timer') return json({ projects: [project] });
      if (options?.method !== 'POST') return json(current);
      commands.push(JSON.parse(options.body as string)); current = active;
      if (commands.length === 1) throw new TypeError('response lost');
      return json({ ...active, outcome: { action: 'start', session_id: null, discarded: false } });
    });
    const view = mountTimer();
    const start = await screen.findByRole('button', { name: '開始' });
    await waitFor(() => expect((start as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(start);
    await screen.findByRole('button', { name: '送信結果を確認・再送' });
    await waitFor(() => expect((screen.getByRole('button', { name: '送信結果を確認・再送' }) as HTMLButtonElement).disabled).toBe(false));
    expect(commands).toHaveLength(1);
    expect(commands[0].operation_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    view.unmount(); mountTimer();
    await screen.findByRole('button', { name: '一時停止' });
    expect((screen.getByRole('button', { name: '終了して保存' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: '送信結果を確認・再送' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: '送信結果を確認・再送' })).toBeNull());
    expect(commands).toHaveLength(2);
    expect(commands[1]).toEqual(commands[0]);
    expect(sessionStorage.length).toBe(0);
  });
});

describe('ポモドーロの設定と画面復元', () => {
  const defaults: PomodoroSettings = { focus_minutes: 25, short_break_minutes: 5, long_break_minutes: 15, long_break_every: 4 };
  const config: PomodoroSettings = { focus_minutes: 1, short_break_minutes: 2, long_break_minutes: 3, long_break_every: 2 };
  it('作業 A/B に別設定を保存し、切替・リロードで再読込できる', async () => {
    const second = { ...project, id: 'a81cec60-b018-4c76-a70e-f8f7853f874d', name: '別作業' };
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => json(String(url) === '/api/timer' ? idle : { projects: [project, second] }));
    const view = mountTimer();
    await screen.findByLabelText('作業');
    await waitFor(() => expect((screen.getByLabelText('作業') as unknown as HTMLSelectElement).value).toBe(project.id));
    fireEvent.click(screen.getByRole('button', { name: 'ポモドーロ' }));
    expect((screen.getByLabelText('集中（分）') as HTMLInputElement).value).toBe('25');
    fireEvent.change(screen.getByLabelText('集中（分）'), { target: { value: '35' } });
    expect(loadPomodoro(project.id).focus_minutes).toBe(35);
    fireEvent.change(screen.getByLabelText('作業'), { target: { value: second.id } });
    fireEvent.click(screen.getByRole('button', { name: 'ポモドーロ' }));
    await waitFor(() => expect((screen.getByLabelText('集中（分）') as HTMLInputElement).value).toBe('25'));
    fireEvent.change(screen.getByLabelText('集中（分）'), { target: { value: '45' } });
    expect(loadPomodoro(second.id).focus_minutes).toBe(45);
    fireEvent.change(screen.getByLabelText('作業'), { target: { value: project.id } });
    await waitFor(() => expect((screen.getByLabelText('集中（分）') as HTMLInputElement).value).toBe('35'));
    view.unmount(); mountTimer();
    await screen.findByLabelText('作業');
    await waitFor(() => expect((screen.getByLabelText('作業') as unknown as HTMLSelectElement).value).toBe(project.id));
    fireEvent.click(screen.getByRole('button', { name: 'ポモドーロ' }));
    await waitFor(() => expect((screen.getByLabelText('集中（分）') as HTMLInputElement).value).toBe('35'));
    expect(loadPomodoro(second.id).focus_minutes).toBe(45);
  });
  it('別端末の localStorage が違ってもサーバーの開始時設定で集中を表示', async () => {
    localStorage.setItem(pomodoroKey(project.id), JSON.stringify(defaults));
    const focused: TimerSnapshot = { ...active, timer: { ...active.timer, mode: 'pomodoro', phase: 'focus', pomodoro: config, duration_ms: 60000, deadline_at: active.timer.started_at! + 60000 } };
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => json(String(url) === '/api/timer' ? focused : { projects: [project] }));
    mountTimer(); await screen.findByRole('timer');
    expect(screen.queryByLabelText('集中（分）')).toBeNull();
    expect(screen.getByRole('timer').textContent).toBe('00:55');
    expect(loadPomodoro(project.id)).toEqual(defaults);
  });
  it('自動移行後の休憩を表示し、次フェーズの開始ボタンを要求しない', async () => {
    const current: TimerSnapshot = { ...active, timer: { ...active.timer, mode: 'pomodoro', phase: 'short_break', pomodoro: config, completed_focus: 1, started_at: active.server_now, changed_at: active.server_now, duration_ms: 120000, deadline_at: active.server_now + 120000 } };
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => json(String(url) === '/api/timer' ? current : { projects: [project] }));
    mountTimer(); await screen.findByRole('timer');
    expect(screen.queryByRole('button', { name: '短い休憩を開始' })).toBeNull();
    expect(screen.getByRole('button', { name: '休憩をスキップ' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'ポモドーロを終了' })).toBeTruthy();
  });
  it('不正・破損した保存設定は初期値を使い、不正な入力では開始できない', async () => {
    localStorage.setItem(pomodoroKey(project.id), '{broken');
    expect(loadPomodoro(project.id)).toEqual(defaults);
    localStorage.setItem(pomodoroKey(project.id), JSON.stringify({ ...defaults, focus_minutes: 0 }));
    expect(loadPomodoro(project.id)).toEqual(defaults);
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => json(String(url) === '/api/timer' ? idle : { projects: [project] }));
    mountTimer(); fireEvent.click(await screen.findByRole('button', { name: 'ポモドーロ' }));
    fireEvent.change(screen.getByLabelText('集中（分）'), { target: { value: '0' } });
    expect((screen.getByRole('button', { name: '開始' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole('alert').textContent).toContain('整数');
  });
});

describe('作業管理画面', () => {
  it('アーカイブを保存し、保持された作業の解除操作を提供する', async () => {
    let projects = [project]; const updates: unknown[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, options) => {
      if (options?.method === 'PATCH') {
        const input = JSON.parse(options.body as string); updates.push(input);
        projects = [{ ...project, archived: input.archived }]; return json({ updated: true });
      }
      return json(String(url) === '/api/categories' ? { categories: [{ id: 'uncategorized', name: '未分類' }] } : { projects });
    });
    render(createElement(Projects));
    fireEvent.click(await screen.findByRole('button', { name: 'アーカイブする' }));
    await screen.findByRole('button', { name: 'アーカイブを解除' });
    expect(updates).toEqual([{ archived: true }]);
    expect(screen.getByRole('heading', { name: '実装作業（アーカイブ済み）' })).toBeTruthy();
  });
});

describe('タイマー方式と終了音', () => {
  it('作業別の方式を切り替え、再読込後も復元する', async () => {
    const other = { ...project, id: 'other', name: '別作業' };
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => json(String(url) === '/api/timer' ? idle : { projects: [project, other] }));
    const view = mountTimer();
    const select = await screen.findByRole('button', { name: 'ポモドーロ' });
    await waitFor(() => {
      expect((screen.getByLabelText('作業') as unknown as HTMLSelectElement).value).toBe(project.id);
      expect(select.closest('fieldset')?.disabled).toBe(false);
    });
    fireEvent.click(select);
    expect(select.getAttribute('aria-pressed')).toBe('true');
    fireEvent.change(screen.getByLabelText('作業'), { target: { value: other.id } });
    await waitFor(() => expect(select.getAttribute('aria-pressed')).toBe('false'));
    fireEvent.change(screen.getByLabelText('作業'), { target: { value: project.id } });
    await waitFor(() => expect(select.getAttribute('aria-pressed')).toBe('true'));
    view.unmount(); mountTimer();
    await waitFor(() => expect(screen.getByRole('button', { name: 'ポモドーロ' }).getAttribute('aria-pressed')).toBe('true'));
  });
  it.each(['focus', 'short_break', 'long_break'] as const)('%s の満了遷移では一度だけ鳴らし、再取得では鳴らさない', async (phase) => {
    const { TimerSound } = await import('../src/timerSound');
    const play = vi.spyOn(TimerSound.prototype, 'play').mockReturnValue(true);
    let current: TimerSnapshot = { ...active, timer: { ...active.timer, mode: 'pomodoro', phase,
      pomodoro: { focus_minutes: 1, short_break_minutes: 1, long_break_minutes: 1, long_break_every: 4 },
      duration_ms: 60000, deadline_at: active.timer.started_at! + 60000 } };
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => json(String(url) === '/api/timer' ? current : { projects: [project] }));
    mountTimer(); await screen.findByRole('timer');
    expect(play).not.toHaveBeenCalled();
    current = { ...current, timer: { ...current.timer, status: 'running', timer_id: crypto.randomUUID(), phase: phase === 'focus' ? 'short_break' : 'focus', changed_at: current.timer.deadline_at, deadline_at: current.timer.deadline_at! + 60000, started_at: current.timer.deadline_at } };
    await act(async () => { window.dispatchEvent(new Event('pageshow')); });
    await waitFor(() => expect(play).toHaveBeenCalledTimes(1));
    await act(async () => { window.dispatchEvent(new Event('pageshow')); });
    expect(play).toHaveBeenCalledTimes(1);
  });
});

describe('通常・ポモドーロ共通の専用画面', () => {
  const config = { focus_minutes: 1, short_break_minutes: 1, long_break_minutes: 2, long_break_every: 2 };
  it.each(['normal', 'focus', 'short_break', 'long_break'] as const)('%s を復元すると指定色と時間・アイコンだけを表示する', async (mode) => {
    const snapshot: TimerSnapshot = { ...active, timer: { ...active.timer,
      ...(mode === 'normal' ? {} : { mode: 'pomodoro', phase: mode, pomodoro: config, duration_ms: 60000, deadline_at: active.timer.started_at! + 60000 }) } };
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => json(String(url) === '/api/timer' ? snapshot : { projects: [project] }));
    const { default: App } = await import('../src/App');
    render(createElement(MemoryRouter, null, createElement(App)));
    const display = await screen.findByRole('timer');
    expect(display.textContent).toBe(mode === 'normal' ? '00:00:05' : '00:55');
    expect(display.closest('section')?.style.backgroundColor).toBe(mode === 'normal' ? '#253E49' : mode === 'focus' ? '#C94F45' : '#448A70');
    expect(screen.queryByRole('navigation')).toBeNull();
    expect(screen.queryByText('My Working Logger')).toBeNull();
    expect(screen.queryByText(project.name)).toBeNull();
    expect(screen.queryByText('経過時間')).toBeNull();
    expect(screen.queryByText('一時停止合計')).toBeNull();
    expect(screen.queryByText('集中中')).toBeNull();
    expect(screen.queryByRole('button', { name: '終了音を確認' })).toBeNull();
    expect(display.closest('section')?.textContent).toBe(display.textContent);
    expect(screen.getAllByRole('button')).toHaveLength(mode.includes('break') ? 3 : 2);
  });
  it.each(['normal', 'pomodoro'] as const)('%s の開始・停止・再開・終了を操作し、終了後にナビゲーションを戻す', async (mode) => {
    let current = idle; const commands: TimerCommand[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, options) => {
      if (String(url) !== '/api/timer') return json({ projects: [project] });
      if (options?.method !== 'POST') return json(current);
      const command: TimerCommand = JSON.parse(options.body as string); commands.push(command);
      current = command.action === 'finish' ? idle : command.action === 'start'
        ? { ...active, timer: { ...active.timer, ...(mode === 'pomodoro' ? { mode, phase: 'focus', pomodoro: config, duration_ms: 60000, deadline_at: active.timer.started_at! + 60000 } : {}) } }
        : { ...current, timer: { ...current.timer, revision: current.timer.revision + 1, status: command.action === 'pause' ? 'paused' : 'running', changed_at: current.server_now } };
      return json({ ...current, outcome: { action: command.action, session_id: command.action === 'finish' ? active.timer.timer_id : null, discarded: false } });
    });
    const { default: App } = await import('../src/App');
    window.confirm = vi.fn(() => false);
    render(createElement(MemoryRouter, null, createElement(App)));
    await screen.findByLabelText('作業');
    if (mode === 'pomodoro') fireEvent.click(screen.getByRole('button', { name: 'ポモドーロ' }));
    fireEvent.click(screen.getByRole('button', { name: '開始' }));
    const display = await screen.findByRole('timer');
    const color = display.closest('section')?.style.backgroundColor;
    expect(screen.queryByRole('navigation')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '一時停止' }));
    await screen.findByRole('button', { name: '再開' });
    expect(screen.getByRole('timer').closest('section')?.style.backgroundColor).toBe(color);
    fireEvent.click(screen.getByRole('button', { name: '再開' }));
    await screen.findByRole('button', { name: '一時停止' });
    const finish = screen.getByRole('button', { name: mode === 'pomodoro' ? 'ポモドーロを終了' : '終了して保存' });
    fireEvent.click(finish);
    expect(commands.map(c => c.action)).toEqual(['start', 'pause', 'resume']);
    expect(screen.getByRole('timer')).toBeTruthy();
    window.confirm = vi.fn(() => true); fireEvent.click(finish);
    await screen.findByText('作業実績を保存しました。');
    expect(screen.getByRole('navigation')).toBeTruthy();
    expect(screen.queryByRole('timer')).toBeNull();
    expect(commands.map(c => c.action)).toEqual(['start', 'pause', 'resume', 'finish']);
  });
  it('自動フェーズ切替と休憩スキップで色・時間・操作が更新される', async () => {
    let current: TimerSnapshot = { ...active, timer: { ...active.timer, mode: 'pomodoro', phase: 'focus', pomodoro: config, duration_ms: 60000, deadline_at: active.timer.started_at! + 60000 } };
    const commands: TimerCommand[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, options) => {
      if (String(url) !== '/api/timer') return json({ projects: [project] });
      if (options?.method !== 'POST') return json(current);
      const command: TimerCommand = JSON.parse(options.body as string); commands.push(command);
      current = { ...current, timer: { ...current.timer, revision: current.timer.revision + 1, phase: 'focus', started_at: current.server_now, changed_at: current.server_now, deadline_at: current.server_now + 60000 } };
      return json({ ...current, outcome: { action: command.action, session_id: null, discarded: false } });
    });
    mountTimer(); await screen.findByRole('timer');
    expect(screen.queryByRole('button', { name: '休憩をスキップ' })).toBeNull();
    current = { ...current, server_now: active.server_now + 60000, timer: { ...current.timer, revision: 2, phase: 'short_break', started_at: active.server_now + 60000, changed_at: active.server_now + 60000, deadline_at: active.server_now + 120000 } };
    await act(async () => { window.dispatchEvent(new Event('pageshow')); });
    await screen.findByRole('button', { name: '休憩をスキップ' });
    expect(screen.getByRole('timer').closest('section')?.style.backgroundColor).toBe('#448A70');
    expect(screen.getByRole('timer').textContent).toBe('01:00');
    fireEvent.click(screen.getByRole('button', { name: '休憩をスキップ' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: '休憩をスキップ' })).toBeNull());
    expect(screen.getByRole('timer').closest('section')?.style.backgroundColor).toBe('#C94F45');
    expect(commands[0].action).toBe('skip');
  });
});
