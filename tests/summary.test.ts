// @vitest-environment happy-dom
import { createElement } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import Summary from '../src/pages/Summary';
import { sessionDate, dateStart } from '../shared/sessionTime';
const json = (data: unknown) => new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } });
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
it('時間に沿う配置と固定休憩帯、重複警告、編集・削除と日付切替', async () => {
  vi.spyOn(HTMLDialogElement.prototype, 'showModal').mockImplementation(function (this: HTMLDialogElement) { this.open = true; });
  const start = dateStart(sessionDate(Date.now()));
  let sessions = [{ id: 'a', project_id: 'p', project_name: '開発', color: '#123456', started_at: start + 9 * 3600000, ended_at: start + 10 * 3600000, paused_ms: 60000, active_seconds: 3540 }];
  const mock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, options) => {
    if (options?.method === 'PATCH') { sessions = [{ ...sessions[0], ...JSON.parse(options.body as string) }]; return json({ updated: true }); }
    if (options?.method === 'DELETE') { sessions = []; return json({ deleted: true }); }
    if (String(url).includes('overlap_start')) return json({ sessions: [...sessions, { ...sessions[0], id: 'other', project_name: '読書' }] });
    return json({ sessions });
  });
  const view = render(createElement(Summary));
  const block = await screen.findByRole('button', { name: /^開発 .*実作業.*休憩合計/ });
  expect(block.style.top).toBe('37.5%'); expect(Number.parseFloat(block.style.height)).toBeCloseTo(100 / 24);
  expect(block.lastElementChild?.textContent).toBe('休憩: 00:01');
  fireEvent.click(block);
  await screen.findByText('時間の重なりがあります');
  fireEvent.change(screen.getByLabelText('休憩合計（HH:MM）'), { target: { value: '01:00' } });
  expect((screen.getByRole('button', { name: '保存' }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.change(screen.getByLabelText('休憩合計（HH:MM）'), { target: { value: '00:00' } });
  await waitFor(() => expect((screen.getByRole('button', { name: '保存' }) as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(screen.getByRole('button', { name: '保存' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(mock.mock.calls.some(([, o]) => o?.method === 'PATCH' && JSON.parse(o.body as string).paused_ms === 0)).toBe(true);
  const updated = await screen.findByRole('button', { name: /^開発 .*実作業/ });
  expect(updated.textContent).not.toContain('休憩合計');
  fireEvent.click(updated);
  vi.stubGlobal('confirm', vi.fn(() => true));
  fireEvent.click(screen.getByRole('button', { name: '削除' }));
  await screen.findByText('この日の実績はありません。');
  fireEvent.click(screen.getByRole('button', { name: '前の日' }));
  await waitFor(() => expect(mock.mock.calls.at(-1)?.[0]).toContain('/api/sessions?date='));
  view.unmount();
});
it('日跨ぎ実績を各日に区切って表示し、全実作業時間と回数は開始日にのみ計上する', async () => {
  const day = sessionDate(Date.now());
  const start = dateStart(day);
  const session = { id: 'cross', project_id: 'p', project_name: '夜間作業', color: '#123456', started_at: start + 23 * 3600000, ended_at: start + 25 * 3600000, paused_ms: 60000, active_seconds: 7140 };
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () => json({ sessions: [session] }));
  render(createElement(Summary));
  const first = await screen.findByRole('button', { name: /^夜間作業 / });
  expect(Number.parseFloat(first.style.top)).toBeCloseTo(23 / 24 * 100);
  expect(Number.parseFloat(first.style.height)).toBeCloseTo(100 / 24);
  expect(screen.getByText('実作業 01:59', { selector: 'strong' })).toBeTruthy();
  expect(screen.getByText('作業セッション 1回')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '次の日' }));
  const second = await screen.findByRole('button', { name: /^夜間作業 / });
  expect(second.style.top).toBe('0%');
  expect(Number.parseFloat(second.style.height)).toBeCloseTo(100 / 24);
  expect(second.textContent).toContain(day);
  expect(screen.getByText('実作業 00:00', { selector: 'strong' })).toBeTruthy();
  expect(screen.getByText('作業セッション 0回')).toBeTruthy();
  vi.spyOn(HTMLDialogElement.prototype, 'showModal').mockImplementation(function (this: HTMLDialogElement) { this.open = true; });
  fireEvent.click(second);
  expect((screen.getByLabelText('開始（日本時間）') as HTMLInputElement).value).toContain(`${day}T23:00`);
});
it('1分未満は00:00と表示し、編集せず保存しても元の秒を保持する', async () => {
  vi.spyOn(HTMLDialogElement.prototype, 'showModal').mockImplementation(function (this: HTMLDialogElement) { this.open = true; });
  const start = dateStart(sessionDate(Date.now())) + 9 * 3600000 + 10000;
  const session = { id: 'short', project_id: 'p', project_name: '短い作業', color: '#123456', started_at: start, ended_at: start + 30000, paused_ms: 500, active_seconds: 29 };
  const mock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, options) => {
    if (options?.method === 'PATCH') return json({ updated: true });
    return json({ sessions: String(url).includes('overlap_start') ? [] : [session] });
  });
  render(createElement(Summary));
  const block = await screen.findByRole('button', { name: '短い作業 09:00 〜 09:00 実作業 00:00 休憩合計 00:00' });
  expect(block.lastElementChild?.textContent).toBe('休憩: 00:00');
  fireEvent.click(block);
  expect((screen.getByLabelText('開始（日本時間）') as HTMLInputElement).value).toMatch(/T09:00$/);
  expect((screen.getByLabelText('休憩合計（HH:MM）') as HTMLInputElement).value).toBe('00:00');
  await waitFor(() => expect((screen.getByRole('button', { name: '保存' }) as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(screen.getByRole('button', { name: '保存' }));
  await waitFor(() => expect(mock.mock.calls.some(([, o]) => o?.method === 'PATCH')).toBe(true));
  const saved = mock.mock.calls.find(([, o]) => o?.method === 'PATCH')![1]!;
  expect(JSON.parse(saved.body as string)).toEqual({ started_at: start, ended_at: start + 30000, paused_ms: 500 });
});
