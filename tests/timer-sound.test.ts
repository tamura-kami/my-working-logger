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

it('recreates even a running context when the user tests sound', async () => {
  const { sound } = setup();
  await sound.enable();
  const original = FakeContext.instances[0];
  expect(await sound.enable(true)).toBe(true);
  expect(original.close).toHaveBeenCalled();
  expect(FakeContext.instances).toHaveLength(2);
});
