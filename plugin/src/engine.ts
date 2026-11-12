import type { SyncClient, Change } from './client';
import type { SyncState } from './state';
import { sha256hex, runPool } from './util';
import { errorMessage } from './errors';
import type { SyncLog } from './synclog';

function isSafeSyncPath(path: string, configDir: string): boolean {
  if (!path || path.length === 0) return false;
  if (path.startsWith('/')) return false;
  if (path.includes('..')) return false;
  if (path.startsWith(`${configDir}/`)) return false;
  // Conflict copies (.conflict.<timestamp>.md) are server-side artefacts for
  // conflict resolution. They must not be synced back to the client vault:
  // they would appear as real notes, trigger modify events, and in edge cases
  // create secondary push cycles. The server stores them; the client ignores them.
  if (/\.conflict\.\d{4}-\d{2}-\d{2}T[\d.-]+\.md$/.test(path)) return false;
  // eslint-disable-next-line no-control-regex -- deliberately matches control chars/null bytes to reject unsafe sync paths, not a mistake
  if (/[\x00-\x1f]/.test(path)) return false;
  return true;
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
  // Local files NOT uploaded because the server had deleted them and the local
  // copy is not newer than that deletion (a stale copy, not a new file).
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
    private onMassChange: (affected: number, known: number) => Promise<boolean> = async () => true,
    private log?: SyncLog,
  ) {}

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
    this.pulling = (async () => {
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
          };
        } while (this.pullAgain);
        return total;
      } finally {
        this.pulling = null;
      }
    })();
    return this.pulling;
  }

  private async pullOnce(): Promise<PullResult> {
    const result: PullResult = { changes: 0, downloaded: 0, skipped: 0, failed: 0 };
    const raw = await this.client.getChanges(this.state.lastSyncTimestamp);
    if (raw.length === 0) return result;

    // Only the last entry per path matters: replaying a file's whole edit
    // history would download it once per edit. The server already sends it
    // this way; doing it here too keeps an older server from being slow.
    const changes = latestPerPath(raw);
    result.changes = changes.length;

    const known = Object.keys(this.state.files).length;
    const affected = new Set(
      changes
        .filter(c => c.action === 'deleted' || c.action === 'modified')
        .map(c => c.path)
        .filter(path => path in this.state.files),
    ).size;

    if (affected >= MASS_CHANGE_MIN_AFFECTED && affected / known >= MASS_CHANGE_RATIO) {
      const proceed = await this.onMassChange(affected, known);
      if (!proceed) return result;
    }

    // Track the high-water mark from the server's `ts` field. We advance it even
    // past entries that fail below, so a single permanently-missing blob can't
    // wedge sync into re-pulling the whole changelog on every poll forever.
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
      await this.state.setLastSyncTimestamp(maxTs);
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
    if (!isSafeSyncPath(change.path, this.configDir)) {
      console.warn(`[vault-sync] pull: skipping unsafe path from server: ${change.path}`);
      return 'skipped';
    }

    try {
      if (change.action === 'deleted') {
        // Forget the hash BEFORE touching the disk: deleting the file makes
        // Obsidian fire a 'delete' event, whose handler calls pushDelete.
        // With the path already untracked that is a no-op instead of an echo
        // DELETE sent back to the server we just heard the deletion from.
        await this.state.removeFileHash(change.path);
        await this.vault.deleteFile(change.path).catch(() => {});
        await this.vault.pruneEmptyParents(change.path).catch(() => {});
        return 'downloaded';
      }

      // Already have exactly this version (e.g. the entry is our own push
      // coming back): nothing to download.
      if (this.state.files[change.path] === change.hash) return 'skipped';

      const data = await this.client.getFile(change.path);

      // Check if file was modified locally while we were fetching from server.
      // If it changed (user typed during the download), treat it as a conflict
      // rather than silently overwriting user's work with server data.
      const currentHash = this.state.files[change.path];
      if (currentHash) {
        try {
          const localData = await this.vault.readFile(change.path);
          const localHash = await sha256hex(localData);
          if (localHash !== currentHash) {
            // File changed locally while the server version was downloading.
            // Don't overwrite user's work, but DO advance our stored base hash to
            // the server's version. Without this, every future push sends the old
            // X-Base-Hash; the server conflicts every time and spawns a new
            // .conflict.* copy on each debounce cycle — an infinite storm.
            await this.state.setFileHash(change.path, change.hash);
            return 'skipped';
          }
        } catch {
          // File doesn't exist locally or read failed — safe to write
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

  async push(path: string): Promise<void> {
    const data = await this.vault.readFile(path);
    const hash = await sha256hex(data);

    // Echo guard: if the file already matches what we last synced, this push
    // was triggered by our own pull write (writing a file fires Obsidian's
    // 'modify' event), not a real user edit. Pushing it would create a server
    // changelog entry → SSE → pull → write → 'modify' → push … an endless loop
    // that re-uploads every file on a cycle. Nothing changed; do nothing.
    if (this.state.files[path] === hash) return;

    const baseHash = this.state.files[path] ?? '';
    const result = await this.client.putFile(path, data, baseHash);
    if (result.conflict) {
      this.onConflict(path);
    } else {
      await this.state.setFileHash(path, hash);
    }
  }

  async pushDelete(path: string): Promise<void> {
    // Not tracked = the server was never told about this file, or we just
    // applied its deletion ourselves (see pull). Either way there is nothing
    // to send; sending would only produce a pointless 404/409.
    if (!(path in this.state.files)) return;
    const baseHash = this.state.files[path];
    await this.client.deleteFile(path, baseHash);
    await this.state.removeFileHash(path);
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
      if (!isSafeSyncPath(path, this.configDir) || isExcluded(path)) continue;
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

  async initialSync(): Promise<InitialSyncResult> {
    const changes = await this.client.getChanges(0);

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

    // Download server files (server wins on conflict)
    for (const [path, hash] of serverFiles) {
      try {
        const data = await this.client.getFile(path);
        await this.vault.writeFile(path, data);
        await this.state.setFileHash(path, hash);
      } catch (e) {
        console.error(`[vault-sync] initial sync: failed to download ${path}:`, e);
      }
    }

    // Upload local files not on server
    const skippedDeleted: string[] = [];
    const localPaths = await this.vault.listAll();
    for (const path of localPaths) {
      if (serverFiles.has(path)) continue; // already handled above
      try {
        // "Not on the server" is ambiguous: never uploaded, or deleted there.
        // A local copy that isn't newer than the deletion is a stale leftover
        // (e.g. a device that was offline) — uploading it would resurrect the
        // file everywhere. Leave it alone and tell the user instead.
        const deletedTs = deletedAt.get(path);
        if (deletedTs !== undefined) {
          const mtime = await this.vault.mtime(path);
          if (mtime !== null && Math.floor(mtime / 1000) <= deletedTs) {
            skippedDeleted.push(path);
            continue;
          }
        }
        const data = await this.vault.readFile(path);
        await this.client.putFile(path, data, '');
        const hash = await sha256hex(data);
        await this.state.setFileHash(path, hash);
      } catch (e) {
        console.error(`[vault-sync] initial sync: failed to upload ${path}:`, e);
      }
    }

    await this.state.setLastSyncTimestamp(Math.floor(Date.now() / 1000));
    return { skippedDeleted };
  }
}
