import { describe, expect, it } from 'vitest';
import { cycleDurations, durations, formatDuration, remainingTime } from '../shared/timing';
import type { TimerState } from '../shared/contracts';
const running: TimerState = { mode: 'normal', phase: null, completed_focus: 0, pomodoro: null, duration_ms: null, deadline_at: null, revision: 1, timer_id: 'test', project_id: 'test', project_name: '作業', color: '#123456', status: 'running', started_at: 1000, changed_at: 5000, paused_ms: 1000 };
describe('表示時間の復元', () => {
  it('tick 回数に依存せず、再開後の時刻差から実作業を表示', () => {
    expect(durations(running, 10000)).toEqual({ active: 8000, elapsed: 9000, paused: 1000 });
  });
  it('一時停止中は実作業だけ停止し、休止時間が増える', () => {
    const paused = { ...running, status: 'paused' as const };
    expect(durations(paused, 10000)).toEqual({ active: 3000, elapsed: 9000, paused: 6000 });
    expect(durations(paused, 20000).active).toBe(3000);
  });
  it('負の時間を防ぎ、24時間超と秒未満の切り捨てを表示', () => {
    expect(durations(running, 0)).toEqual({ active: 3000, elapsed: 4000, paused: 1000 });
    expect(formatDuration(90061999)).toBe('25:01:01');
    expect(formatDuration(-1)).toBe('00:00:00');
  });
});

describe('ポモドーロ表示時間', () => {
  const focused: TimerState = { ...running, mode: 'pomodoro', phase: 'focus', duration_ms: 60000, deadline_at: 62000, pomodoro: { focus_minutes: 1, short_break_minutes: 1, long_break_minutes: 2, long_break_every: 2 } };
  it('再開と休止時の残り時間を時刻差で復元し、0未満にならない', () => {
    expect(remainingTime(focused, 10000)).toBe(52000);
    expect(remainingTime({ ...focused, status: 'paused', deadline_at: null }, 10000)).toBe(57000);
    expect(remainingTime({ ...focused, status: 'paused', deadline_at: null }, 1000000)).toBe(57000);
    expect(remainingTime(focused, 1000000)).toBe(0);
  });
  it('開始待ちでは設定した期間を表示し、通常タイマーには残り時間がない', () => {
    expect(remainingTime({ ...focused, status: 'waiting', started_at: null }, 1000000)).toBe(60000);
    expect(remainingTime(running, 10000)).toBeNull();
  });
});

it('サイクルの集中合計と休止時間を表示し、残り時間は現在フェーズだけから求める', () => {
  const timer: TimerState = { ...running, mode: 'pomodoro', phase: 'short_break', started_at: 61000,
    changed_at: 61000, paused_ms: 0, duration_ms: 120000, deadline_at: 181000,
    cycle_started_at: 1000, cycle_active_ms: 60000 };
  expect(cycleDurations(timer, 91000)).toEqual({ active: 60000, paused: 30000, elapsed: 90000 });
  expect(remainingTime(timer, 91000)).toBe(90000);
  expect(cycleDurations({ ...timer, phase: 'long_break', cycle_started_at: null, cycle_active_ms: 0 }, 91000)).toEqual({ active: 0, paused: 0, elapsed: 0 });
});
