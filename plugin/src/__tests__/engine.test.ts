import { SyncEngine, VaultAdapter, conflictSiblingPath } from '../engine';
import { SyncClient } from '../client';
import { createState, StateStorage } from '../state';
import { sha256hex } from '../util';

function makeVault(files: Record<string, string> = {}): jest.Mocked<VaultAdapter> {
  const store: Record<string, Uint8Array> = {};
  for (const [k, v] of Object.entries(files)) {
    store[k] = new TextEncoder().encode(v);
  }
  return {
    readFile: jest.fn(async (path) => store[path]?.buffer as ArrayBuffer ?? new ArrayBuffer(0)),
    writeFile: jest.fn(async (path, data) => { store[path] = new Uint8Array(data); }),
    deleteFile: jest.fn(async (path) => { delete store[path]; }),
    listAll: jest.fn(async () => Object.keys(store)),
    exists: jest.fn(async (path) => path in store),
    mtime: jest.fn(async (_path: string) => null as number | null),
    pruneEmptyParents: jest.fn(async (_path: string) => {}),
  };
}

function makeStorage(initial: any = {}): StateStorage {
  let data = { ...initial };
  return {
    load: jest.fn(async () => ({ ...data })),
    save: jest.fn(async (d) => { data = { ...d }; }),
  };
}

function makeClient(overrides: Partial<Record<keyof SyncClient, any>> = {}): SyncClient {
  return {
    getChanges: jest.fn(async () => []),
    getFile: jest.fn(async () => new ArrayBuffer(0)),
    putFile: jest.fn(async () => ({ conflict: false })),
    deleteFile: jest.fn(async () => {}),
    ...overrides,
  } as any;
}

test('pull: downloads modified files and updates state', async () => {
  const vault = makeVault({});
  const state = await createState(makeStorage({}));
  const content = new TextEncoder().encode('new content').buffer as ArrayBuffer;
  const client = makeClient({
    getChanges: jest.fn(async () => [
      { path: 'notes/foo.md', hash: 'abc', ts: 200, action: 'modified' as const },
    ]),
    getFile: jest.fn(async () => content),
  });

  const engine = new SyncEngine(client, vault, state, jest.fn(), '.obsidian');
  await engine.pull();

  expect(client.getChanges).toHaveBeenCalledWith(0);
  expect(client.getFile).toHaveBeenCalledWith('notes/foo.md');
  expect(vault.writeFile).toHaveBeenCalledWith('notes/foo.md', content);
  expect(state.files['notes/foo.md']).toBe('abc');
});

test('pull: deletes files marked as deleted', async () => {
  const vault = makeVault({ 'old.md': 'content' });
  const state = await createState(makeStorage({ files: { 'old.md': await sha256hex(buf('content')) }, lastSyncTimestamp: 0 }));
  const client = makeClient({
    getChanges: jest.fn(async () => [
      { path: 'old.md', hash: '', ts: 300, action: 'deleted' as const },
    ]),
  });

  const engine = new SyncEngine(client, vault, state, jest.fn(), '.obsidian');
  await engine.pull();

  expect(vault.deleteFile).toHaveBeenCalledWith('old.md');
  expect(state.files['old.md']).toBeUndefined();
});

test('pull: records conflict and keeps both copies when user modified locally', async () => {
  // Simulates user typing while pull is downloading: file changes between
  // the last sync and writeFile. Must not overwrite user's work.
  const originalContent = 'original text';
  const userContent = 'user typed this';
  const serverContent = 'server version';
  
  const originalData = new TextEncoder().encode(originalContent).buffer;
  const originalHash = await sha256hex(originalData);
  
  const vault = makeVault({ 'notes/race.md': userContent });
  const state = await createState(makeStorage({ 
    files: { 'notes/race.md': originalHash },
    lastSyncTimestamp: 100 
  }));
  
  const serverData = new TextEncoder().encode(serverContent).buffer;
  const client = makeClient({
    getChanges: jest.fn(async () => [
      { path: 'notes/race.md', hash: 'server-hash', ts: 200, action: 'modified' as const },
    ]),
    getFile: jest.fn(async () => serverData),
  });

  const onConflict = jest.fn();
  const engine = new SyncEngine(client, vault, state, onConflict, '.obsidian');
  await engine.pull();

  expect(onConflict).toHaveBeenCalledWith('notes/race.md');
  expect(vault.writeFile).not.toHaveBeenCalledWith('notes/race.md', expect.anything());
  
  // User's content preserved
  const finalContent = new TextDecoder().decode(await vault.readFile('notes/race.md'));
  expect(finalContent).toBe(userContent);
});

test('push: uploads file with correct base hash', async () => {
  const vault = makeVault({ 'notes/bar.md': 'hello' });
  const state = await createState(makeStorage({ files: { 'notes/bar.md': 'old-hash' }, lastSyncTimestamp: 0 }));
  const client = makeClient();

  const engine = new SyncEngine(client, vault, state, jest.fn(), '.obsidian');
  await engine.push('notes/bar.md');

  expect(client.putFile).toHaveBeenCalledWith(
    'notes/bar.md',
    expect.any(ArrayBuffer),
    'old-hash',
  );
});

