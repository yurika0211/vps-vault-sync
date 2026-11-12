import { writeFileResilient, ensureFolder, MinimalVault } from '../vaultio';

// Fake adapter backed by a flat path set, modelling Obsidian's DataAdapter.
// `mkdirThrowsOnExisting` reproduces the platforms where mkdir on an existing
// folder rejects with "already exists" instead of being a silent no-op.
function makeFakeVault(opts: { mkdirThrowsOnExisting?: boolean } = {}) {
  const dirs = new Set<string>();
  const files = new Map<string, Uint8Array>();
  const vault: MinimalVault & { _dirs: Set<string>; _files: Map<string, Uint8Array> } = {
    _dirs: dirs,
    _files: files,
    adapter: {
      exists: jest.fn(async (p: string) => dirs.has(p) || files.has(p)),
      mkdir: jest.fn(async (p: string) => {
        if (dirs.has(p) && opts.mkdirThrowsOnExisting) throw new Error('Folder already exists.');
        dirs.add(p);
      }),
      writeBinary: jest.fn(async (p: string, data: ArrayBuffer) => {
        files.set(p, new Uint8Array(data));
      }),
    },
  };
  return vault;
}

const buf = (s: string) => new TextEncoder().encode(s).buffer as ArrayBuffer;

test('writeFileResilient: creates missing parent folders then writes', async () => {
  const vault = makeFakeVault();
  await writeFileResilient(vault, 'wiki/meta/a.md', buf('A'));
  expect(vault._dirs.has('wiki')).toBe(true);
  expect(vault._dirs.has('wiki/meta')).toBe(true);
  expect(new TextDecoder().decode(vault._files.get('wiki/meta/a.md'))).toBe('A');
});

test('writeFileResilient: sequential files in same folder do not double-create or throw', async () => {
  // mkdir would throw on the already-existing folder for the 2nd file — must be tolerated.
  const vault = makeFakeVault({ mkdirThrowsOnExisting: true });
  await expect(writeFileResilient(vault, 'wiki/meta/a.md', buf('A'))).resolves.toBeUndefined();
  await expect(writeFileResilient(vault, 'wiki/meta/b.md', buf('B'))).resolves.toBeUndefined();
  expect(vault._files.has('wiki/meta/a.md')).toBe(true);
  expect(vault._files.has('wiki/meta/b.md')).toBe(true);
  // wiki + wiki/meta created exactly once each (exists() guards the rest).
  expect(vault.adapter.mkdir).toHaveBeenCalledTimes(2);
});

test('writeFileResilient: overwrites an existing file unconditionally', async () => {
  const vault = makeFakeVault();
  vault._files.set('note.md', new Uint8Array());
  await writeFileResilient(vault, 'note.md', buf('hello'));
  expect(new TextDecoder().decode(vault._files.get('note.md'))).toBe('hello');
});

test('writeFileResilient: top-level file needs no folder creation', async () => {
  const vault = makeFakeVault();
  await writeFileResilient(vault, 'root.md', buf('r'));
  expect(vault.adapter.mkdir).not.toHaveBeenCalled();
  expect(vault._files.has('root.md')).toBe(true);
});

test('ensureFolder: rethrows non-"already exists" errors', async () => {
  const vault = makeFakeVault();
  (vault.adapter.mkdir as jest.Mock).mockRejectedValueOnce(new Error('EACCES: permission denied'));
  await expect(ensureFolder(vault, 'locked')).rejects.toThrow('EACCES');
});

import { pruneEmptyParents, PruneVault } from '../vaultio';

// Fake disk: a set of folders and a set of files; list() returns direct children.
function makeFsVault(folders: string[], files: string[]): PruneVault & { _folders: Set<string> } {
  const dirs = new Set(folders);
  const fls = new Set(files);
  const children = (dir: string) => {
    const prefix = dir ? `${dir}/` : '';
    const direct = (p: string) => p.startsWith(prefix) && !p.slice(prefix.length).includes('/');
    return { files: [...fls].filter(direct), folders: [...dirs].filter(direct) };
  };
  return {
    _folders: dirs,
    adapter: {
      exists: jest.fn(async (p: string) => dirs.has(p) || fls.has(p)),
      mkdir: jest.fn(async () => {}),
      writeBinary: jest.fn(async () => {}),
      list: jest.fn(async (p: string) => children(p)),
      rmdir: jest.fn(async (p: string) => {
        const c = children(p);
        if (c.files.length || c.folders.length) throw new Error('Directory not empty');
        dirs.delete(p);
      }),
    },
  };
}

describe('pruneEmptyParents', () => {
  test('removes empty parents upward and stops at the first non-empty one', async () => {
    const vault = makeFsVault(['A', 'A/B'], ['A/keep.md']);
    await pruneEmptyParents(vault, 'A/B/old.md', '.obsidian');
    expect(vault._folders.has('A/B')).toBe(false);
    expect(vault._folders.has('A')).toBe(true);
  });

  test('removes the whole chain when everything above is empty', async () => {
    const vault = makeFsVault(['A', 'A/B', 'A/B/C'], []);
    await pruneEmptyParents(vault, 'A/B/C/old.md', '.obsidian');
    expect([...vault._folders]).toEqual([]);
  });

  test('keeps a folder that still holds a non-synced file', async () => {
    const vault = makeFsVault(['A'], ['A/.DS_Store']);
    await pruneEmptyParents(vault, 'A/old.md', '.obsidian');
    expect(vault._folders.has('A')).toBe(true);
  });

  test('keeps a folder that still has a subfolder', async () => {
    const vault = makeFsVault(['A', 'A/sub'], []);
    await pruneEmptyParents(vault, 'A/old.md', '.obsidian');
    expect(vault._folders.has('A')).toBe(true);
  });

  test('does nothing for a file in the vault root', async () => {
    const vault = makeFsVault([], []);
    await pruneEmptyParents(vault, 'old.md', '.obsidian');
    expect(vault.adapter.rmdir).not.toHaveBeenCalled();
  });

  test('never touches the config folder', async () => {
    const vault = makeFsVault(['.obsidian', '.obsidian/plugins'], []);
    await pruneEmptyParents(vault, '.obsidian/plugins/x.md', '.obsidian');
    expect(vault.adapter.rmdir).not.toHaveBeenCalled();
  });

  test('tolerates a parent that is already gone', async () => {
    const vault = makeFsVault(['A'], []);
    await expect(pruneEmptyParents(vault, 'A/B/old.md', '.obsidian')).resolves.toBeUndefined();
    expect(vault._folders.has('A')).toBe(false);
  });
});
