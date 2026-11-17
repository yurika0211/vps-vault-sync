import type { SyncClient, Change } from './client';
import type { SyncState } from './state';
import { sha256hex, runPool } from './util';
import { errorMessage } from './errors';
import type { SyncLog } from './synclog';

export function isSafeVaultPath(path: string, configDir: string): boolean {
  if (!path || path.length === 0) return false;
  if (path.startsWith('/')) return false;
  if (path.includes('\\') || path.includes(':') || path.split('/').some(p => !p || p === '.' || p === '..')) return false;
  if (path === configDir || path.startsWith(`${configDir}/`)) return false;
  if (path.split('/').some(p => p === '.git' || p === '.trash')) return false;
  // eslint-disable-next-line no-control-regex -- deliberately matches control chars/null bytes to reject unsafe sync paths, not a mistake
  if (/[\x00-\x1f]/.test(path)) return false;
  return true;
}

export function isSafeSyncPath(path: string, configDir: string): boolean {
  return isSafeVaultPath(path, configDir) && !path.includes('.conflict.');
}

export interface VaultAdapter {
  readFile(path: string): Promise<ArrayBuffer>;
  writeFile(path: string, data: ArrayBuffer): Promise<void>;
  deleteFile(path: string): Promise<void>;
  listAll(): Promise<string[]>;
  // Whether the path is on disk right now. Asked per path (not derived from
  // listAll) so a stale or partial Obsidian cache can't make a file look gone.
  exists(path: string): Promise<boolean>;
  // Modification time in ms since epoch, or null if it can't be determined.
  mtime(path: string): Promise<number | null>;
  // Removes now-empty parent folders of a deleted file, upwards. Never removes
  // a folder that still holds anything.
  pruneEmptyParents(path: string): Promise<void>;
}

export interface InitialSyncResult {
  // Local files requiring an explicit restore because the server deleted them.
  skippedDeleted: string[];
}

// Give up on a reconcileDeletions pass after this many failed DELETEs — most
// likely we're offline, and every further request would fail the same way.
const RECONCILE_MAX_FAILURES = 5;

// Circuit breaker for pull(): if a single batch would touch this fraction of
// already-known files (or more)...
const MASS_CHANGE_RATIO = 0.5;
// ...AND at least this many files, ask before applying. The absolute floor
// keeps small vaults from tripping the breaker on one ordinary delete (2
// known files, 1 deleted = 50%).
const MASS_CHANGE_MIN_AFFECTED = 5;

// Files downloaded at once during a pull. One request at a time is bound by
// round-trip latency (~1 file/s on mobile); a handful in parallel hides it
// without hammering the server.
const PULL_CONCURRENCY = 4;
// Flush the hash map to data.json after this many files during a pull.
const PULL_SAVE_EVERY = 50;

export interface PullResult {
  changes: number; // entries left after collapsing to one per path
  downloaded: number; // files written or deleted locally
  skipped: number; // already up to date / unsafe path / kept local edit
  failed: number;
  blocked?: boolean;
}

// Keeps the last entry for each path, in order of those last entries.
function latestPerPath(changes: Change[]): Change[] {
  const last = new Map<string, number>();
  changes.forEach((c, i) => last.set(c.path, i));
  return changes.filter((c, i) => last.get(c.path) === i);
}

export class SyncEngine {
  constructor(
    private client: SyncClient,
    private vault: VaultAdapter,
    private state: SyncState,
    private onConflict: (path: string) => void,
    private configDir: string,
    // Called when a pull batch would delete/overwrite an unusually large
    // fraction of already-known files — e.g. a server-side bug reporting
    // most of the vault as deleted. Resolving false aborts the whole batch
    // (nothing applied, lastSyncTimestamp not advanced, so it's re-evaluated
    // next poll); resolving true applies it normally.
    private onMassChange: (affected: number, known: number, paths?: string[]) => Promise<boolean> = async () => true,
    private log?: SyncLog,
    private isExcluded: (path: string) => boolean = () => false,
  ) {}