test('push: skips when content matches last-synced hash (breaks pull→push echo loop)', async () => {
  // pull writes a file and records its hash in state. The resulting Obsidian
  // 'modify' event triggers a push — which must be a no-op, or every pulled
  // file gets re-uploaded, re-changelogged, and re-pulled forever.
  const content = 'identical bytes';
  const data = new TextEncoder().encode(content).buffer as ArrayBuffer;
  const hash = await sha256hex(data);
  const vault = makeVault({ 'a.md': content });
  const state = await createState(makeStorage({ files: { 'a.md': hash }, lastSyncTimestamp: 0 }));
  const client = makeClient();

  const engine = new SyncEngine(client, vault, state, jest.fn(), '.obsidian');
  await engine.push('a.md');

  expect(client.putFile).not.toHaveBeenCalled();
});

test('push: still uploads when content actually changed', async () => {
  const vault = makeVault({ 'a.md': 'new content' });
  // state holds a stale hash that won't match the current bytes
  const state = await createState(makeStorage({ files: { 'a.md': 'stale-hash' }, lastSyncTimestamp: 0 }));
  const client = makeClient();

  const engine = new SyncEngine(client, vault, state, jest.fn(), '.obsidian');
  await engine.push('a.md');

  expect(client.putFile).toHaveBeenCalledTimes(1);
});

test('push: notifies on conflict', async () => {
  const vault = makeVault({ 'notes/foo.md': 'local' });
  const state = await createState(makeStorage({ files: { 'notes/foo.md': 'stale' }, lastSyncTimestamp: 0 }));
  const client = makeClient({ putFile: jest.fn(async () => ({ conflict: true })) });

  const onConflict = jest.fn();
  const engine = new SyncEngine(client, vault, state, onConflict, '.obsidian');
  await engine.push('notes/foo.md');

  expect(onConflict).toHaveBeenCalledWith('notes/foo.md');
});

test('initialSync: uploads all when server is empty', async () => {
  const vault = makeVault({ 'notes/a.md': 'content', 'notes/b.md': 'more' });
  const state = await createState(makeStorage({}));
  const client = makeClient({ getChanges: jest.fn(async () => []) });

  const engine = new SyncEngine(client, vault, state, jest.fn(), '.obsidian');
  await engine.initialSync();

  expect(client.putFile).toHaveBeenCalledTimes(2);
});

test('initialSync: hash mismatch keeps local and writes a conflict sibling', async () => {
  const vault = makeVault({ 'notes/a.md': 'old local content' });
  const state = await createState(makeStorage({}));
  const serverContent = new TextEncoder().encode('server content').buffer as ArrayBuffer;
  const client = makeClient({
    getChanges: jest.fn(async () => [
      { path: 'notes/a.md', hash: 'server-hash', ts: 1, action: 'modified' as const },
    ]),
    getFile: jest.fn(async () => serverContent),
  });

  const onConflict = jest.fn();
  const engine = new SyncEngine(client, vault, state, onConflict, '.obsidian');
  await engine.initialSync();

  expect(vault.writeFile).not.toHaveBeenCalledWith('notes/a.md', serverContent);
  const written = (vault.writeFile as jest.Mock).mock.calls.map(c => c[0] as string);
  expect(written.some(p => /^notes\/a\.conflict\.local\..+\.md$/.test(p))).toBe(true);
  const conflictPath = written.find(p => p.includes('.conflict.local.'));
  expect(conflictPath).toBeDefined();
  expect(vault.writeFile).toHaveBeenCalledWith(conflictPath, serverContent);
  expect(state.files['notes/a.md']).toBeUndefined();
  expect(state.conflicts['notes/a.md']).toBe('server-hash');
  expect(onConflict).toHaveBeenCalledWith('notes/a.md');
});

test('initialSync: skips excluded and unsafe paths on download and upload', async () => {
  const vault = makeVault({
    'tools/helper.exe': 'bin',
    'keep.md': 'local',
    '.obsidian/community-plugins.json': 'nope',
  });
  const remoteExe = new TextEncoder().encode('remote-exe').buffer as ArrayBuffer;
  const client = makeClient({
    getChanges: jest.fn(async () => [
      { path: 'tools/other.exe', hash: 'exe-hash', ts: 1, action: 'modified' as const },
      { path: '../escape.md', hash: 'bad', ts: 1, action: 'modified' as const },
    ]),
    getFile: jest.fn(async () => remoteExe),
  });
  const engine = new SyncEngine(client, vault, await createState(makeStorage({})), jest.fn(), '.obsidian');
  const excluded = (path: string) => path.endsWith('.exe');

  await engine.initialSync(excluded);

  expect(client.getFile).not.toHaveBeenCalled();
  expect(client.putFile).not.toHaveBeenCalledWith('tools/helper.exe', expect.anything(), expect.anything());
  expect(client.putFile).not.toHaveBeenCalledWith('.obsidian/community-plugins.json', expect.anything(), expect.anything());
  expect(client.putFile).toHaveBeenCalledWith('keep.md', expect.anything(), '');
  expect(vault.writeFile).not.toHaveBeenCalled();
});

