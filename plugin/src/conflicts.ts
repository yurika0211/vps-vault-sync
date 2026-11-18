import type { SyncClient } from './client';
import type { VaultAdapter } from './engine';
import { sha256hex } from './util';

/**
 * Initial-sync sibling: `<stem>.conflict.<device>.<stamp><ext>`.
 * The stamp is an ISO time with `:` and `.` rewritten to `-`, and it ends in `Z`.
 */
const LOCAL_CONFLICT = /^(.*)\.conflict\.[^.]+\.\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d+Z(\.[^/]+)?$/;

/**
 * Server copy from a stale push: `<stem>.conflict.<timestamp><ext>`.
 * The timestamp is `2006-01-02T15-04-05.000000000` and does not end in `Z`.
 */
const REMOTE_CONFLICT = /^(.*)\.conflict\.\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.\d+(\.[^/]+)?$/;

export interface ConflictItem {
  originalPath: string;
  conflictPath: string;
  /** Where the conflict copy bytes live. The original path is never this copy. */
  copyLocation: 'vault' | 'server';
  /**
   * Daily-push copies: the server file is canonical.
   * Initial-sync siblings: the local original stayed canonical and the sibling holds the server bytes.
   */
  canonical: 'server' | 'local-file';
  remoteDeleted?: boolean;
  localDeleted?: boolean;
}

export interface ConflictVault {
  listAll(): Promise<string[]>;
  readFile(path: string): Promise<ArrayBuffer>;
  writeFile(path: string, data: ArrayBuffer): Promise<void>;
  deleteFile(path: string): Promise<void>;
  openFile(path: string): Promise<void>;
}

export interface ConflictClient {
  getChanges(since: number): Promise<Array<{ path: string; hash: string; action: 'modified' | 'deleted' }>>;
  getFile(path: string): Promise<ArrayBuffer>;
  putFile(path: string, data: ArrayBuffer, baseHash: string): Promise<{ conflict: boolean; currentHash?: string }>;
  deleteFile(path: string, baseHash: string): Promise<void>;
  getFileInfo?(path: string): Promise<{ hash: string; action: string } | null>;
}

export type ConflictActionResult =
  | { ok: true; hash?: string }
  | { ok: false; reason: 'base-mismatch' | 'missing' | 'error'; message: string };

export function parseLocalConflictPath(path: string): { originalPath: string } | null {
  const slash = path.lastIndexOf('/');
  const dir = slash >= 0 ? path.slice(0, slash + 1) : '';
  const base = slash >= 0 ? path.slice(slash + 1) : path;
  const match = LOCAL_CONFLICT.exec(base);
  if (!match) return null;
  return { originalPath: dir + match[1] + (match[2] ?? '') };
}

export function parseRemoteConflictPath(path: string): { originalPath: string } | null {
  const slash = path.lastIndexOf('/');
  const dir = slash >= 0 ? path.slice(0, slash + 1) : '';
  const base = slash >= 0 ? path.slice(slash + 1) : path;
  const match = REMOTE_CONFLICT.exec(base);
  if (!match) return null;
  return { originalPath: dir + match[1] + (match[2] ?? '') };
}

/** Latest non-deleted change per path. Same collapse the engine uses for a snapshot. */
export function latestLiveChanges(
  changes: Array<{ path: string; hash: string; action: 'modified' | 'deleted' }>,
): Map<string, string> {
  const live = new Map<string, string>();
  const deleted = new Set<string>();
  for (const change of changes) {
    if (change.action === 'deleted') {
      live.delete(change.path);
      deleted.add(change.path);
      continue;
    }
    deleted.delete(change.path);
    live.set(change.path, change.hash);
  }
  return live;
}

export function listVaultConflicts(paths: string[]): ConflictItem[] {
  const items: ConflictItem[] = [];
  for (const path of paths) {
    const local = parseLocalConflictPath(path);
    if (local) {
      items.push({
        originalPath: local.originalPath,
        conflictPath: path,
        copyLocation: 'vault',
        canonical: 'local-file',
      });
      continue;
    }
    const remote = parseRemoteConflictPath(path);
    if (!remote) continue;
    items.push({
      originalPath: remote.originalPath,
      conflictPath: path,
      copyLocation: 'vault',
      canonical: 'server',
    });
  }
  return sortConflicts(items);
}

export function listRemoteConflicts(
  changes: Array<{ path: string; hash: string; action: 'modified' | 'deleted' }>,
): ConflictItem[] {
  const live = latestLiveChanges(changes);
  const items: ConflictItem[] = [];
  for (const path of live.keys()) {
    const parsed = parseRemoteConflictPath(path);
    if (!parsed) continue;
    items.push({
      originalPath: parsed.originalPath,
      conflictPath: path,
      copyLocation: 'server',
      canonical: 'server',
    });
  }
  return sortConflicts(items);
}

function sortConflicts(items: ConflictItem[]): ConflictItem[] {
  return items.sort((a, b) => a.originalPath.localeCompare(b.originalPath) || a.conflictPath.localeCompare(b.conflictPath));
}

/**
 * Lists known conflicts without pushing or pulling.
 * Local siblings come from the vault listing. Remote copies come from
 * GET /conflicts, without scanning the complete history on each action.
 * Markdown conflict copies are not in the vault because the engine skips them.
 */