  private tasks: Promise<unknown> = Promise.resolve();
  private stopped = false;
  private serial<T>(run: () => Promise<T>): Promise<T> {
    const next = this.tasks.catch(() => {}).then(() => {
      if (this.stopped) throw new Error('Sync paused');
      return run();
    });
    this.tasks = next;
    return next;
  }
  async stop(): Promise<void> { this.stopped = true; await this.tasks.catch(() => {}); }
  runExclusive<T>(action: () => Promise<T>): Promise<T> { return this.serial(action); }
  private allowed(path: string): boolean { return isSafeSyncPath(path, this.configDir) && !this.isExcluded(path); }
  private async conflict(path: string, remoteHash: string): Promise<void> {
    await this.state.setConflict(path, remoteHash || 'deleted');
    this.onConflict(path);
  }

  // pull() calls that arrive while one is running don't start a second one (the
  // poll timer fires every 30s and a big catch-up takes longer than that, so
  // overlapping pulls re-downloaded the same files). They are coalesced into
  // one more run after the current one, so a signal received mid-pull — an SSE
  // event, the app coming back to the foreground — is never lost.
  private pulling: Promise<PullResult> | null = null;
  private pullAgain = false;

  pull(): Promise<PullResult> {
    if (this.pulling) {
      this.pullAgain = true;
      return this.pulling;
    }
    this.pulling = this.serial(async () => {
      let total: PullResult = { changes: 0, downloaded: 0, skipped: 0, failed: 0 };
      try {
        do {
          this.pullAgain = false;
          const r = await this.pullOnce();
          total = {
            changes: total.changes + r.changes,
            downloaded: total.downloaded + r.downloaded,
            skipped: total.skipped + r.skipped,
            failed: total.failed + r.failed,
            blocked: total.blocked || r.blocked,
          };
        } while (this.pullAgain);
        return total;
      } finally {
        this.pulling = null;
      }
    });
    return this.pulling;
  }

  private async pullOnce(): Promise<PullResult> {
    const result: PullResult = { changes: 0, downloaded: 0, skipped: 0, failed: 0 };
    const page = this.client.getChangePage ? await this.client.getChangePage(this.state.cursor) : null;
    const raw = page ? page.changes : await this.client.getChanges(this.state.lastSyncTimestamp);
    if (raw.length === 0) return result;

    // Only the last entry per path in this page matters.
    const changes = latestPerPath(raw);
    result.changes = changes.length;

    const known = Object.keys(this.state.files).length;
    const affected = new Set(
      changes
        .filter(c => this.allowed(c.path) && (c.action === 'deleted' || c.hash !== this.state.files[c.path]))
        .map(c => c.path)
        .filter(path => path in this.state.files),
    ).size;

    const deletes = changes.filter(c => c.action === 'deleted' && this.allowed(c.path) && c.path in this.state.files).length;
    if ((affected >= MASS_CHANGE_MIN_AFFECTED && affected / known >= MASS_CHANGE_RATIO) || deletes >= 50) {
      const proceed = await this.onMassChange(affected, known, changes.filter(c => this.allowed(c.path)).map(c => `${c.action}: ${c.path}`));
      if (!proceed) return { ...result, blocked: true };
    }

    // Commit a cursor only when this page completes. Failed downloads remain
    // retriable, while successful paths are skipped by their stored hash.
    let maxTs = this.state.lastSyncTimestamp;
    for (const change of raw) {
      if (typeof change.ts === 'number' && change.ts > maxTs) maxTs = change.ts;
    }

    // Persist the hash map in batches instead of after every file, and always
    // once at the end (finally), so an interrupted pull loses at most a batch —
    // which only costs a re-check next time, never data.
    this.state.deferSaves = true;
    let processed = 0;
    try {
      await runPool(changes, PULL_CONCURRENCY, async (change) => {
        const outcome = await this.applyChange(change);
        if (outcome === 'downloaded') result.downloaded++;
        else if (outcome === 'skipped') result.skipped++;
        else result.failed++;
        if (++processed % PULL_SAVE_EVERY === 0) await this.state.flush();
      });
      if (result.failed === 0) {
        await this.state.setLastSyncTimestamp(maxTs);
        if (page) { await this.state.setCursor(page.cursor); this.pullAgain = this.pullAgain || page.hasMore; }
      }
    } finally {
      this.state.deferSaves = false;
      await this.state.flush();
    }

    this.log?.add(
      'pull',
      `${changes.length} change(s): ${result.downloaded} downloaded, ${result.skipped} up to date, ${result.failed} failed`,
    );
    await this.log?.save();
    return result;
  }