test('initialSync: equal hashes skip download and upload', async () => {
  const body = new TextEncoder().encode('same').buffer as ArrayBuffer;
  const hash = await sha256hex(body);
  const vault = makeVault({ 'notes/a.md': 'same' });
  const state = await createState(makeStorage({}));
  const client = makeClient({
    getChanges: jest.fn(async () => [
      { path: 'notes/a.md', hash, ts: 1, action: 'modified' as const },
    ]),
  });

  const engine = new SyncEngine(client, vault, state, jest.fn(), '.obsidian');
  await engine.initialSync();

  expect(client.getFile).not.toHaveBeenCalled();
  expect(client.putFile).not.toHaveBeenCalled();
  expect(state.files['notes/a.md']).toBe(hash);
});

test('conflictSiblingPath keeps stem, device, and extension', () => {
  const path = conflictSiblingPath('notes/a.md', 'phone', new Date('2026-11-12T01:02:03.004Z'));
  expect(path).toBe('notes/a.conflict.phone.2026-11-12T01-02-03-004Z.md');
});

test('pull: advances lastSyncTimestamp to max server ts (never NaN)', async () => {
  // The server emits `ts`, not `mtime`. Using the wrong field yields NaN,
  // which collapses lastSyncTimestamp to 0 and re-pulls the whole changelog
  // on every poll.
  const vault = makeVault({});
  const state = await createState(makeStorage({ lastSyncTimestamp: 100 }));
  const client = makeClient({
    getChanges: jest.fn(async () => [
      { path: 'a.md', hash: 'h1', ts: 200, action: 'modified' as const },
      { path: 'b.md', hash: 'h2', ts: 350, action: 'modified' as const },
    ]),
    getFile: jest.fn(async () => new ArrayBuffer(0)),
  });

  const engine = new SyncEngine(client, vault, state, jest.fn(), '.obsidian');
  await engine.pull();

  expect(Number.isNaN(state.lastSyncTimestamp)).toBe(false);
  expect(state.lastSyncTimestamp).toBe(350);
});

test('pull: one failing file does not abort the whole pull', async () => {
  const vault = makeVault({});
  const state = await createState(makeStorage({ lastSyncTimestamp: 0 }));
  const good = new TextEncoder().encode('ok').buffer as ArrayBuffer;
  const client = makeClient({
    getChanges: jest.fn(async () => [
      { path: 'bad.md', hash: 'hb', ts: 10, action: 'modified' as const },
      { path: 'good.md', hash: 'hg', ts: 20, action: 'modified' as const },
    ]),
    getFile: jest.fn(async (path: string) => {
      if (path === 'bad.md') throw new Error('getFile failed: 404');
      return good;
    }),
  });

  const engine = new SyncEngine(client, vault, state, jest.fn(), '.obsidian');
  await expect(engine.pull()).resolves.toMatchObject({ failed: 1, downloaded: 1 });

  // The healthy file is still written, and the broken one is skipped — not fatal.
  expect(vault.writeFile).toHaveBeenCalledWith('good.md', good);
  expect(state.files['good.md']).toBe('hg');
  expect(state.files['bad.md']).toBeUndefined();
  // Keep the page available for retry; successful files are skipped by hash.
  expect(state.lastSyncTimestamp).toBe(0);
});

test('pull: skips unsafe paths from server', async () => {
  const vault = makeVault({});
  const state = await createState(makeStorage({}));
  const client = makeClient({
    getChanges: jest.fn(async () => [
      { path: '.obsidian/community-plugins.json', hash: 'h', ts: 1, action: 'modified' as const },
      { path: '../escape.md', hash: 'h2', ts: 2, action: 'modified' as const },
      { path: 'safe/note.md', hash: 'h3', ts: 3, action: 'modified' as const },
    ]),
    getFile: jest.fn(async () => new TextEncoder().encode('content').buffer as ArrayBuffer),
  });

  const engine = new SyncEngine(client, vault, state, jest.fn(), '.obsidian');
  await engine.pull();

  // Only safe/note.md should be written
  expect(vault.writeFile).toHaveBeenCalledTimes(1);
  expect(vault.writeFile).toHaveBeenCalledWith('safe/note.md', expect.any(ArrayBuffer));
  expect(vault.writeFile).not.toHaveBeenCalledWith('.obsidian/community-plugins.json', expect.anything());
});

