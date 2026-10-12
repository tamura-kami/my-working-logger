import { describe, expect, it } from 'vitest';
import { durations, formatDuration } from '../shared/timing';
import type { TimerState } from '../shared/contracts';
const running: TimerState = { revision: 1, timer_id: 'test', project_id: 'test', project_name: '作業', color: '#123456', status: 'running', started_at: 1000, changed_at: 5000, paused_ms: 1000 };
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