  // Applies one server change. Isolated per entry: one bad file (missing blob,
  // write failure) must not abort the whole pull. Without this, sync dies with a
  // generic error and never tells you which file broke.
  private async applyChange(change: Change): Promise<'downloaded' | 'skipped' | 'failed'> {
    if (!this.allowed(change.path)) {
      console.warn(`[vault-sync] pull: skipping unsafe path from server: ${change.path}`);
      return 'skipped';
    }

    try {
      if (change.action === 'deleted') {
        if (await this.vault.exists(change.path)) {
          const localHash = await sha256hex(await this.vault.readFile(change.path));
          if (localHash !== this.state.files[change.path]) {
            await this.conflict(change.path, 'deleted');
            return 'skipped';
          }
        }
        // A failed local delete must retain its state and retry. Echo events
        // are queued behind this operation and see the committed removal.
        await this.vault.deleteFile(change.path);
        await this.state.removeFileHash(change.path);
        await this.state.queue(change.path, null);
        await this.vault.pruneEmptyParents(change.path).catch(() => {});
        return 'downloaded';
      }

      // Already have exactly this version (e.g. the entry is our own push
      // coming back): nothing to download.
      if (this.state.files[change.path] === change.hash) return 'skipped';

      if (this.state.pending[change.path] === 'delete') {
        await this.conflict(change.path, change.hash);
        return 'skipped';
      }

      const data = this.client.getFileAt ? await this.client.getFileAt(change.path, change.hash) : await this.client.getFile(change.path);

      // Check if file was modified locally while we were fetching from server.
      // If it changed (user typed during the download), treat it as a conflict
      // rather than silently overwriting user's work with server data.
      const currentHash = this.state.files[change.path];
      if (await this.vault.exists(change.path)) {
          const localData = await this.vault.readFile(change.path);
          const localHash = await sha256hex(localData);
          if (localHash !== currentHash && localHash !== change.hash) {
            // Preserve the true base and both versions; automatic uploads are
            // blocked until the user resolves the conflict.
            if (this.state.conflicts[change.path] !== change.hash) {
              await this.vault.writeFile(conflictSiblingPath(change.path), data);
            }
            await this.conflict(change.path, change.hash);
            return 'skipped';
          }
      }

      await this.vault.writeFile(change.path, data);
      await this.state.setFileHash(change.path, change.hash);
      return 'downloaded';
    } catch (e) {
      console.error(`[vault-sync] pull: failed on ${change.action} "${change.path}":`, e);
      this.log?.add('error', `${change.action} "${change.path}": ${errorMessage(e)}`);
      return 'failed';
    }
  }

  push(path: string): Promise<{ conflict: boolean }> { return this.serial(() => this.pushOnce(path)); }

  private async pushOnce(path: string): Promise<{ conflict: boolean }> {
    if (!this.allowed(path)) { await this.state.queue(path, null); return { conflict: false }; }
    if (this.state.conflicts[path]) return { conflict: true };
    if (!await this.vault.exists(path)) {
      await this.state.queue(path, path in this.state.files ? 'delete' : null);
      return { conflict: false };
    }
    const data = await this.vault.readFile(path);
    const hash = await sha256hex(data);

    // Echo guard: if the file already matches what we last synced, this push
    // was triggered by our own pull write (writing a file fires Obsidian's
    // 'modify' event), not a real user edit. Pushing it would create a server
    // changelog entry → SSE → pull → write → 'modify' → push … an endless loop
    // that re-uploads every file on a cycle. Nothing changed; do nothing.
    if (this.state.files[path] === hash) { await this.state.queue(path, null); return { conflict: false }; }

    const baseHash = this.state.files[path] ?? '';
    const result = await this.client.putFile(path, data, baseHash);
    if (result.conflict) {
      await this.conflict(path, result.currentHash ?? 'unknown');
    } else {
      await this.state.setFileHash(path, hash);
      // An edit arriving while the request was in flight remains queued.
      if (await this.vault.exists(path) && await sha256hex(await this.vault.readFile(path)) === hash) await this.state.queue(path, null);
    }
    return { conflict: result.conflict };
  }

  pushDelete(path: string): Promise<void> { return this.serial(() => this.deleteOnce(path)); }