test('pull: concurrent local edit keeps its base and blocks automatic overwrite', async () => {
  // Scenario: server has H1, client state tracks H0, user edits to H_user during download.
  // Preserve the real base and require an explicit conflict resolution.
  const enc = (s: string) => new TextEncoder().encode(s).buffer as ArrayBuffer;

  const originalContent = 'original text';
  const originalData = enc(originalContent);
  const originalHash = await sha256hex(originalData);

  const serverContent = 'server version v2';
  const serverData = enc(serverContent);
  const serverHash = await sha256hex(serverData);

  // Vault has the user's in-progress version (different from both original and server)
  const vault = makeVault({ 'notes/daily.md': 'user edits in flight' });
  // State tracks the original hash (last successful sync — pre-edit)
  const state = await createState(makeStorage({
    files: { 'notes/daily.md': originalHash },
    lastSyncTimestamp: 0,
  }));

  const client = makeClient({
    getChanges: jest.fn(async () => [
      { path: 'notes/daily.md', hash: serverHash, ts: 100, action: 'modified' as const },
    ]),
    getFile: jest.fn(async () => serverData),
  });

  const engine = new SyncEngine(client, vault, state, jest.fn(), '.obsidian');
  await engine.pull();

  // Server write must be skipped — user's content preserved
  expect(vault.writeFile).not.toHaveBeenCalledWith('notes/daily.md', expect.anything());
  expect(state.files['notes/daily.md']).toBe(originalHash);
  expect(state.conflicts['notes/daily.md']).toBe(serverHash);
});

test('pull: mass-change guard blocks a batch deleting >=50% of known files when declined', async () => {
  const files = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`note${i}.md`, 'content']));
  const contentHash = await sha256hex(buf('content'));
  const knownFiles = Object.fromEntries(Object.keys(files).map(p => [p, contentHash]));
  const vault = makeVault(files);
  const state = await createState(makeStorage({ files: knownFiles, lastSyncTimestamp: 0 }));
  const client = makeClient({
    getChanges: jest.fn(async () => Array.from({ length: 6 }, (_, i) => (
      { path: `note${i}.md`, hash: '', ts: 10 + i, action: 'deleted' as const }
    ))),
  });

  const onMassChange = jest.fn(async () => false);
  const engine = new SyncEngine(client, vault, state, jest.fn(), '.obsidian', onMassChange);
  await engine.pull();

  expect(onMassChange).toHaveBeenCalledWith(6, 10, expect.any(Array));
  expect(vault.deleteFile).not.toHaveBeenCalled();
  expect(state.lastSyncTimestamp).toBe(0);
  expect(Object.keys(state.files)).toHaveLength(10);
});

test('pull: mass-change guard applies the batch normally when approved', async () => {
  const files = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`note${i}.md`, 'content']));
  const contentHash = await sha256hex(buf('content'));
  const knownFiles = Object.fromEntries(Object.keys(files).map(p => [p, contentHash]));
  const vault = makeVault(files);
  const state = await createState(makeStorage({ files: knownFiles, lastSyncTimestamp: 0 }));
  const client = makeClient({
    getChanges: jest.fn(async () => Array.from({ length: 6 }, (_, i) => (
      { path: `note${i}.md`, hash: '', ts: 10 + i, action: 'deleted' as const }
    ))),
  });

  const onMassChange = jest.fn(async () => true);
  const engine = new SyncEngine(client, vault, state, jest.fn(), '.obsidian', onMassChange);
  await engine.pull();

  expect(onMassChange).toHaveBeenCalledWith(6, 10, expect.any(Array));
  expect(vault.deleteFile).toHaveBeenCalledTimes(6);
  expect(state.lastSyncTimestamp).toBe(15);
});

test('pull: mass-change guard does not fire under the absolute floor even at high ratio', async () => {
  // 2 known files, both deleted = 100% but under MASS_CHANGE_MIN_AFFECTED (5).
  const vault = makeVault({ 'a.md': 'x', 'b.md': 'y' });
  const state = await createState(makeStorage({ files: { 'a.md': await sha256hex(buf('x')), 'b.md': await sha256hex(buf('y')) }, lastSyncTimestamp: 0 }));
  const client = makeClient({
    getChanges: jest.fn(async () => [
      { path: 'a.md', hash: '', ts: 1, action: 'deleted' as const },
      { path: 'b.md', hash: '', ts: 2, action: 'deleted' as const },
    ]),
  });

  const onMassChange = jest.fn(async () => false);
  const engine = new SyncEngine(client, vault, state, jest.fn(), '.obsidian', onMassChange);
  await engine.pull();

  expect(onMassChange).not.toHaveBeenCalled();
  expect(vault.deleteFile).toHaveBeenCalledTimes(2);
});

test('pull: mass-change guard does not fire under the ratio even with many known files', async () => {
  // 10 known files, 4 deleted = 40%, under the 50% ratio (even though 4 < floor too,
  // this asserts the ratio math itself, not just the floor).
  const files = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`note${i}.md`, 'content']));
  const contentHash = await sha256hex(buf('content'));
  const knownFiles = Object.fromEntries(Object.keys(files).map(p => [p, contentHash]));
  const vault = makeVault(files);
  const state = await createState(makeStorage({ files: knownFiles, lastSyncTimestamp: 0 }));
  const client = makeClient({
    getChanges: jest.fn(async () => Array.from({ length: 4 }, (_, i) => (
      { path: `note${i}.md`, hash: '', ts: 10 + i, action: 'deleted' as const }
    ))),
  });

  const onMassChange = jest.fn(async () => false);
  const engine = new SyncEngine(client, vault, state, jest.fn(), '.obsidian', onMassChange);
  await engine.pull();

  expect(onMassChange).not.toHaveBeenCalled();
  expect(vault.deleteFile).toHaveBeenCalledTimes(4);
});

