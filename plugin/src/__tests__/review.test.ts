import { SyncEngine, VaultAdapter } from '../engine';
import { SyncClient, Change } from '../client';
import { createState } from '../state';
import { sha256hex } from '../util';
import { keepServer } from '../conflicts';
import { parsePastedPairingLink } from '../pairing';
import VaultSyncPlugin from '../main';
import { DEFAULT_SETTINGS } from '../settings';
import { OnboardingModal } from '../onboardingWizard';
import { SSEClient } from '../sse';

const bytes = (s: string): ArrayBuffer => new TextEncoder().encode(s).buffer as ArrayBuffer;
const text = (b: ArrayBuffer): string => new TextDecoder().decode(b);

function vault(initial: Record<string, string> = {}): VaultAdapter {
  const files = new Map(Object.entries(initial));
  return {
    readFile: async p => { if (!files.has(p)) throw new Error('missing'); return bytes(files.get(p)!); },
    writeFile: async (p, b) => { files.set(p, text(b)); },
    deleteFile: async p => { files.delete(p); },
    listAll: async () => [...files.keys()],
    exists: async p => files.has(p),
    mtime: async () => 0,
    pruneEmptyParents: async () => {},
  };
}

async function setup(local: Record<string, string>, base: Record<string, string>, changes: Change[]) {
  const hashes: Record<string, string> = {};
  for (const [p, v] of Object.entries(base)) hashes[p] = await sha256hex(bytes(v));
  const state = await createState({ load: async () => ({ files: hashes }), save: async () => {} });
  const v = vault(local);
  const client = {
    getChanges: jest.fn(async (since: number) => changes.filter(c => c.ts > since)),
    getFile: jest.fn(async () => bytes('remote')),
    putFile: jest.fn(async () => ({ conflict: false })),
    deleteFile: jest.fn(async () => {}),
  };
  const conflict = jest.fn();
  const engine = new SyncEngine(client as unknown as SyncClient, v, state, conflict, '.obsidian');
  return { state, vault: v, client, conflict, engine };
}

test('review: failed downloads are retried on a later pull', async () => {
  const s = await setup({}, {}, [{ path: 'a.md', hash: await sha256hex(bytes('remote')), ts: 10, action: 'modified' }]);
  s.client.getFile.mockRejectedValueOnce(new Error('temporary network failure'));
  await s.engine.pull();
  await s.engine.pull();
  expect(await s.vault.exists('a.md')).toBe(true);
});

test('review: remote deletion preserves an unsent local edit', async () => {
  const s = await setup({ 'a.md': 'unsent' }, { 'a.md': 'base' }, [{ path: 'a.md', hash: '', ts: 10, action: 'deleted' }]);
  await s.engine.pull();
  expect(text(await s.vault.readFile('a.md'))).toBe('unsent');
  expect(s.conflict).toHaveBeenCalledWith('a.md');
});

test('review: pull does not silently rebase dirty local bytes on the remote hash', async () => {
  const remoteHash = await sha256hex(bytes('remote'));
  const s = await setup({ 'a.md': 'unsent' }, { 'a.md': 'base' }, [{ path: 'a.md', hash: remoteHash, ts: 10, action: 'modified' }]);
  const base = s.state.files['a.md'];
  await s.engine.pull();
  expect(s.state.files['a.md']).toBe(base);
  expect(s.conflict).toHaveBeenCalledWith('a.md');
});

test('review: untracked local file is not overwritten by a pull', async () => {
  const s = await setup({ 'a.md': 'unsent' }, {}, [{ path: 'a.md', hash: await sha256hex(bytes('remote')), ts: 10, action: 'modified' }]);
  await s.engine.pull();
  expect(text(await s.vault.readFile('a.md'))).toBe('unsent');
});

test('review: failed initial upload is surfaced to the caller', async () => {
  const s = await setup({ 'a.md': 'local' }, {}, []);
  s.client.putFile.mockRejectedValueOnce(new Error('offline'));
  await expect(s.engine.initialSync()).rejects.toThrow();
});

test('review: initial sync does not advance to the client wall clock', async () => {
  const s = await setup({}, {}, []);
  const clock = jest.spyOn(Date, 'now').mockReturnValue(200000);
  try {
    await s.engine.initialSync();
    expect(s.state.lastSyncTimestamp).toBe(0);
  } finally { clock.mockRestore(); }
});