  private async deleteOnce(path: string): Promise<void> {
    if (!this.allowed(path)) { await this.state.queue(path, null); return; }
    if (this.state.conflicts[path]) return;
    // A queued delete can outlive a recreation or a rename back to this path.
    if (await this.vault.exists(path)) {
      await this.state.queue(path, 'upload');
      return;
    }
    // Not tracked = the server was never told about this file, or we just
    // applied its deletion ourselves (see pull). Either way there is nothing
    // to send; sending would only produce a pointless 404/409.
    if (!(path in this.state.files)) { await this.state.queue(path, null); return; }
    const baseHash = this.state.files[path];
    await this.client.deleteFile(path, baseHash);
    await this.state.removeFileHash(path);
    await this.state.queue(path, null);
  }

  // Startup scan discovers changes made while Obsidian was closed. Subsequent
  // polls retry only the persistent queue instead of rehashing the whole vault.
  scanLocalChanges(): Promise<void> { return this.serial(() => this.scanLocalOnce()); }
  private async scanLocalOnce(): Promise<void> {
    this.state.deferSaves = true;
    try {
    const paths = await this.vault.listAll();
    for (const path of paths) {
      if (!this.allowed(path) || this.state.conflicts[path]) continue;
      if (await sha256hex(await this.vault.readFile(path)) !== this.state.files[path]) await this.state.queue(path, 'upload');
    }
    if (paths.length === 0) return;
    const missing: string[] = [];
    for (const path of Object.keys(this.state.files)) {
      if (this.allowed(path) && !await this.vault.exists(path)) missing.push(path);
    }
    const known = Object.keys(this.state.files).length;
    if (missing.length >= 5 && missing.length / known >= 0.5 && !await this.onMassChange(missing.length, known, missing.map(p => `delete from server: ${p}`))) return;
    for (const path of missing) await this.state.queue(path, 'delete');
    } finally { this.state.deferSaves = false; await this.state.flush(); }
  }

  async retryPending(): Promise<number> {
    let failures = 0;
    for (const [path, action] of Object.entries(this.state.pending).sort((a, b) => Number(a[1] === 'delete') - Number(b[1] === 'delete'))) {
      if (action === 'delete' && Object.values(this.state.pending).includes('upload')) continue;
      try { if (action === 'delete') await this.pushDelete(path); else await this.push(path); }
      catch (e) { failures++; this.log?.add('error', `retry "${path}": ${errorMessage(e)}`); }
    }
    return failures;
  }

  // Deletions made while the plugin wasn't listening (Obsidian closed, plugin
  // off) never fire a 'delete' event, so nothing would ever tell the server.
  // Compare what we last synced (state.files) with what is on disk and send the
  // missing ones as deletions. Run once at startup, after the first pull and
  // before the vault listeners are attached.
  async reconcileDeletions(isExcluded: (path: string) => boolean = () => false): Promise<void> {
    const tracked = Object.keys(this.state.files);
    if (tracked.length === 0) return;

    // An empty listing with tracked files means the vault isn't loaded yet,
    // not that the user deleted everything. Don't act on it.
    const local = new Set(await this.vault.listAll());
    if (local.size === 0) return;

    const missing: string[] = [];
    for (const path of tracked) {
      if (local.has(path)) continue;
      if (!this.allowed(path) || isExcluded(path)) continue;
      // The listing can lag or filter; only trust the disk for the final call.
      if (await this.vault.exists(path)) continue;
      missing.push(path);
    }
    if (missing.length === 0) return;

    if (missing.length >= MASS_CHANGE_MIN_AFFECTED && missing.length / tracked.length >= MASS_CHANGE_RATIO) {
      const proceed = await this.onMassChange(missing.length, tracked.length);
      if (!proceed) return;
    }

    let failures = 0;
    for (const path of missing) {
      try {
        await this.pushDelete(path);
      } catch (e) {
        // 409 = another device changed the file since we last saw it: the
        // server keeps it, and so do we (state entry stays).
        failures++;
        console.error(`[vault-sync] reconcile: failed to delete "${path}" on the server:`, e);
        if (failures >= RECONCILE_MAX_FAILURES) {
          console.warn('[vault-sync] reconcile: too many failures, will retry at next start');
          return;
        }
      }
    }
  }

  initialSync(isExcluded: (path: string) => boolean = () => false): Promise<InitialSyncResult> {
    return this.serial(() => this.initialSyncOnce(isExcluded));
  }