test('pull: default onMassChange (unset) applies batches normally', async () => {
  // No 6th arg passed — matches every pre-existing call site in this file.
  const files = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`note${i}.md`, 'content']));
  const contentHash = await sha256hex(buf('content'));
  const knownFiles = Object.fromEntries(Object.keys(files).map(p => [p, contentHash]));
  const vault = makeVault(files);
  const state = await createState(makeStorage({ files: knownFiles, lastSyncTimestamp: 0 }));
  const client = makeClient({
    getChanges: jest.fn(async () => Array.from({ length: 6 }, (_, i) => (
      { path: `note${i}.md`, hash: '', ts: 10 + i, action: 'deleted' as const }
    ))),
  });

  const engine = new SyncEngine(client, vault, state, jest.fn(), '.obsidian');
  await engine.pull();

  expect(vault.deleteFile).toHaveBeenCalledTimes(6);
});

test('pull: conflict files from server are not written to vault', async () => {
  // Conflict copies (.conflict.<ts>.md) are server-side artefacts; they must not
  // land in the client vault as real notes or trigger modify events.
  const vault = makeVault({});
  const state = await createState(makeStorage({}));
  const client = makeClient({
    getChanges: jest.fn(async () => [
      {
        path: 'Daily notes/🗓️ 2026-06-23.conflict.2026-06-23T12-09-01.000000000.md',
        hash: 'ch1',
        ts: 10,
        action: 'modified' as const,
      },
      { path: 'Daily notes/🗓️ 2026-06-23.md', hash: 'h1', ts: 11, action: 'modified' as const },
    ]),
    getFile: jest.fn(async () => new TextEncoder().encode('content').buffer as ArrayBuffer),
  });

  const engine = new SyncEngine(client, vault, state, jest.fn(), '.obsidian');
  await engine.pull();

  // Conflict file must be silently skipped; only the canonical note is written
  expect(vault.writeFile).toHaveBeenCalledTimes(1);
  expect(vault.writeFile).toHaveBeenCalledWith('Daily notes/🗓️ 2026-06-23.md', expect.any(ArrayBuffer));
  expect(vault.writeFile).not.toHaveBeenCalledWith(
    expect.stringContaining('.conflict.'), expect.anything(),
  );
});


// --- deletion reliability -------------------------------------------------

describe('pull: echo suppression', () => {
  test('applying a server deletion does not send DELETE back', async () => {
    const vault = makeVault({ 'old.md': 'content' });
    // Real Obsidian fires the vault 'delete' event while deleteFile runs; the
    // plugin's listener calls pushDelete then. Simulate that.
    const state = await createState(makeStorage({ files: { 'old.md': await sha256hex(buf('content')) }, lastSyncTimestamp: 0 }));
    const client = makeClient({
      getChanges: jest.fn(async () => [{ path: 'old.md', hash: '', ts: 300, action: 'deleted' as const }]),
    });
    const engine = new SyncEngine(client, vault, state, jest.fn(), '.obsidian');
    vault.deleteFile.mockImplementation(async () => { void engine.pushDelete('old.md'); });

    await engine.pull();

    expect(vault.deleteFile).toHaveBeenCalledWith('old.md');
    expect(client.deleteFile).not.toHaveBeenCalled();
  });

  test('prunes empty parent folders after applying a server deletion', async () => {
    const vault = makeVault({ 'a/b/old.md': 'content' });
    const state = await createState(makeStorage({ files: { 'a/b/old.md': await sha256hex(buf('content')) }, lastSyncTimestamp: 0 }));
    const client = makeClient({
      getChanges: jest.fn(async () => [{ path: 'a/b/old.md', hash: '', ts: 300, action: 'deleted' as const }]),
    });
    const engine = new SyncEngine(client, vault, state, jest.fn(), '.obsidian');

    await engine.pull();

    expect(vault.pruneEmptyParents).toHaveBeenCalledWith('a/b/old.md');
  });
});

describe('pushDelete', () => {
  test('sends DELETE with the tracked base hash for a tracked path', async () => {
    const vault = makeVault({});
    const state = await createState(makeStorage({ files: { 'a.md': 'h1' } }));
    const client = makeClient();
    const engine = new SyncEngine(client, vault, state, jest.fn(), '.obsidian');

    await engine.pushDelete('a.md');

    expect(client.deleteFile).toHaveBeenCalledWith('a.md', 'h1');
    expect(state.files['a.md']).toBeUndefined();
  });

  test('sends nothing for a path the server was never told about', async () => {
    const vault = makeVault({});
    const state = await createState(makeStorage({ files: {} }));
    const client = makeClient();
    const engine = new SyncEngine(client, vault, state, jest.fn(), '.obsidian');

    await engine.pushDelete('never-synced.md');

    expect(client.deleteFile).not.toHaveBeenCalled();
  });
});

