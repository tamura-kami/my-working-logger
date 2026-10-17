import { afterEach, expect, it, vi } from 'vitest';
import { TimerSound } from '../src/timerSound';

class FakeContext {
  static instances: FakeContext[] = [];
  state = 'suspended';
  onstatechange: (() => void) | null = null;
  resume = vi.fn(async () => { this.state = 'running'; });
  close = vi.fn(async () => { this.state = 'closed'; });
  constructor() { FakeContext.instances.push(this); }
}
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); FakeContext.instances = []; });
function setup() {
  vi.stubGlobal('window', { AudioContext: FakeContext });
  const changed = vi.fn();
  return { sound: new TimerSound(changed), changed };
}
it('resumes an interrupted context when returning to the page', async () => {
  const { sound, changed } = setup();
  await sound.enable();
  const context = FakeContext.instances[0];
  context.state = 'interrupted'; context.onstatechange?.();
  expect(changed).toHaveBeenLastCalledWith(false);
  expect(await sound.restore()).toBe(true);
  expect(context.resume).toHaveBeenCalledTimes(2);
  expect(changed).toHaveBeenLastCalledWith(true);
});
it('recreates an interrupted context on a user action', async () => {
  const { sound } = setup();
  await sound.enable();
  const original = FakeContext.instances[0]; original.state = 'interrupted';
  expect(await sound.enable()).toBe(true);
  expect(original.close).toHaveBeenCalled();
  expect(FakeContext.instances).toHaveLength(2);
});
it('reports failed playback and does not hang on an unresolved Safari resume', async () => {
  vi.useFakeTimers();
  const { sound, changed } = setup();
  await sound.enable();
  const context = FakeContext.instances[0]; context.state = 'interrupted';
  expect(sound.play()).toBe(false);
  expect(changed).toHaveBeenLastCalledWith(false);
  context.resume.mockImplementation(() => new Promise(() => {}));
  const restoring = sound.restore();
  await vi.advanceTimersByTimeAsync(1500);
  expect(await restoring).toBe(false);
});
it('does not create audio without a user action', async () => {
  const { sound } = setup();
  expect(await sound.restore()).toBe(false);
  expect(FakeContext.instances).toHaveLength(0);
});

it.each(['running', 'suspended', 'interrupted'])('recreates a %s context and starts resume synchronously', async (state) => {
  const { sound } = setup();
  await sound.enable();
  const original = FakeContext.instances[0];
  original.state = state;
  const enabling = sound.enable();
  const replacement = FakeContext.instances[1];
  expect(original.close).toHaveBeenCalledTimes(1);
  expect(original.onstatechange).toBeNull();
  expect(replacement.resume).toHaveBeenCalledTimes(1);
  expect(await enabling).toBe(true);
  sound.close();
});
it('ignores a stale resume completing after a newer user action', async () => {
  const { sound, changed } = setup();
  await sound.enable();
  const original = FakeContext.instances[0];
  original.state = 'suspended';
  let complete!: () => void;
  original.resume.mockImplementation(() => new Promise<void>((resolve) => { complete = resolve; }));
  const stale = sound.restore();
  expect(await sound.enable()).toBe(true);
  changed.mockClear();
  original.state = 'running'; complete();
  expect(await stale).toBe(false);
  expect(changed).not.toHaveBeenCalled();
  sound.close();
});
it('recreates a closed context on the next user action', async () => {
  const { sound } = setup();
  await sound.enable();
  FakeContext.instances[0].state = 'closed';
  expect(await sound.enable()).toBe(true);
  expect(FakeContext.instances).toHaveLength(2);
});
it('captures playback exceptions for diagnosis', async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const { sound } = setup();
  await sound.enable();
  const error = new Error('audio unavailable');
  Object.assign(FakeContext.instances[0], { createOscillator: () => { throw error; } });
  expect(sound.play()).toBe(false);
  expect(warn).toHaveBeenCalledWith('Timer sound playback failed', error);
  warn.mockRestore();
});

it('reuses one context across repeated notifications and disconnects finished nodes', async () => {
  const { sound } = setup();
  await sound.enable();
  const context = FakeContext.instances[0];
  const oscillators: { onended: (() => void) | null; disconnect: ReturnType<typeof vi.fn> }[] = [];
  const gains: { disconnect: ReturnType<typeof vi.fn> }[] = [];
  Object.assign(context, {
    currentTime: 0, destination: {},
    createOscillator: () => {
      const oscillator = { frequency: { value: 0 }, connect: vi.fn(), disconnect: vi.fn(), start: vi.fn(), stop: vi.fn(), onended: null as (() => void) | null };
      oscillators.push(oscillator); return oscillator;
    },
    createGain: () => {
      const gain = { gain: { setValueAtTime: vi.fn(), linearRampToValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() }, connect: vi.fn(), disconnect: vi.fn() };
      gains.push(gain); return gain;
    },
  });
  for (let i = 0; i < 12; i++) {
    expect(sound.play()).toBe(true);
    oscillators.slice(-3).forEach((oscillator) => oscillator.onended?.());
  }
  expect(FakeContext.instances).toHaveLength(1);
  expect(oscillators).toHaveLength(36);
  for (const node of [...oscillators, ...gains]) expect(node.disconnect).toHaveBeenCalledTimes(1);
  sound.close();
  expect(context.close).toHaveBeenCalledTimes(1);
});