  private async initialSyncOnce(isExcluded: (path: string) => boolean): Promise<InitialSyncResult> {
    const snapshot = this.client.getSnapshot ? await this.client.getSnapshot() : null;
    const changes = snapshot ? snapshot.changes : await this.client.getChanges(0);
    let failures = 0;
    this.state.deferSaves = true;
    try {

    // Build server file set, and remember when each currently-deleted path
    // was deleted (seconds, server clock).
    const serverFiles = new Map<string, string>(); // path → hash
    const deletedAt = new Map<string, number>();
    for (const c of changes) {
      if (c.action === 'modified') {
        serverFiles.set(c.path, c.hash);
        deletedAt.delete(c.path);
      } else {
        serverFiles.delete(c.path);
        deletedAt.set(c.path, c.ts);
      }
    }

    // Three-way by content hash. Local bytes are never overwritten by the
    // server copy. A hash mismatch keeps the local file and writes the remote
    // bytes beside it.
    const skippedDeleted: string[] = [];
    const localPaths = await this.vault.listAll();
    const localSet = new Set(localPaths);

    for (const [path, remoteHash] of serverFiles) {
      if (!this.allowed(path) || isExcluded(path)) continue;
      try {
        if (!localSet.has(path)) {
          const data = this.client.getFileAt ? await this.client.getFileAt(path, remoteHash) : await this.client.getFile(path);
          if (await this.vault.exists(path) && await sha256hex(await this.vault.readFile(path)) !== remoteHash) {
            await this.vault.writeFile(conflictSiblingPath(path), data);
            await this.conflict(path, remoteHash);
            continue;
          }
          await this.vault.writeFile(path, data);
          await this.state.setFileHash(path, remoteHash);
          continue;
        }
        const local = await this.vault.readFile(path);
        const localHash = await sha256hex(local);
        if (localHash === remoteHash) {
          await this.state.setFileHash(path, remoteHash);
          continue;
        }
        const data = this.client.getFileAt ? await this.client.getFileAt(path, remoteHash) : await this.client.getFile(path);
        const conflictPath = conflictSiblingPath(path);
        await this.vault.writeFile(conflictPath, data);
        await this.conflict(path, remoteHash);
      } catch (e) {
        failures++;
        console.error(`[vault-sync] initial sync: failed to reconcile ${path}:`, e);
      }
    }

    // Upload local files not on server
    for (const path of localPaths) {
      if (serverFiles.has(path)) continue; // already handled above
      if (!isSafeSyncPath(path, this.configDir) || isExcluded(path)) continue;
      try {
        // "Not on the server" is ambiguous: never uploaded, or deleted there.
        // Device clocks cannot safely decide whether to resurrect a file.
        // Preserve the local copy and require an explicit user choice.
        const deletedTs = deletedAt.get(path);
        if (deletedTs !== undefined) {
          skippedDeleted.push(path);
          await this.conflict(path, 'deleted');
          continue;
        }
        const data = await this.vault.readFile(path);
        const uploaded = await this.client.putFile(path, data, '');
        if (uploaded.conflict) { await this.conflict(path, uploaded.currentHash ?? 'unknown'); continue; }
        const hash = await sha256hex(data);
        await this.state.setFileHash(path, hash);
      } catch (e) {
        failures++;
        await this.state.queue(path, 'upload');
        console.error(`[vault-sync] initial sync: failed to upload ${path}:`, e);
      }
    }

    if (failures > 0) throw new Error(`${failures} file(s) failed initial sync; retry after fixing the connection`);
    await this.state.setLastSyncTimestamp(changes.reduce((max, c) => Math.max(max, c.ts), 0));
    if (snapshot) await this.state.setCursor(snapshot.cursor);
    return { skippedDeleted };
    } finally { this.state.deferSaves = false; await this.state.flush(); }
  }
}

/** Sibling path for a remote copy that must not overwrite the local file. */
export function conflictSiblingPath(path: string, device = 'local', now = new Date()): string {
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  const slash = path.lastIndexOf('/');
  const dir = slash >= 0 ? path.slice(0, slash + 1) : '';
  const base = slash >= 0 ? path.slice(slash + 1) : path;
  const dot = base.lastIndexOf('.');
  const stem = dot > 0 ? base.slice(0, dot) : base;
  const ext = dot > 0 ? base.slice(dot) : '';
  return `${dir}${stem}.conflict.${device}.${stamp}${ext}`;
}
