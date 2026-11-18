export interface SyncState {
  lastSyncTimestamp: number;
  files: Record<string, string>;
  cursor: number;
  pending: Record<string, 'upload' | 'delete'>;
  conflicts: Record<string, string>;
  resolvedCopies: Record<string, boolean>;
  resolveCopy(path: string): Promise<void>;
  setCursor(cursor: number): Promise<void>;
  queue(path: string, action: 'upload' | 'delete' | null): Promise<void>;
  setConflict(path: string, hash: string | null): Promise<void>;
  // While true, the mutators below only change memory and mark the state
  // dirty; flush() writes it out. pull() applies hundreds of files in one go,
  // and persisting the whole hash map after every single one is what made it
  // slow on mobile. Everything else leaves this false and saves immediately.
  deferSaves: boolean;
  setFileHash(path: string, hash: string): Promise<void>;
  removeFileHash(path: string): Promise<void>;
  setLastSyncTimestamp(ts: number): Promise<void>;
  // Persists pending changes (no-op if nothing changed since the last save).
  flush(): Promise<void>;
}

// The on-disk shape of what StateStorage persists — separate from SyncState
// itself, which also carries the mutator methods below.
export interface PersistedSyncState {
  lastSyncTimestamp?: number;
  files?: Record<string, string>;
  cursor?: number;
  pending?: Record<string, 'upload' | 'delete'>;
  conflicts?: Record<string, string>;
  resolvedCopies?: Record<string, boolean>;
}

export interface StateStorage {
  load(): Promise<PersistedSyncState | undefined>;
  save(data: PersistedSyncState): Promise<void>;
}

export async function createState(storage: StateStorage): Promise<SyncState> {
  const raw = await storage.load();
  let dirty = false;
  let saves = Promise.resolve();
  const save = (): Promise<void> => {
    const data = { lastSyncTimestamp: state.lastSyncTimestamp, files: { ...state.files }, cursor: state.cursor,
      pending: { ...state.pending }, conflicts: { ...state.conflicts }, resolvedCopies: { ...state.resolvedCopies } };
    const next = saves.catch(() => {}).then(() => storage.save(data));
    saves = next;
    return next;
  };

  const persist = async (): Promise<void> => {
    if (state.deferSaves) {
      dirty = true;
      return;
    }
    dirty = false;
    try { await save(); } catch (e) { dirty = true; throw e; }
  };

  const state: SyncState = {
    lastSyncTimestamp: raw?.lastSyncTimestamp ?? 0,
    files: Object.assign(Object.create(null) as Record<string, string>, raw?.files),
    cursor: raw?.cursor ?? 0,
    pending: Object.assign(Object.create(null) as Record<string, 'upload' | 'delete'>, raw?.pending),
    conflicts: Object.assign(Object.create(null) as Record<string, string>, raw?.conflicts),
    resolvedCopies: Object.assign(Object.create(null) as Record<string, boolean>, raw?.resolvedCopies),
    async resolveCopy(path) { state.resolvedCopies[path] = true; await persist(); },
    async setCursor(cursor) { state.cursor = cursor; await persist(); },
    async queue(path, action) { if ((state.pending[path] ?? null) === action) return; if (action) state.pending[path] = action; else delete state.pending[path]; await persist(); },
    async setConflict(path, hash) {
      const previous = state.conflicts[path];
      if (hash !== null) state.conflicts[path] = hash;
      else delete state.conflicts[path];
      try { await persist(); }
      catch (error) {
        if (hash === null && previous) state.conflicts[path] = previous;
        throw error;
      }
    },
    deferSaves: false,
    async setFileHash(path, hash) {
      state.files[path] = hash;
      await persist();
    },
    async removeFileHash(path) {
      delete state.files[path];
      await persist();
    },
    async setLastSyncTimestamp(ts) {
      state.lastSyncTimestamp = ts;
      await persist();
    },
    async flush() {
      if (!dirty) return;
      dirty = false;
      try { await save(); } catch (e) { dirty = true; throw e; }
    },
  };
  return state;
}
