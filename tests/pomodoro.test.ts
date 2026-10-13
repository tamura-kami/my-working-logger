// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest';
import { durations, remainingTime } from '../shared/timing';
import { beginNext, emptyLocalTimer, expireLocalTimer, finishLocalTimer, pauseLocalTimer, readLocalTimer,
  resumeLocalTimer, startLocalTimer, timerStorageKey, writeLocalTimer } from '../src/localTimer';
const project = { id: 'a81cec60-b018-4c76-a70e-f8f7853f874b', name: '作業', color: '#123456', category_id: 'uncategorized', archived: false };
const settings = { focus_minutes: 1, short_break_minutes: 2, long_break_minutes: 3, long_break_every: 2 };
const start = (mode: 'normal' | 'pomodoro' = 'pomodoro') => startLocalTimer(emptyLocalTimer(), project, mode, settings, 100000);
beforeEach(() => localStorage.clear());
describe('ブラウザのタイマー状態', () => {
  it('通常は閉じていた時間を含め、一時停止中は計測せず復元', () => {
    let value = start('normal'); writeLocalTimer(value);
    expect(durations(readLocalTimer().timer!, 110000).active).toBe(10000);
    value = pauseLocalTimer(readLocalTimer(), 110000); writeLocalTimer(value);
    expect(durations(readLocalTimer().timer!, 200000).active).toBe(10000);
    value = resumeLocalTimer(readLocalTimer(), 200000);
    value = finishLocalTimer(value, 205000);
    expect(value.pending[0]).toMatchObject({ started_at: 100000, ended_at: 205000, paused_ms: 90000 });
    expect(value.timer).toBeNull();
  });
  it('途中復元は設定と残り時間を保持、一時停止・再開の期限も保持', () => {
    let value = start(); writeLocalTimer(value);
    expect(remainingTime(readLocalTimer().timer!, 110000)).toBe(50000);
    value = pauseLocalTimer(value, 110000); writeLocalTimer(value);
    expect(remainingTime(readLocalTimer().timer!, 999999)).toBe(50000);
    expect(readLocalTimer().timer!.pomodoro).toEqual(settings);
    value = resumeLocalTimer(value, 200000);
    expect(value.timer!.deadline_at).toBe(250000);
  });
  it('復帰時の満了は現在フェーズ00:00で停止し重複確定しない', () => {
    const expired = expireLocalTimer(start(), 999999, false); writeLocalTimer(expired);
    expect(expired.timer).toMatchObject({ status: 'expired', phase: 'focus', completed_focus: 1, cycle_active_ms: 60000 });
    expect(remainingTime(expired.timer!, 999999)).toBe(0);
    expect(expireLocalTimer(readLocalTimer(), 9999999, false)).toEqual(expired);
    const next = beginNext(expired, 999999);
    expect(next.timer).toMatchObject({ phase: 'short_break', started_at: 999999, deadline_at: 1119999 });
  });
  it('表示中は自動進行し、長休憩直前だけサイクル実績を確定', () => {
    let value = expireLocalTimer(start(), 160000, true);
    expect(value.timer).toMatchObject({ phase: 'short_break', completed_focus: 1 });
    expect(value.pending).toHaveLength(0);
    value = expireLocalTimer(value, 280000, true);
    value = expireLocalTimer(value, 340000, true);
    expect(value.timer).toMatchObject({ phase: 'long_break', completed_focus: 2, cycle_id: null });
    expect(value.pending[0]).toMatchObject({ started_at: 100000, ended_at: 340000, paused_ms: 120000 });
    value = expireLocalTimer(value, 520000, true);
    expect(value.timer).toMatchObject({ phase: 'focus', completed_focus: 0, cycle_started_at: 520000 });
    expect(value.pending).toHaveLength(1);
  });
  it('閉じていた最後の集中を予定時刻で保存し長休憩は明示操作で開始', () => {
    let value = expireLocalTimer(start(), 160000, true);
    value = expireLocalTimer(value, 280000, true);
    value = expireLocalTimer(value, 999999, false);
    expect(value.timer).toMatchObject({ phase: 'focus', status: 'expired', completed_focus: 2 });
    expect(value.pending[0].ended_at).toBe(340000);
    writeLocalTimer(value);
    value = expireLocalTimer(readLocalTimer(), 999999, false);
    expect(value.pending).toHaveLength(1);
    value = beginNext(value, 999999);
    expect(value.timer).toMatchObject({ phase: 'long_break', cycle_id: null, started_at: 999999 });
    expect(finishLocalTimer(value, 1000000).pending).toHaveLength(1);
  });
  it.each(['short_break', 'long_break'] as const)('復帰した%sも現在フェーズで停止', (phase) => {
    let value = expireLocalTimer(start(), 160000, true);
    if (phase === 'long_break') { value = expireLocalTimer(value, 280000, true); value = expireLocalTimer(value, 340000, true); }
    value = expireLocalTimer(value, 999999, false);
    expect(value.timer).toMatchObject({ phase, status: 'expired' });
    expect(remainingTime(value.timer!, 999999)).toBe(0);
  });
  it('途中終了・満了後終了は集中を二重加算せず、空白を休止に含める', () => {
    let value = expireLocalTimer(start(), 160000, false);
    value = finishLocalTimer(value, 200000);
    expect(value.pending[0]).toMatchObject({ started_at: 100000, ended_at: 200000, paused_ms: 40000 });
    value = expireLocalTimer(start(), 160000, true);
    value = beginNext(value, 170000); // 短休憩スキップ
    value = pauseLocalTimer(value, 180000);
    value = finishLocalTimer(value, 190000);
    expect(value.pending[0]).toMatchObject({ ended_at: 190000, paused_ms: 20000 });
  });
  it('1秒未満を破棄し、時計が戻っても負の実作業にしない', () => {
    expect(finishLocalTimer(start('normal'), 100999).pending).toHaveLength(0);
    expect(durations(start('normal').timer!, 1).active).toBe(0);
    expect(finishLocalTimer(start('normal'), 1).pending).toHaveLength(0);
  });
  it('正常終了後は実行状態を削除し未保存実績を保持', () => {
    writeLocalTimer(finishLocalTimer(start('normal'), 105000));
    expect(readLocalTimer().timer).toBeNull(); expect(readLocalTimer().pending).toHaveLength(1);
    writeLocalTimer(emptyLocalTimer()); expect(localStorage.getItem(timerStorageKey)).toBeNull();
  });
  it.each(['{', '{"version":2}', '{"version":1,"timer":{},"pending":[]}'])('破損・未対応データを上書きしない %s', (raw) => {
    localStorage.setItem(timerStorageKey, raw);
    expect(() => readLocalTimer()).toThrow(); expect(localStorage.getItem(timerStorageKey)).toBe(raw);
  });
});
