import { SyncLog, Throttle, SYNC_LOG_MAX } from '../synclog';

test('keeps only the last 200 entries', () => {
  const log = new SyncLog();
  for (let i = 0; i < SYNC_LOG_MAX + 50; i++) log.add('info', `e${i}`);
  expect(log.entries()).toHaveLength(SYNC_LOG_MAX);
  expect(log.entries()[0].msg).toBe('e50');
  expect(log.entries().at(-1)!.msg).toBe(`e${SYNC_LOG_MAX + 49}`);
});

test('trims an oversized persisted log on load', () => {
  const initial = Array.from({ length: 300 }, (_, i) => ({ ts: i, kind: 'info' as const, msg: `m${i}` }));
  expect(new SyncLog(initial).entries()).toHaveLength(SYNC_LOG_MAX);
});

test('toText renders time, kind and message', () => {
  const log = new SyncLog([], async () => {}, () => Date.UTC(2026, 9, 18, 9, 30, 0));
  log.add('error', 'pull "a.md": getFile failed: 404');
  expect(log.toText()).toBe('2026-10-18T09:30:00.000Z error pull "a.md": getFile failed: 404');
});

test('save hands the entries to the persist callback', async () => {
  const persist = jest.fn(async () => {});
  const log = new SyncLog([], persist);
  log.add('pull', 'x');
  await log.save();
  expect(persist).toHaveBeenCalledWith([expect.objectContaining({ kind: 'pull', msg: 'x' })]);
});

test('serialised log carries no token or file contents (only ts/kind/msg)', () => {
  const log = new SyncLog();
  log.add('pull', '3 change(s): 3 downloaded, 0 up to date, 0 failed');
  const json = JSON.stringify(log.entries());
  expect(Object.keys(JSON.parse(json)[0]).sort()).toEqual(['kind', 'msg', 'ts']);
});

test('Throttle allows once per window', () => {
  let t = 0;
  const th = new Throttle(10 * 60 * 1000, () => t);
  expect(th.allow()).toBe(true);
  t = 5 * 60 * 1000;
  expect(th.allow()).toBe(false);
  t = 10 * 60 * 1000;
  expect(th.allow()).toBe(true);
});
