import {
  dismissConflict,
  keepLocal,
  keepServer,
  listConflicts,
  listRemoteConflicts,
  listVaultConflicts,
  parseLocalConflictPath,
  parseRemoteConflictPath,
} from '../conflicts';
import type { ConflictClient, ConflictItem, ConflictVault } from '../conflicts';
import { sha256hex } from '../util';

function bytes(text: string): ArrayBuffer {
  return new TextEncoder().encode(text).buffer as ArrayBuffer;
}

function item(partial: Partial<ConflictItem> & Pick<ConflictItem, 'originalPath' | 'conflictPath'>): ConflictItem {
  return {
    copyLocation: 'vault',
    canonical: 'local-file',
    ...partial,
  };
}

test('parseLocalConflictPath recovers the original note', () => {
  expect(parseLocalConflictPath('notes/a.conflict.phone.2026-11-12T01-02-03-004Z.md'))
    .toEqual({ originalPath: 'notes/a.md' });
  expect(parseLocalConflictPath('notes/a.md')).toBeNull();
});

test('parseRemoteConflictPath recovers the original note', () => {
  expect(parseRemoteConflictPath('notes/foo.conflict.2006-01-02T15-04-05.000000000.md'))
    .toEqual({ originalPath: 'notes/foo.md' });
  expect(parseRemoteConflictPath('notes/foo.conflict.phone.2026-11-12T01-02-03-004Z.md')).toBeNull();
  expect(parseLocalConflictPath('notes/foo.conflict.2006-01-02T15-04-05.000000000.md')).toBeNull();
});

test('listVaultConflicts and listRemoteConflicts keep the two copy kinds apart', () => {
  const vault = listVaultConflicts([
    'notes/a.md',
    'notes/a.conflict.local.2026-11-12T01-02-03-004Z.md',
  ]);
  expect(vault).toEqual([
    {
      originalPath: 'notes/a.md',
      conflictPath: 'notes/a.conflict.local.2026-11-12T01-02-03-004Z.md',
      copyLocation: 'vault',
      canonical: 'local-file',
    },
  ]);

  const remote = listRemoteConflicts([
    { path: 'notes/a.md', hash: 'canon', action: 'modified' },
    { path: 'notes/a.conflict.2006-01-02T15-04-05.000000000.md', hash: 'copy', action: 'modified' },
    { path: 'notes/a.conflict.2006-01-02T15-04-06.000000000.md', hash: 'gone', action: 'deleted' },
  ]);
  expect(remote.map(row => row.conflictPath)).toEqual([
    'notes/a.conflict.2006-01-02T15-04-05.000000000.md',
  ]);
  expect(remote[0].canonical).toBe('server');
});

test('listConflicts still shows vault siblings when the server listing fails', async () => {
  const listed = await listConflicts(
    { listAll: async () => ['notes/a.conflict.local.2026-11-12T01-02-03-004Z.md'] },
    { getChanges: async () => { throw new Error('offline'); } },
  );
  expect(listed.items).toHaveLength(1);
  expect(listed.remoteError).toBe('offline');
});

test('keepLocal refuses to upload when the base hash does not match', async () => {
  const data = bytes('local');
  const puts: string[] = [];
  const client: ConflictClient = {
    getChanges: async () => [{ path: 'notes/a.md', hash: 'server-hash', action: 'modified' }],
    getFile: async () => bytes('server'),
    putFile: async (_path, _data, baseHash) => {
      puts.push(baseHash);
      return { conflict: true, currentHash: 'server-hash' };
    },
    deleteFile: async () => {},
  };
  const result = await keepLocal(
    item({ originalPath: 'notes/a.md', conflictPath: 'notes/a.conflict.local.2026-11-12T01-02-03-004Z.md' }),
    { readFile: async () => data },
    client,
  );
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.reason).toBe('base-mismatch');
  expect(puts).toEqual(['server-hash']);
});

test('keepLocal uploads the original bytes only with the current canonical hash', async () => {
  const data = bytes('local');
  const hash = await sha256hex(data);
  const client: ConflictClient = {
    getChanges: async () => [{ path: 'notes/a.md', hash: 'server-hash', action: 'modified' }],
    getFile: async () => bytes('server'),
    putFile: async () => ({ conflict: false, currentHash: hash }),
    deleteFile: async () => {},
  };
  const result = await keepLocal(
    item({ originalPath: 'notes/a.md', conflictPath: 'notes/a.conflict.local.2026-11-12T01-02-03-004Z.md' }),
    { readFile: async () => data },
    client,
  );
  expect(result).toEqual({ ok: true, hash });
});

test('keepServer downloads the verified canonical bytes without uploading a conflict copy', async () => {
  const incoming = bytes('server copy');
  const hash = await sha256hex(incoming);
  const written: string[] = [];
  const client: ConflictClient = {
    getChanges: async () => [{ path: 'notes/a.md', hash, action: 'modified' }],
    getFile: async () => incoming,
    putFile: async (_path, _data, baseHash) => {
      expect(baseHash).toBe('old');
      return { conflict: false, currentHash: hash };
    },
    deleteFile: async () => {},
  };
  const vault: Pick<ConflictVault, 'readFile' | 'writeFile'> = {
    readFile: async () => incoming,
    writeFile: async (path) => { written.push(path); },
  };
  const result = await keepServer(
    item({ originalPath: 'notes/a.md', conflictPath: 'notes/a.conflict.local.2026-11-12T01-02-03-004Z.md' }),
    vault,
    client,
  );
  expect(result).toEqual({ ok: true, hash });
  expect(written).toEqual(['notes/a.md']);
});

test('keepServer does not write the original when the upload conflicts', async () => {
  const written: string[] = [];
  const client: ConflictClient = {
    getChanges: async () => [{ path: 'notes/a.md', hash: 'old', action: 'modified' }],
    getFile: async () => bytes('incoming'),
    putFile: async () => ({ conflict: true, currentHash: 'old' }),
    deleteFile: async () => {},
  };
  const result = await keepServer(
    item({
      originalPath: 'notes/a.md',
      conflictPath: 'notes/a.conflict.2006-01-02T15-04-05.000000000.md',
      copyLocation: 'server',
      canonical: 'server',
    }),
    { readFile: async () => bytes('nope'), writeFile: async (path) => { written.push(path); } },
    client,
  );
  expect(result.ok).toBe(false);
  expect(written).toEqual([]);
});

test('dismiss deletes the sibling and leaves the original path alone', async () => {
  const deleted: string[] = [];
  const result = await dismissConflict(
    item({ originalPath: 'notes/a.md', conflictPath: 'notes/a.conflict.local.2026-11-12T01-02-03-004Z.md' }),
    { deleteFile: async (path) => { deleted.push(path); } },
    {
      getChanges: async () => [],
      deleteFile: async (path) => { deleted.push(`server:${path}`); },
    },
  );
  expect(result).toEqual({ ok: true });
  expect(deleted).toEqual(['notes/a.conflict.local.2026-11-12T01-02-03-004Z.md']);
});
