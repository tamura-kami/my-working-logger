// @vitest-environment happy-dom
import { createElement } from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ActiveTimer from '../src/components/ActiveTimer';
import { beginNext, emptyLocalTimer, expireLocalTimer, pauseLocalTimer, readLocalTimer,
  resumeLocalTimer, startLocalTimer, writeLocalTimer, type LocalTimer } from '../src/localTimer';
import { remainingTime } from '../shared/timing';
const project = { id: 'a81cec60-b018-4c76-a70e-f8f7853f874b', name: '作業', color: '#175c50', category_id: 'uncategorized', archived: false };
const settings = (count: number) => ({ focus_minutes: 1, short_break_minutes: 1, long_break_minutes: 1, long_break_every: count });
const element = (value: LocalTimer) => createElement(ActiveTimer, {
  timer: value.timer!, milliseconds: remainingTime(value.timer!, value.timer!.changed_at!) ?? 0,
  disabled: false, busy: false, error: '', pending: false,
  onAction: vi.fn(), onRefresh: vi.fn(), onRetry: vi.fn(),
});
beforeEach(() => localStorage.clear());
afterEach(cleanup);
describe('issue #13 サイクル内の集中回数', () => {
  it.each([1, 3, 4])('%i回設定で集中・休憩・次サイクルを表示し、停止・再開・再読込でも維持', (count) => {
    let value = startLocalTimer(emptyLocalTimer(), project, 'pomodoro', settings(count), 100000);
    const view = render(element(value));
    const check = (numerator: number) => {
      view.rerender(element(value));
      const progress = screen.getByLabelText('サイクル内の集中回数');
      expect(progress.textContent).toBe(`${numerator} / ${count}`);
      // 残り時間の直下に数字だけを置き、別の説明・進捗表示は増やさない。
      expect(screen.getByRole('timer').nextElementSibling).toBe(progress);
      expect(screen.queryByRole('progressbar')).toBeNull();
    };
    for (let focus = 1; focus <= count; focus++) {
      expect(value.timer!.phase).toBe('focus'); check(focus);
      value = pauseLocalTimer(value, value.timer!.changed_at! + 10000); check(focus);
      writeLocalTimer(value); value = readLocalTimer(); check(focus);
      value = resumeLocalTimer(value, value.timer!.changed_at! + 5000); check(focus);
      value = expireLocalTimer(value, value.timer!.deadline_at!, true);
      expect(value.timer!.phase).toBe(focus === count ? 'long_break' : 'short_break'); check(focus);
      writeLocalTimer(value); value = readLocalTimer(); check(focus);
      value = expireLocalTimer(value, value.timer!.deadline_at!, true);
    }
    expect(value.timer!.phase).toBe('focus'); check(1);
  });
  it('満了停止中は完了した回数、次フェーズ開始後は現在の回数を表示', () => {
    let value = startLocalTimer(emptyLocalTimer(), project, 'pomodoro', settings(4), 100000);
    value = expireLocalTimer(value, 999999, false);
    const view = render(element(value));
    expect(screen.getByLabelText('サイクル内の集中回数').textContent).toBe('1 / 4');
    value = beginNext(value, 999999); view.rerender(element(value));
    expect(screen.getByLabelText('サイクル内の集中回数').textContent).toBe('1 / 4');
    value = expireLocalTimer(value, value.timer!.deadline_at!, false);
    value = beginNext(value, value.timer!.changed_at!); view.rerender(element(value));
    expect(screen.getByLabelText('サイクル内の集中回数').textContent).toBe('2 / 4');
  });
  it('通常タイマーには回数表示を追加しない', () => {
    render(element(startLocalTimer(emptyLocalTimer(), project, 'normal', settings(4), 100000)));
    expect(screen.queryByLabelText('サイクル内の集中回数')).toBeNull();
    expect(screen.getByRole('timer').nextElementSibling).toBeNull();
    expect(screen.getByRole('timer').getAttribute('aria-label')).toBe('実作業時間');
  });
});