describe('reconcileDeletions', () => {
  function tracked(...paths: string[]): Record<string, string> {
    return Object.fromEntries(paths.map((p) => [p, `hash-${p}`]));
  }

  test('sends DELETE for tracked paths that are gone from disk', async () => {
    const vault = makeVault({ 'keep.md': 'x' });
    const state = await createState(makeStorage({ files: tracked('keep.md', 'gone.md', 'keep2.md', 'keep3.md', 'keep4.md', 'keep5.md', 'keep6.md', 'keep7.md', 'keep8.md', 'keep9.md') }));
    const client = makeClient();
    const engine = new SyncEngine(client, vault, state, jest.fn(), '.obsidian');

    await engine.reconcileDeletions();

    // keep.md is on disk, so it must not be touched.
    expect(client.deleteFile).toHaveBeenCalledWith('gone.md', 'hash-gone.md');
    expect(client.deleteFile).not.toHaveBeenCalledWith('keep.md', expect.anything());
    expect(state.files['gone.md']).toBeUndefined();
  });

  test('does nothing when the vault listing is empty (vault not ready)', async () => {
    const vault = makeVault({});
    const state = await createState(makeStorage({ files: tracked('a.md', 'b.md') }));
    const client = makeClient();
    const engine = new SyncEngine(client, vault, state, jest.fn(), '.obsidian');

    await engine.reconcileDeletions();

    expect(client.deleteFile).not.toHaveBeenCalled();
    expect(Object.keys(state.files)).toHaveLength(2);
  });

  test('trusts adapter.exists over the listing: a file that exists is not deleted', async () => {
    const vault = makeVault({ 'other.md': 'x' });
    // The listing misses a.md (e.g. stale cache / excluded) but it is on disk.
    vault.exists.mockImplementation(async (p) => p === 'a.md' || p === 'other.md');
    const state = await createState(makeStorage({ files: tracked('a.md', 'other.md') }));
    const client = makeClient();
    const engine = new SyncEngine(client, vault, state, jest.fn(), '.obsidian');

    await engine.reconcileDeletions();

    expect(client.deleteFile).not.toHaveBeenCalled();
    expect(state.files['a.md']).toBeDefined();
  });

  test('skips excluded paths', async () => {
    const vault = makeVault({ 'other.md': 'x' });
    const state = await createState(makeStorage({ files: tracked('other.md', 'private/secret.md') }));
    const client = makeClient();
    const engine = new SyncEngine(client, vault, state, jest.fn(), '.obsidian');

    await engine.reconcileDeletions((p) => p.startsWith('private/'));

    expect(client.deleteFile).not.toHaveBeenCalled();
    expect(state.files['private/secret.md']).toBeDefined();
  });

  test('keeps the state entry when the server refuses (409: changed elsewhere)', async () => {
    const vault = makeVault({ 'other.md': 'x' });
    const state = await createState(makeStorage({ files: tracked('other.md', 'gone.md') }));
    const client = makeClient({
      deleteFile: jest.fn(async () => { throw new Error('deleteFile failed: 409'); }),
    });
    const engine = new SyncEngine(client, vault, state, jest.fn(), '.obsidian');

    await expect(engine.reconcileDeletions()).resolves.toBeUndefined();

    expect(state.files['gone.md']).toBe('hash-gone.md');
  });

  test('asks before a mass deletion and sends nothing when declined', async () => {
    const files: Record<string, string> = {};
    const onDisk: Record<string, string> = { 'a0.md': 'x' };
    for (let i = 0; i < 10; i++) files[`a${i}.md`] = `h${i}`;
    const vault = makeVault(onDisk);
    const state = await createState(makeStorage({ files }));
    const client = makeClient();
    const onMassChange = jest.fn(async () => false);
    const engine = new SyncEngine(client, vault, state, jest.fn(), '.obsidian', onMassChange);

    await engine.reconcileDeletions();

    expect(onMassChange).toHaveBeenCalledWith(9, 10);
    expect(client.deleteFile).not.toHaveBeenCalled();
    expect(Object.keys(state.files)).toHaveLength(10);
  });

  test('applies a mass deletion once the user confirms', async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 10; i++) files[`a${i}.md`] = `h${i}`;
    const vault = makeVault({ 'a0.md': 'x' });
    const state = await createState(makeStorage({ files }));
    const client = makeClient();
    const engine = new SyncEngine(client, vault, state, jest.fn(), '.obsidian', jest.fn(async () => true));

    await engine.reconcileDeletions();

    expect(client.deleteFile).toHaveBeenCalledTimes(9);
  });

  test('a small deletion does not prompt', async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 20; i++) files[`a${i}.md`] = `h${i}`;
    const onDisk: Record<string, string> = {};
    for (let i = 0; i < 19; i++) onDisk[`a${i}.md`] = 'x';
    const vault = makeVault(onDisk);
    const state = await createState(makeStorage({ files }));
    const client = makeClient();
    const onMassChange = jest.fn(async () => true);
    const engine = new SyncEngine(client, vault, state, jest.fn(), '.obsidian', onMassChange);

    await engine.reconcileDeletions();

    expect(onMassChange).not.toHaveBeenCalled();
    expect(client.deleteFile).toHaveBeenCalledWith('a19.md', 'h19');
  });
});

