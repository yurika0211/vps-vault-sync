import { defaultExcludePatterns, sha256hex } from '../util';

test('sha256hex produces correct digest', async () => {
  const data = new TextEncoder().encode('hello');
  const hash = await sha256hex(data.buffer as ArrayBuffer);
  expect(hash).toBe('2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824');
});

test('sha256hex empty input', async () => {
  const hash = await sha256hex(new ArrayBuffer(0));
  expect(hash).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
});

function matchGlob(pattern: string, path: string): boolean {
  const regex = new RegExp(
    '^' +
    pattern
      .replace(/\./g, '\\.')
      .replace(/\*\*/g, '.*')
      .replace(/(?<!\.\*)\*/g, '[^/]*')
    + '$'
  );
  return regex.test(path);
}

test('default excludes keep workspace files and skip binaries, archives, and plugin bundles', () => {
  const excluded = (path: string) => defaultExcludePatterns('.obsidian').some(pat => matchGlob(pat, path));
  expect(excluded('.obsidian/workspace.json')).toBe(true);
  expect(excluded('.obsidian/workspace-mobile.json')).toBe(true);
  expect(excluded('helper.exe')).toBe(true);
  expect(excluded('bundle.zip')).toBe(true);
  expect(excluded('lh-windows-amd64-v1.3.0/lh')).toBe(true);
  expect(excluded('Obsidian-remote-template')).toBe(true);
  expect(excluded('Obsidian-remote-template.zip')).toBe(true);
  expect(excluded('.obsidian，/cache.json')).toBe(true);
  expect(excluded('.obsidian/plugins/vps-vault-sync/main.js')).toBe(true);
  expect(excluded('notes/keep.md')).toBe(false);
});