test('review: keep server uses canonical server bytes, not the rejected upload', async () => {
  const remote = bytes('canonical remote');
  const rejected = bytes('rejected local upload');
  const v = vault({ 'a.md': 'local' });
  const hash = await sha256hex(remote);
  const result = await keepServer({ originalPath: 'a.md', conflictPath: 'a.conflict.2026-01-01T00-00-00.000000000.md', copyLocation: 'server', canonical: 'server' }, v, {
    getChanges: async () => [{ path: 'a.md', hash, action: 'modified' }],
    getFile: async p => p === 'a.md' ? remote : rejected,
    putFile: async (_p, data) => ({ conflict: false, currentHash: await sha256hex(data) }),
    deleteFile: async () => {},
  });
  expect(result.ok).toBe(true);
  expect(text(await v.readFile('a.md'))).toBe('canonical remote');
});

test('review: pairing rejects unrelated URI schemes', () => {
  expect(parsePastedPairingLink('https://unrelated.invalid/?server=https://attacker.invalid&token=example')).toBeNull();
});

test('review: a conflict remains visible after runPush returns', async () => {
  const p = Object.create(VaultSyncPlugin.prototype) as { setStatus: (s: string) => void; engine: unknown; syncLog: unknown; runPush: (path: string) => Promise<void> };
  const status: string[] = [];
  p.setStatus = (s: string) => status.push(s);
  p.engine = { push: async () => { p.setStatus('conflict'); return { conflict: true }; } };
  p.syncLog = { add: () => {}, save: async () => {} };
  await p.runPush('a.md');
  expect(status.at(-1)).toBe('conflict');
});

test('review: clearing the auth token removes it from secret storage', async () => {
  const p = Object.create(VaultSyncPlugin.prototype) as VaultSyncPlugin;
  const secret = jest.fn();
  Object.assign(p, { app: { secretStorage: { setSecret: secret } } });
  p.settings = { ...DEFAULT_SETTINGS, authToken: '' };
  p.loadData = async () => ({});
  p.saveData = async () => {};
  await p.saveSettings();
  expect(secret).toHaveBeenCalledWith(expect.any(String), '');
});

test('excluded files are neither downloaded nor deleted during ordinary polling', async () => {
  const s = await setup({ 'private/a.md': 'private' }, {}, [
    { path: 'private/a.md', hash: '', ts: 1, action: 'deleted' },
    { path: 'private/b.md', hash: 'remote', ts: 2, action: 'modified' },
  ]);
  const engine = new SyncEngine(s.client as unknown as SyncClient, s.vault, s.state, s.conflict, '.obsidian', undefined, undefined, p => p.startsWith('private/'));
  await engine.pull();
  expect(text(await s.vault.readFile('private/a.md'))).toBe('private');
  expect(s.client.getFile).not.toHaveBeenCalled();
});

test('offline edits are queued at startup and retried after a failed upload', async () => {
  const s = await setup({ 'a.md': 'offline edit' }, { 'a.md': 'base' }, []);
  await s.engine.scanLocalChanges();
  expect(s.state.pending['a.md']).toBe('upload');
  s.client.putFile.mockRejectedValueOnce(new Error('offline'));
  expect(await s.engine.retryPending()).toBe(1);
  expect(s.state.pending['a.md']).toBe('upload');
  expect(await s.engine.retryPending()).toBe(0);
  expect(s.state.pending['a.md']).toBeUndefined();
});

test('a failed rename upload cannot delete the old server file', async () => {
  const s = await setup({ 'new.md': 'renamed' }, { 'old.md': 'renamed' }, []);
  await s.engine.scanLocalChanges();
  s.client.putFile.mockRejectedValueOnce(new Error('offline'));
  await s.engine.retryPending();
  expect(s.client.deleteFile).not.toHaveBeenCalled();
  await s.engine.retryPending();
  expect(s.client.deleteFile).toHaveBeenCalledWith('old.md', await sha256hex(bytes('renamed')));
});

test('a local delete is not silently resurrected by a remote edit', async () => {
  const s = await setup({ 'other.md': 'local' }, { 'a.md': 'base' }, [{ path: 'a.md', hash: 'new-remote-hash', ts: 1, action: 'modified' }]);
  await s.engine.scanLocalChanges();
  await s.engine.pull();
  expect(await s.vault.exists('a.md')).toBe(false);
  expect(s.state.conflicts['a.md']).toBe('new-remote-hash');
});

test('a client clock ahead of the server does not lose writes after the initial snapshot', async () => {
  const s = await setup({}, {}, []);
  const changes = [{ path: 'new.md', hash: await sha256hex(bytes('remote')), ts: 1, action: 'modified' as const }];
  const client = Object.assign(s.client, {
    getSnapshot: async () => ({ changes: [], cursor: 12, hasMore: false }),
    getChangePage: jest.fn(async (cursor: number) => ({ changes: cursor === 12 ? changes : [], cursor: 13, hasMore: false })),
  });
  const engine = new SyncEngine(client as unknown as SyncClient, s.vault, s.state, s.conflict, '.obsidian');
  await engine.initialSync();
  await engine.pull();
  expect(text(await s.vault.readFile('new.md'))).toBe('remote');
  expect(s.state.cursor).toBe(13);
});

