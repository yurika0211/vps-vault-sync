/**
 * `**` matches across `/`, including nested segments.
 * A pattern whose only wildcard is `*` (no `**`) also matches across `/`,
 * so `*.exe` excludes `tools/helper.exe`. When `**` is present, a lone `*`
 * stays inside one segment (`plugins/ * /main.js`).
 */
export function matchGlob(pattern: string, path: string): boolean {
  const STARSTAR = '\u0000';
  const star = pattern.includes('**') ? '[^/]*' : '.*';
  const source = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, STARSTAR)
    .replace(/\*/g, star)
    .replace(new RegExp(STARSTAR, 'g'), '.*');
  return new RegExp('^' + source + '$').test(path);
}

export function defaultExcludePatterns(configDir: string): string[] {
  return [
    `${configDir}/workspace.json`,
    `${configDir}/workspace-mobile.json`,
    '*.exe',
    '*.zip',
    'lh-windows-amd64-*/**',
    'Obsidian-remote-template*',
    '.obsidian，/**',
    `${configDir}/plugins/*/main.js`,
  ];
}

export async function sha256hex(data: ArrayBuffer): Promise<string> {
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hashBuffer))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Runs `fn` over `items` with at most `limit` calls in flight. Never rejects on
 * its own: `fn` is expected to handle its own errors (a thrown error would
 * stop that worker only and surface from the returned promise).
 */
export async function runPool<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const item = items[next++];
      await fn(item);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}
