// @vitest-environment happy-dom
import { createElement } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Timer from '../src/pages/Timer';
import Projects from '../src/pages/Projects';
import { TimerSound } from '../src/timerSound';
import { timerStorageKey, startLocalTimer, emptyLocalTimer, writeLocalTimer } from '../src/localTimer';
import type { Project } from '../shared/contracts';

const project: Project = { id: 'a81cec60-b018-4c76-a70e-f8f7853f874b', name: '実装作業', category_id: 'uncategorized', color: '#175c50', archived: false };
const json = (data: unknown) => new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } });
const mountTimer = () => render(createElement(MemoryRouter, null, createElement(Timer)));
beforeEach(() => { sessionStorage.clear(); localStorage.clear(); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });
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

describe('ローカルタイマー画面', () => {
  it.each(['タイマー', 'ポモドーロ'])('%s の開始前は選択・設定・開始だけを表示し、操作中に音声を有効化する', async (mode) => {
    const enable = vi.spyOn(TimerSound.prototype, 'enable').mockImplementation(() => new Promise(() => {}));
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => json({ projects: [project] }));
    mountTimer();
    await waitFor(() => expect((screen.getByRole('button', { name: '開始' }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole('button', { name: mode }));
    expect(screen.queryByRole('timer')).toBeNull();
    expect(screen.queryByText('00:00:00')).toBeNull();
    expect(screen.queryByText(/ブラウザを閉じても|終了音|スリープ/)).toBeNull();
    expect(enable).not.toHaveBeenCalled();
    if (mode === 'ポモドーロ') expect(screen.getByLabelText('集中（分）')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '開始' }));
    expect(enable).toHaveBeenCalledTimes(mode === 'ポモドーロ' ? 1 : 0);
    expect(screen.getByRole('region', { name: mode === 'ポモドーロ' ? 'ポモドーロタイマー' : mode })).toBeTruthy();
    expect(screen.queryByText(/終了音/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '一時停止' }));
    fireEvent.click(screen.getByRole('button', { name: '再開' }));
    expect(enable).toHaveBeenCalledTimes(mode === 'ポモドーロ' ? 3 : 0);
    expect(screen.getByRole('button', { name: '一時停止' })).toBeTruthy();
  });
  it('自動満了では音声を再生成せず、休憩スキップでは再生成する', async () => {
    vi.useFakeTimers();
    const enable = vi.spyOn(TimerSound.prototype, 'enable').mockResolvedValue(true);
    const play = vi.spyOn(TimerSound.prototype, 'play').mockReturnValue(true);
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => json({ projects: [project] }));
    writeLocalTimer(startLocalTimer(emptyLocalTimer(), project, 'pomodoro', { focus_minutes: 1, short_break_minutes: 1, long_break_minutes: 1, long_break_every: 2 }, Date.now()));
    mountTimer();
    await act(async () => { await vi.advanceTimersByTimeAsync(60000); });
    expect(play).toHaveBeenCalledTimes(1);
    expect(enable).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '休憩をスキップ' }));
    expect(enable).toHaveBeenCalledTimes(1);
  });
  it('通常タイマーの終了時は音を鳴らさず実績を保存する', async () => {
    const play = vi.spyOn(TimerSound.prototype, 'play').mockReturnValue(false);
    writeLocalTimer(startLocalTimer(emptyLocalTimer(), project, 'normal', { focus_minutes: 1, short_break_minutes: 1, long_break_minutes: 1, long_break_every: 1 }, Date.now() - 10000));
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => json(String(url) === '/api/projects' ? { projects: [project] } : { saved: true }));
    window.confirm = vi.fn(() => true);
    mountTimer();
    fireEvent.click(screen.getByRole('button', { name: '終了して保存' }));
    await screen.findByText('作業実績を保存しました。');
    expect(play).not.toHaveBeenCalled();
    expect(fetchMock.mock.calls.some(([, options]) => options?.method === 'POST')).toBe(true);
    expect(screen.queryByRole('timer')).toBeNull();
  });
  it('開始・一時停止・再開は通信を待たず切替、リロードで復元', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => json({ projects: [project] }));
    const view = mountTimer();
    await waitFor(() => expect((screen.getByRole('button', { name: '開始' }) as HTMLButtonElement).disabled).toBe(false));
    fetchMock.mockClear();
    fireEvent.click(screen.getByRole('button', { name: '開始' }));
    expect(screen.getByRole('button', { name: '一時停止' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '一時停止' }));
    expect(screen.getByRole('button', { name: '再開' })).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
    view.unmount(); mountTimer();
    await screen.findByRole('button', { name: '再開' });
    fireEvent.click(screen.getByRole('button', { name: '再開' }));
    expect(screen.getByRole('button', { name: '一時停止' })).toBeTruthy();
  });
  it('満了復元は00:00で停止し操作して次へ進む', async () => {
    writeLocalTimer(startLocalTimer(emptyLocalTimer(), project, 'pomodoro', { focus_minutes: 1, short_break_minutes: 2, long_break_minutes: 3, long_break_every: 2 }, Date.now() - 120000));
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => json({ projects: [project] }));
    mountTimer();
    expect(screen.getByRole('timer').textContent).toBe('00:00');
    expect(screen.getByLabelText('サイクル内の集中回数').textContent).toBe('1 / 2');
    fireEvent.click(screen.getByRole('button', { name: '次のフェーズを開始' }));
    expect(screen.getByRole('timer').textContent).toBe('02:00');
    expect(screen.getByRole('button', { name: '休憩をスキップ' })).toBeTruthy();
  });
  it('保存失敗後も終了し、リロード後同じ実績IDで再送', async () => {
    writeLocalTimer(startLocalTimer(emptyLocalTimer(), project, 'normal', { focus_minutes: 1, short_break_minutes: 1, long_break_minutes: 1, long_break_every: 1 }, Date.now() - 10000));
    const records: unknown[] = []; let fail = true;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, options) => {
      if (String(url) === '/api/projects') return json({ projects: [project] });
      records.push(JSON.parse(options!.body as string));
      if (fail) throw new TypeError('offline'); return json({ saved: true });
    });
    window.confirm = vi.fn(() => true);
    const view = mountTimer();
    fireEvent.click(screen.getByRole('button', { name: '終了して保存' }));
    await screen.findByText(/未保存の実績が 1 件/);
    await screen.findByText(/通信できません/);
    expect(screen.queryByRole('timer')).toBeNull();
    view.unmount(); fail = false; mountTimer();
    await screen.findByText('作業実績を保存しました。');
    expect(records).toHaveLength(2); expect(records[1]).toEqual(records[0]);
    expect(localStorage.getItem(timerStorageKey)).toBeNull();
  });
  it('ストレージ書込み失敗時は開始を確定しない', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => json({ projects: [project] }));
    mountTimer();
    await waitFor(() => expect((screen.getByRole('button', { name: '開始' }) as HTMLButtonElement).disabled).toBe(false));
    const storage = localStorage;
    vi.stubGlobal('localStorage', { getItem: storage.getItem.bind(storage), removeItem: storage.removeItem.bind(storage), setItem: () => { throw new Error('quota'); } });
    fireEvent.click(screen.getByRole('button', { name: '開始' }));
    expect(screen.queryByRole('timer')).toBeNull();
    expect(screen.getByRole('alert').textContent).toContain('操作は確定していません');
  });
  it('破損情報は保護し開始を無効化', async () => {
    localStorage.setItem(timerStorageKey, '{');
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => json({ projects: [project] }));
    mountTimer();
    await screen.findByRole('alert');
    expect((screen.getByRole('button', { name: '開始' }) as HTMLButtonElement).disabled).toBe(true);
    expect(localStorage.getItem(timerStorageKey)).toBe('{');
  });
});
describe('表示中の満了と復帰時の満了', () => {
  const settings = { focus_minutes: 1, short_break_minutes: 1, long_break_minutes: 1, long_break_every: 2 };
  it('表示中は集中→短休憩へ自動で進み、満了音は1回', async () => {
    const { TimerSound } = await import('../src/timerSound');
    const play = vi.spyOn(TimerSound.prototype, 'play').mockReturnValue(true);
    vi.useFakeTimers(); vi.setSystemTime(1800000000000);
    writeLocalTimer(startLocalTimer(emptyLocalTimer(), project, 'pomodoro', settings, Date.now()));
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => json({ projects: [project] }));
    mountTimer();
    await act(async () => { vi.advanceTimersByTime(60000); });
    expect(screen.getByRole('timer').textContent).toBe('01:00');
    expect(screen.getByRole('button', { name: '休憩をスキップ' })).toBeTruthy();
    expect(play).toHaveBeenCalledTimes(1);
  });
  it('音声失敗後も複数フェーズを進め、サイクル実績を保存する', async () => {
    const play = vi.spyOn(TimerSound.prototype, 'play').mockReturnValue(false);
    vi.useFakeTimers(); vi.setSystemTime(1800000000000);
    writeLocalTimer(startLocalTimer(emptyLocalTimer(), project, 'pomodoro', settings, Date.now()));
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => json(String(url) === '/api/projects' ? { projects: [project] } : { saved: true }));
    mountTimer();
    await act(async () => { vi.advanceTimersByTime(180000); });
    expect(play).toHaveBeenCalledTimes(3);
    expect(screen.getByLabelText('サイクル内の集中回数').textContent).toBe('2 / 2');
    expect(fetchMock.mock.calls.filter(([, options]) => options?.method === 'POST')).toHaveLength(1);
    expect(JSON.parse(localStorage.getItem(timerStorageKey)!).timer.phase).toBe('long_break');
  });
  it('非表示中の満了は復帰時に00:00で停止し、次を自動開始しない', async () => {
    vi.useFakeTimers(); vi.setSystemTime(1800000000000);
    writeLocalTimer(startLocalTimer(emptyLocalTimer(), project, 'pomodoro', settings, Date.now()));
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => json({ projects: [project] }));
    mountTimer();
    const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')); vi.advanceTimersByTime(120000); });
    hidden.mockReturnValue(false);
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
    expect(screen.getByRole('timer').textContent).toBe('00:00');
    expect(screen.getByRole('button', { name: '次のフェーズを開始' })).toBeTruthy();
    await act(async () => { vi.advanceTimersByTime(60000); });
    expect(screen.getByRole('timer').textContent).toBe('00:00');
  });
  it('表示中でもJSが長く停止した後は満了停止にする', async () => {
    vi.useFakeTimers(); vi.setSystemTime(1800000000000);
    writeLocalTimer(startLocalTimer(emptyLocalTimer(), project, 'pomodoro', settings, Date.now()));
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => json({ projects: [project] }));
    mountTimer(); vi.setSystemTime(1800000120000);
    await act(async () => { vi.advanceTimersByTime(250); });
    expect(screen.getByRole('timer').textContent).toBe('00:00');
  });
  it('前実績の送信中に開始したタイマーを保存応答で消さない', async () => {
    writeLocalTimer(startLocalTimer(emptyLocalTimer(), project, 'normal', settings, Date.now() - 10000));
    let resolve!: (response: Response) => void;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => String(url) === '/api/projects'
      ? json({ projects: [project] }) : new Promise<Response>((r) => { resolve = r; }));
    window.confirm = vi.fn(() => true);
    mountTimer(); await act(async () => {});
    fireEvent.click(screen.getByRole('button', { name: '終了して保存' }));
    fireEvent.click(screen.getByRole('button', { name: '開始' }));
    expect(screen.getByRole('timer')).toBeTruthy();
    await act(async () => { resolve(json({ saved: true })); });
    expect(screen.getByRole('timer')).toBeTruthy();
    expect(JSON.parse(localStorage.getItem(timerStorageKey)!).pending).toHaveLength(0);
    expect(JSON.parse(localStorage.getItem(timerStorageKey)!).timer.status).toBe('running');
  });
});
describe('設定・確認・サイクル表示', () => {
  it('作業別設定・モードをリロードで維持する', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => json({ projects: [project] }));
    const view = mountTimer();
    await waitFor(() => expect((screen.getByRole('button', { name: '開始' }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole('button', { name: 'ポモドーロ' }));
    fireEvent.change(screen.getByLabelText('集中（分）'), { target: { value: '35' } });
    view.unmount(); mountTimer();
    await screen.findByLabelText('集中（分）');
    expect((screen.getByLabelText('集中（分）') as HTMLInputElement).value).toBe('35');
  });
  it('終了確認のキャンセルで状態・実績を変更しない', async () => {
    writeLocalTimer(startLocalTimer(emptyLocalTimer(), project, 'normal', { focus_minutes: 1, short_break_minutes: 1, long_break_minutes: 1, long_break_every: 2 }, Date.now() - 10000));
    const saved = localStorage.getItem(timerStorageKey);
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => json({ projects: [project] }));
    window.confirm = vi.fn(() => false); mountTimer();
    fireEvent.click(screen.getByRole('button', { name: '終了して保存' }));
    expect(JSON.parse(localStorage.getItem(timerStorageKey)!)).toEqual(JSON.parse(saved!));
    expect(fetchMock.mock.calls.some(([, options]) => options?.method === 'POST')).toBe(false);
  });
  it.each([
    ['focus', 'running', 0, '1 / 4'], ['focus', 'paused', 2, '3 / 4'],
    ['focus', 'expired', 3, '3 / 4'], ['short_break', 'running', 3, '3 / 4'],
    ['long_break', 'running', 4, '4 / 4'],
  ] as const)('%s %s の回数を表示する', async (phase, status, completed, expected) => {
    const { default: ActiveTimer } = await import('../src/components/ActiveTimer');
    const timer = startLocalTimer(emptyLocalTimer(), project, 'pomodoro', { focus_minutes: 1, short_break_minutes: 1, long_break_minutes: 1, long_break_every: 4 }, Date.now()).timer!;
    render(createElement(ActiveTimer, { timer: { ...timer, phase, status, completed_focus: completed }, milliseconds: 60000,
      disabled: false, busy: false, error: '', pending: false, onAction: vi.fn(), onRefresh: vi.fn(), onRetry: vi.fn() }));
    expect(screen.getByLabelText('サイクル内の集中回数').textContent).toBe(expected);
  });
});