test('pairing URI opens a review screen without changing the connection', async () => {
  const open = jest.spyOn(OnboardingModal.prototype, 'open').mockImplementation(() => {});
  const p = Object.create(VaultSyncPlugin.prototype) as { handlePairingUri: (params: Record<string, string>) => Promise<void>; connectToServer: jest.Mock };
  p.connectToServer = jest.fn();
  try {
    await p.handlePairingUri({ server: 'https://example.invalid', token: 'test-token' });
    expect(open).toHaveBeenCalledTimes(1);
    expect(p.connectToServer).not.toHaveBeenCalled();
  } finally { open.mockRestore(); }
});

test('download failure keeps the sequence cursor available for a retry', async () => {
  const s = await setup({}, {}, []);
  const client = Object.assign(s.client, { getChangePage: async () => ({ changes: [{ path: 'a.md', hash: await sha256hex(bytes('remote')), ts: 1, action: 'modified' as const }], cursor: 1, hasMore: false }) });
  client.getFile.mockRejectedValueOnce(new Error('temporary'));
  const engine = new SyncEngine(client as unknown as SyncClient, s.vault, s.state, s.conflict, '.obsidian');
  await engine.pull();
  expect(s.state.cursor).toBe(0);
  await engine.pull();
  expect(s.state.cursor).toBe(1);
});

test('failed local trash retains the base and cursor for a retry', async () => {
  const s = await setup({ 'a.md': 'base' }, { 'a.md': 'base' }, [{ path: 'a.md', hash: '', ts: 1, action: 'deleted' }]);
  const remove = s.vault.deleteFile;
  s.vault.deleteFile = jest.fn().mockRejectedValueOnce(new Error('disk busy')).mockImplementation(remove);
  expect((await s.engine.pull()).failed).toBe(1);
  expect(s.state.lastSyncTimestamp).toBe(0);
  expect(s.state.files['a.md']).toBeDefined();
  expect((await s.engine.pull()).failed).toBe(0);
  expect(await s.vault.exists('a.md')).toBe(false);
});

test('queued delete does not delete a recreated file on the server', async () => {
  const s = await setup({ 'a.md': 'recreated' }, { 'a.md': 'base' }, []);
  await s.state.queue('a.md', 'delete');
  await s.engine.retryPending();
  expect(s.client.deleteFile).not.toHaveBeenCalled();
  expect(s.state.pending['a.md']).toBe('upload');
  await s.engine.retryPending();
  expect(s.client.putFile).toHaveBeenCalled();
  expect(s.state.pending['a.md']).toBeUndefined();
});

test('extensionless filenames cannot collide with object prototype properties', async () => {
  const state = await createState({ load: async () => undefined, save: async () => {} });
  for (const path of ['constructor', '__proto__', 'toString']) {
    expect(state.conflicts[path]).toBeUndefined();
    expect(path in state.files).toBe(false);
    await state.setFileHash(path, 'hash');
    await state.queue(path, 'upload');
    expect(state.files[path]).toBe('hash');
    expect(state.pending[path]).toBe('upload');
  }
});

test('SSE reconnects after an error and cancels retries when paused', () => {
  jest.useFakeTimers();
  const originalWindow = Object.getOwnPropertyDescriptor(global, 'window');
  const originalSource = Object.getOwnPropertyDescriptor(global, 'EventSource');
  const sources: FakeSource[] = [];
  class FakeSource {
    static OPEN = 1;
    onopen?: () => void;
    onerror?: () => void;
    close = jest.fn();
    constructor() { sources.push(this); }
  }
  Object.defineProperty(global, 'window', { value: global, configurable: true });
  Object.defineProperty(global, 'EventSource', { value: FakeSource, configurable: true });
  try {
    const client = new SSEClient('http://localhost', 'fixture', () => {}, () => {});
    client.connect();
    sources[0].onerror?.();
    jest.advanceTimersByTime(1000);
    expect(sources).toHaveLength(2);
    sources[1].onerror?.();
    client.disconnect();
    jest.advanceTimersByTime(60000);
    expect(sources).toHaveLength(2);
  } finally {
    if (originalWindow) Object.defineProperty(global, 'window', originalWindow); else Reflect.deleteProperty(global, 'window');
    if (originalSource) Object.defineProperty(global, 'EventSource', originalSource); else Reflect.deleteProperty(global, 'EventSource');
    jest.useRealTimers();
  }
});
