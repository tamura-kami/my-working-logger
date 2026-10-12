// @vitest-environment happy-dom
import { createElement } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Timer from '../src/pages/Timer';
import Projects from '../src/pages/Projects';
import type { Project, TimerCommand, TimerSnapshot } from '../shared/contracts';

const project: Project = { id: 'a81cec60-b018-4c76-a70e-f8f7853f874b', name: '実装作業', category_id: 'uncategorized', color: '#175c50', archived: false };
const idle: TimerSnapshot = { server_now: 1800000000000, timer: { revision: 0, status: 'idle', timer_id: null, project_id: null, project_name: null, color: null, started_at: null, changed_at: null, paused_ms: 0 } };
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
    await screen.findByText('一時停止中');
    expect(screen.getByText('00:00:05', { selector: 'p' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '再開' })).toBeTruthy();
    view.unmount(); mountTimer();
    await screen.findByText('一時停止中');
    snapshot = active;
    await act(async () => { window.dispatchEvent(new Event('pageshow')); });
    await screen.findByText('計測中');
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
    await screen.findByText('一時停止中');
    expect(screen.queryByText(/前の操作の結果を確認/)).toBeNull();
    expect(screen.getByRole('button', { name: '再開' })).toBeTruthy();
  });
  it('終了確認をキャンセルすると終了 API を送信しない', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => json(String(url) === '/api/timer' ? active : { projects: [project] }));
    window.confirm = vi.fn(() => false);
    mountTimer(); await screen.findByText('計測中');
    fireEvent.click(screen.getByRole('button', { name: '終了して保存' }));
    expect(fetchMock.mock.calls.some(([, options]) => options?.method === 'POST')).toBe(false);
    expect(screen.getByText('計測中')).toBeTruthy();
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
    mountTimer(); await screen.findByText('計測中');
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
    await screen.findByText('計測中');
    expect((screen.getByRole('button', { name: '終了して保存' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: '送信結果を確認・再送' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: '送信結果を確認・再送' })).toBeNull());
    expect(commands).toHaveLength(2);
    expect(commands[1]).toEqual(commands[0]);
    expect(sessionStorage.length).toBe(0);
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