describe('initialSync: does not resurrect server-side deletions', () => {
  const DELETED_AT = 1000; // server ts, seconds

  function serverWithDeleted(path: string) {
    return makeClient({
      getChanges: jest.fn(async () => [
        { path, hash: 'h', ts: DELETED_AT - 100, action: 'modified' as const },
        { path, hash: '', ts: DELETED_AT, action: 'deleted' as const },
      ]),
    });
  }

  test('skips an old local copy of a deleted file and reports it', async () => {
    const vault = makeVault({ 'stale.md': 'old copy', 'fresh.md': 'new' });
    vault.mtime.mockImplementation(async (p) => (p === 'stale.md' ? (DELETED_AT - 50) * 1000 : null));
    const state = await createState(makeStorage({}));
    const client = serverWithDeleted('stale.md');
    const engine = new SyncEngine(client, vault, state, jest.fn(), '.obsidian');

    const result = await engine.initialSync();

    expect(client.putFile).not.toHaveBeenCalledWith('stale.md', expect.anything(), expect.anything());
    expect(client.putFile).toHaveBeenCalledWith('fresh.md', expect.anything(), '');
    expect(result.skippedDeleted).toEqual(['stale.md']);
  });

  test('requires confirmation even if local mtime is newer than server deletion', async () => {
    const vault = makeVault({ 'back.md': 'recreated' });
    vault.mtime.mockImplementation(async () => (DELETED_AT + 50) * 1000);
    const state = await createState(makeStorage({}));
    const client = serverWithDeleted('back.md');
    const engine = new SyncEngine(client, vault, state, jest.fn(), '.obsidian');

    const result = await engine.initialSync();

    expect(client.putFile).not.toHaveBeenCalled();
    expect(result.skippedDeleted).toEqual(['back.md']);
    expect(state.conflicts['back.md']).toBe('deleted');
  });

  test('requires confirmation when deletion conflicts with an unknown modification time', async () => {
    const vault = makeVault({ 'x.md': 'c' });
    const state = await createState(makeStorage({}));
    const client = serverWithDeleted('x.md');
    const engine = new SyncEngine(client, vault, state, jest.fn(), '.obsidian');

    const result = await engine.initialSync();

    expect(client.putFile).not.toHaveBeenCalled();
    expect(result.skippedDeleted).toEqual(['x.md']);
  });
});

// --- pull speed-up: collapse, skip, batching, concurrency, coalescing ---

const buf = (s: string) => new TextEncoder().encode(s).buffer as ArrayBuffer;

test('pull: downloads a path once however many times the server lists it', async () => {
  const vault = makeVault({});
  const state = await createState(makeStorage({}));
  const client = makeClient({
    getChanges: jest.fn(async () => [
      { path: 'a.md', hash: 'h1', ts: 10, action: 'modified' as const },
      { path: 'a.md', hash: 'h2', ts: 20, action: 'modified' as const },
      { path: 'a.md', hash: 'h3', ts: 30, action: 'modified' as const },
    ]),
    getFile: jest.fn(async () => buf('v3')),
  });

  const engine = new SyncEngine(client, vault, state, jest.fn(), '.obsidian');
  await engine.pull();

  expect(client.getFile).toHaveBeenCalledTimes(1);
  expect(state.files['a.md']).toBe('h3');
  expect(state.lastSyncTimestamp).toBe(30);
});

test('pull: modified then deleted ends up deleted and downloads nothing', async () => {
  const vault = makeVault({ 'a.md': 'old' });
  const state = await createState(makeStorage({ files: { 'a.md': await sha256hex(buf('old')) } }));
  const client = makeClient({
    getChanges: jest.fn(async () => [
      { path: 'a.md', hash: 'h1', ts: 10, action: 'modified' as const },
      { path: 'a.md', hash: '', ts: 20, action: 'deleted' as const },
    ]),
  });

  const engine = new SyncEngine(client, vault, state, jest.fn(), '.obsidian');
  await engine.pull();

  expect(client.getFile).not.toHaveBeenCalled();
  expect(vault.deleteFile).toHaveBeenCalledWith('a.md');
  expect(state.files['a.md']).toBeUndefined();
});

test('pull: does not download a file whose hash already matches', async () => {
  const vault = makeVault({ 'a.md': 'same' });
  const state = await createState(makeStorage({ files: { 'a.md': 'h1' } }));
  const client = makeClient({
    getChanges: jest.fn(async () => [{ path: 'a.md', hash: 'h1', ts: 50, action: 'modified' as const }]),
  });

  const engine = new SyncEngine(client, vault, state, jest.fn(), '.obsidian');
  const r = await engine.pull();

  expect(client.getFile).not.toHaveBeenCalled();
  expect(vault.writeFile).not.toHaveBeenCalled();
  expect(r).toMatchObject({ downloaded: 0, skipped: 1 });
  expect(state.lastSyncTimestamp).toBe(50); // cursor still advances
});