export async function listConflicts(
  vault: Pick<VaultAdapter, 'listAll'>,
  client: Pick<SyncClient, 'getChanges'> & Partial<Pick<SyncClient, 'getConflicts'>>,
): Promise<{ items: ConflictItem[]; remoteError?: string }> {
  const paths = await vault.listAll();
  const local = listVaultConflicts(paths);
  try {
    const remote = listRemoteConflicts(client.getConflicts ? await client.getConflicts() : await client.getChanges(0))
      .filter(item => !local.some(have => have.conflictPath === item.conflictPath));
    return { items: sortConflicts([...local, ...remote]) };
  } catch (e) {
    return { items: local, remoteError: messageOf(e) };
  }
}

/**
 * Make the local original the canonical server file.
 * The upload uses the hash the server already has as X-Base-Hash. A mismatch
 * is a conflict response: the canonical file is left alone.
 */
export async function keepLocal(
  item: ConflictItem,
  vault: Pick<ConflictVault, 'readFile'>,
  client: ConflictClient,
): Promise<ConflictActionResult> {
  if (item.localDeleted) {
    try {
      const hash = await canonicalHash(client, item.originalPath);
      if (hash !== null) await client.deleteFile(item.originalPath, hash);
      return { ok: true, hash: '' };
    } catch (e) { return { ok: false, reason: 'error', message: messageOf(e) }; }
  }
  let data: ArrayBuffer;
  try {
    data = await vault.readFile(item.originalPath);
  } catch (e) {
    return { ok: false, reason: 'missing', message: messageOf(e) };
  }
  const localHash = await sha256hex(data);
  try {
    const serverHash = await canonicalHash(client, item.originalPath);
    if (localHash === serverHash) return { ok: true, hash: localHash };
    const result = await client.putFile(item.originalPath, data, serverHash ?? '');
    if (result.conflict || (result.currentHash !== undefined && result.currentHash !== localHash)) {
      return {
        ok: false,
        reason: 'base-mismatch',
        message: `Canonical hash did not match. ${item.originalPath} was not overwritten.`,
      };
    }
  } catch (e) {
    return { ok: false, reason: 'error', message: messageOf(e) };
  }
  return { ok: true, hash: localHash };
}

/**
 * Replace the local original with current server bytes, checking both their
 * identity and any intervening local edit before writing. Conflict siblings
 * are recovery copies and never stand in for the canonical server version.
 */
export async function keepServer(
  item: ConflictItem,
  vault: Pick<ConflictVault, 'readFile' | 'writeFile'> & Partial<Pick<ConflictVault, 'deleteFile'>>,
  client: ConflictClient,
): Promise<ConflictActionResult> {
  try {
    const before = await vault.readFile(item.originalPath).catch(() => null);
    const serverHash = await canonicalHash(client, item.originalPath);
    if (serverHash === null) {
      if (!item.remoteDeleted || !vault.deleteFile) return { ok: false, reason: 'missing', message: 'The server file no longer exists. Refresh the conflict panel.' };
      const after = await vault.readFile(item.originalPath).catch(() => null);
      if ((before === null) !== (after === null) || (before && after && await sha256hex(before) !== await sha256hex(after))) {
        return { ok: false, reason: 'base-mismatch', message: 'Local file changed while resolving. Review the latest edits and retry.' };
      }
      await vault.deleteFile(item.originalPath);
      return { ok: true, hash: '' };
    }
    // Server conflict copies contain rejected client bytes, not canonical
    // server bytes. Read the original path and verify its current identity.
    const incoming = await client.getFile(item.originalPath);
    const incomingHash = await sha256hex(incoming);
    if (incomingHash !== serverHash) return { ok: false, reason: 'base-mismatch', message: 'Server file changed during download. Refresh and retry.' };
    const after = await vault.readFile(item.originalPath).catch(() => null);
    if ((before === null) !== (after === null) || (before && after && await sha256hex(before) !== await sha256hex(after))) {
      return { ok: false, reason: 'base-mismatch', message: 'Local file changed while resolving. Review the latest edits and retry.' };
    }
    await vault.writeFile(item.originalPath, incoming);
    return { ok: true, hash: incomingHash };
  } catch (e) {
    return { ok: false, reason: 'error', message: messageOf(e) };
  }
}

/** Delete one conflict copy. Does not touch the original path. */
export async function dismissConflict(
  item: ConflictItem,
  vault: Pick<ConflictVault, 'deleteFile'>,
  client: Pick<ConflictClient, 'deleteFile' | 'getChanges'>,
): Promise<ConflictActionResult> {
  try {
    if (item.copyLocation === 'server' || parseRemoteConflictPath(item.conflictPath)) {
      const hash = await canonicalHash(client, item.conflictPath);
      if (hash !== null) await client.deleteFile(item.conflictPath, hash);
    }
    if (item.copyLocation === 'vault') await vault.deleteFile(item.conflictPath);
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: 'error', message: messageOf(e) };
  }
}

async function canonicalHash(client: Pick<ConflictClient, 'getChanges' | 'getFileInfo'>, path: string): Promise<string | null> {
  if (client.getFileInfo) { const info = await client.getFileInfo(path); return info?.action === 'modified' ? info.hash : null; }
  const changes = await client.getChanges(0);
  return latestLiveChanges(changes).get(path) ?? null;
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
