import VaultSyncPlugin from '../main';
import {
  DEFAULT_SETTINGS,
  clampPushDebounceSeconds,
  pushDebounceDelayMs,
} from '../settings';

test('push debounce defaults to 2 seconds', () => {
  expect(DEFAULT_SETTINGS.pushDebounceSeconds).toBe(2);
  expect(pushDebounceDelayMs(DEFAULT_SETTINGS.pushDebounceSeconds)).toBe(2000);
});

test('clampPushDebounceSeconds clamps negatives and non-integers into 0..30', () => {
  expect(clampPushDebounceSeconds(-1)).toBe(0);
  expect(clampPushDebounceSeconds(-0.4)).toBe(0);
  expect(clampPushDebounceSeconds(2.4)).toBe(2);
  expect(clampPushDebounceSeconds(2.5)).toBe(3);
  expect(clampPushDebounceSeconds(30.6)).toBe(30);
  expect(clampPushDebounceSeconds(99)).toBe(30);
  expect(clampPushDebounceSeconds(Number.NaN)).toBe(2);
  expect(clampPushDebounceSeconds('nope')).toBe(2);
  expect(clampPushDebounceSeconds(undefined)).toBe(2);
});

beforeEach(() => {
  (globalThis as unknown as { window: typeof globalThis }).window = globalThis as unknown as Window & typeof globalThis;
});

function barePlugin(seconds: number): VaultSyncPlugin {
  const plugin = Object.create(VaultSyncPlugin.prototype) as VaultSyncPlugin;
  plugin.settings = { ...DEFAULT_SETTINGS, pushDebounceSeconds: seconds, exclude: [] };
  (plugin as unknown as { debounceMap: Map<string, number> }).debounceMap = new Map();
  (plugin as unknown as { runPush: (path: string) => Promise<void> }).runPush = jest.fn(async () => {});
  return plugin;
}

test('onFileModify waits seconds * 1000 and 0 pushes on the next timer turn', () => {
  jest.useFakeTimers();
  const delayed = barePlugin(5);
  (delayed as unknown as { onFileModify: (file: { path: string }) => void }).onFileModify({ path: 'a.md' });
  jest.advanceTimersByTime(4999);
  expect((delayed as unknown as { runPush: jest.Mock }).runPush).not.toHaveBeenCalled();
  jest.advanceTimersByTime(1);
  expect((delayed as unknown as { runPush: jest.Mock }).runPush).toHaveBeenCalledWith('a.md');

  const immediate = barePlugin(0);
  (immediate as unknown as { onFileModify: (file: { path: string }) => void }).onFileModify({ path: 'now.md' });
  expect((immediate as unknown as { runPush: jest.Mock }).runPush).not.toHaveBeenCalled();
  jest.advanceTimersByTime(0);
  expect((immediate as unknown as { runPush: jest.Mock }).runPush).toHaveBeenCalledWith('now.md');
  jest.useRealTimers();
});