test('pull: downloads at most 4 files at once', async () => {
  const vault = makeVault({});
  const state = await createState(makeStorage({}));
  let inFlight = 0;
  let peak = 0;
  const client = makeClient({
    getChanges: jest.fn(async () =>
      Array.from({ length: 20 }, (_, i) => ({ path: `f${i}.md`, hash: `h${i}`, ts: i + 1, action: 'modified' as const })),
    ),
    getFile: jest.fn(async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      for (let i = 0; i < 5; i++) await Promise.resolve(); // let other downloads start
      inFlight--;
      return buf('x');
    }),
  });

  const engine = new SyncEngine(client, vault, state, jest.fn(), '.obsidian');
  await engine.pull();

  expect(client.getFile).toHaveBeenCalledTimes(20);
  expect(peak).toBeLessThanOrEqual(4);
  expect(peak).toBeGreaterThan(1);
});

test('pull: one failing file does not stop the others and is logged', async () => {
  const { SyncLog } = await import('../synclog');
  const log = new SyncLog();
  const vault = makeVault({});
  const state = await createState(makeStorage({}));
  const client = makeClient({
    getChanges: jest.fn(async () => [
      { path: 'bad.md', hash: 'b', ts: 1, action: 'modified' as const },
      { path: 'good.md', hash: 'g', ts: 2, action: 'modified' as const },
    ]),
    getFile: jest.fn(async (p: string) => {
      if (p === 'bad.md') throw new Error('getFile failed: 404');
      return buf('ok');
    }),
  });

  const engine = new SyncEngine(client, vault, state, jest.fn(), '.obsidian', undefined, log);
  const r = await engine.pull();

  expect(r).toMatchObject({ downloaded: 1, failed: 1 });
  expect(state.files['good.md']).toBe('g');
  expect(state.lastSyncTimestamp).toBe(0);
  const text = log.toText();
  expect(text).toContain('error');
  expect(text).toContain('bad.md');
  expect(text).toContain('getFile failed: 404');
});

test('pull: persists state in batches, not once per file, and once at the end', async () => {
  const vault = makeVault({});
  const storage = makeStorage({});
  const state = await createState(storage);
  const client = makeClient({
    getChanges: jest.fn(async () =>
      Array.from({ length: 120 }, (_, i) => ({ path: `f${i}.md`, hash: `h${i}`, ts: i + 1, action: 'modified' as const })),
    ),
    getFile: jest.fn(async () => buf('x')),
  });

  const engine = new SyncEngine(client, vault, state, jest.fn(), '.obsidian');
  await engine.pull();

  // 120 files: flushes at 50 and 100, plus the final one — not 120+.
  expect((storage.save as jest.Mock).mock.calls.length).toBeLessThanOrEqual(4);
  const saved = (storage.save as jest.Mock).mock.calls.at(-1)[0];
  expect(Object.keys(saved.files)).toHaveLength(120);
  expect(saved.lastSyncTimestamp).toBe(120);
  expect(state.deferSaves).toBe(false);
});

test('pull: state is saved even when the pull throws midway', async () => {
  const vault = makeVault({});
  const storage = makeStorage({});
  const state = await createState(storage);
  const client = makeClient({
    getChanges: jest.fn(async () => [{ path: 'a.md', hash: 'h', ts: 1, action: 'modified' as const }]),
    getFile: jest.fn(async () => buf('x')),
  });
  const engine = new SyncEngine(client, vault, state, jest.fn(), '.obsidian');
  // Make the cursor write blow up: hashes already applied must still be flushed.
  state.setLastSyncTimestamp = jest.fn(async () => { throw new Error('disk full'); });

  await expect(engine.pull()).rejects.toThrow('disk full');
  expect(state.deferSaves).toBe(false);
  const saved = (storage.save as jest.Mock).mock.calls.at(-1)[0];
  expect(saved.files['a.md']).toBe('h');
});

test('pull: a second call during a pull does not run concurrently, but is not lost', async () => {
  const vault = makeVault({});
  const state = await createState(makeStorage({}));
  let release!: () => void;
  const gate = new Promise<void>(r => { release = r; });
  let running = 0;
  let peak = 0;
  let calls = 0;
  const client = makeClient({
    getChanges: jest.fn(async () => {
      calls++;
      running++;
      peak = Math.max(peak, running);
      if (calls === 1) await gate;
      running--;
      return [];
    }),
  });

  const engine = new SyncEngine(client, vault, state, jest.fn(), '.obsidian');
  const first = engine.pull();
  await new Promise<void>(resolve => setImmediate(resolve));
  const second = engine.pull(); // e.g. SSE event or poll timer mid-pull
  release();
  await Promise.all([first, second]);

  expect(peak).toBe(1);
  expect(calls).toBe(2); // the mid-pull signal triggered one follow-up pull
});

test('pull: overlapping signals coalesce into a single follow-up', async () => {
  const vault = makeVault({});
  const state = await createState(makeStorage({}));
  let release!: () => void;
  const gate = new Promise<void>(r => { release = r; });
  let calls = 0;
  const client = makeClient({
    getChanges: jest.fn(async () => {
      calls++;
      if (calls === 1) await gate;
      return [];
    }),
  });
  const engine = new SyncEngine(client, vault, state, jest.fn(), '.obsidian');
  const first = engine.pull();
  await new Promise<void>(resolve => setImmediate(resolve));
  const all = [first, engine.pull(), engine.pull(), engine.pull()];
  release();
  await Promise.all(all);
  expect(calls).toBe(2);
});
