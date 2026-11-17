import { requestUrl } from 'obsidian';

export interface Change {
  path: string;
  hash: string;
  ts: number; // server-side Unix timestamp (changelog `ts` field)
  action: 'modified' | 'deleted';
}

export interface ChangePage { changes: Change[]; cursor: number; hasMore: boolean }

export class SyncClient {
  constructor(private serverUrl: string, private authToken: string) {}

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return { Authorization: `Bearer ${this.authToken}`, ...extra };
  }

  async getChangePage(cursor: number): Promise<ChangePage> {
    const resp = await requestUrl({ url: `${this.serverUrl}/changes?cursor=${cursor}&limit=256`, headers: this.headers(), throw: false });
    if (resp.status >= 400) throw new Error(`getChanges failed: ${resp.status}`);
    const page = resp.json as ChangePage;
    if (!page || !Array.isArray(page.changes) || !Number.isSafeInteger(page.cursor) || page.cursor < cursor || typeof page.hasMore !== 'boolean' || (page.hasMore && page.cursor === cursor)) {
      throw new Error('Server does not support safe sync cursors. Update the server first.');
    }
    return page;
  }

  async getSnapshot(): Promise<ChangePage> {
    const latest = new Map<string, Change>();
    let cursor = 0;
    for (;;) {
      const page = await this.getChangePage(cursor);
      for (const change of page.changes) latest.set(change.path, change);
      cursor = page.cursor;
      if (!page.hasMore) return { changes: [...latest.values()], cursor, hasMore: false };
    }
  }

  async getFileInfo(path: string): Promise<{ hash: string; action: string } | null> {
    const resp = await requestUrl({ url: `${this.serverUrl}/file-info/${encodeFilePath(path)}`, headers: this.headers(), throw: false });
    if (resp.status === 404) return null;
    if (resp.status >= 400) throw new Error(`getFileInfo failed: ${resp.status}`);
    return resp.json as { hash: string; action: string };
  }

  async getConflicts(): Promise<Change[]> {
    const resp = await requestUrl({ url: `${this.serverUrl}/conflicts`, headers: this.headers(), throw: false });
    if (resp.status >= 400) throw new Error(`getConflicts failed: ${resp.status}`);
    return resp.json as Change[];
  }

  async getChanges(since: number): Promise<Change[]> {
    const resp = await requestUrl({
      url: `${this.serverUrl}/changes?since=${since}`,
      headers: this.headers(),
      throw: false,
    });
    if (resp.status >= 400) throw new Error(`getChanges failed: ${resp.status}`);
    // requestUrl types `.json` as `any`; assert the shape we expect from the
    // server rather than letting `any` propagate to callers.
    return resp.json as Change[];
  }

  async getFile(path: string): Promise<ArrayBuffer> {
    const resp = await requestUrl({
      url: `${this.serverUrl}/file/${encodeFilePath(path)}`,
      headers: this.headers(),
      throw: false,
    });
    if (resp.status >= 400) throw new Error(`getFile failed: ${resp.status}`);
    return resp.arrayBuffer;
  }

  async getFileAt(path: string, hash: string): Promise<ArrayBuffer> {
    const resp = await requestUrl({ url: `${this.serverUrl}/file/${encodeFilePath(path)}?hash=${encodeURIComponent(hash)}`, headers: this.headers(), throw: false });
    if (resp.status >= 400) throw new Error(`getFile failed: ${resp.status}`);
    const { sha256hex } = await import('./util');
    if (await sha256hex(resp.arrayBuffer) !== hash) throw new Error('Downloaded content does not match its version');
    return resp.arrayBuffer;
  }

  async putFile(path: string, data: ArrayBuffer, baseHash: string): Promise<{ conflict: boolean; currentHash?: string }> {
    const resp = await requestUrl({
      url: `${this.serverUrl}/file/${encodeFilePath(path)}`,
      method: 'PUT',
      headers: this.headers({ 'X-Base-Hash': baseHash }),
      body: data,
      throw: false,
    });
    if (resp.status >= 400) throw new Error(`putFile failed: ${resp.status}`);
    return {
      conflict: getHeader(resp.headers, 'x-conflict') === 'true',
      currentHash: getHeader(resp.headers, 'x-current-hash'),
    };
  }

  async deleteFile(path: string, baseHash: string): Promise<void> {
    const resp = await requestUrl({
      url: `${this.serverUrl}/file/${encodeFilePath(path)}`,
      method: 'DELETE',
      headers: this.headers({ 'X-Base-Hash': baseHash }),
      throw: false,
    });
    if (resp.status >= 400 && resp.status !== 404) throw new Error(`deleteFile failed: ${resp.status}`);
  }
}

function encodeFilePath(path: string): string {
  return path.split('/').map(encodeURIComponent).join('/');
}

// requestUrl's response headers come back as a plain Record, with a key case
// that isn't documented as guaranteed-lowercase — look up case-insensitively
// rather than assume a specific casing.
function getHeader(headers: Record<string, string>, name: string): string | undefined {
  const lower = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === lower) return headers[key];
  }
  return undefined;
}
