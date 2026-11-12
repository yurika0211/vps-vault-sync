export interface SyncState {
  lastSyncTimestamp: number;
  files: Record<string, string>;
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
}

export interface StateStorage {
  load(): Promise<PersistedSyncState | undefined>;
  save(data: PersistedSyncState): Promise<void>;
}

export async function createState(storage: StateStorage): Promise<SyncState> {
  const raw = await storage.load();
  let dirty = false;

  const persist = async (): Promise<void> => {
    if (state.deferSaves) {
      dirty = true;
      return;
    }
    dirty = false;
    await storage.save({ lastSyncTimestamp: state.lastSyncTimestamp, files: state.files });
  };

  const state: SyncState = {
    lastSyncTimestamp: raw?.lastSyncTimestamp ?? 0,
    files: raw?.files ?? {},
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
      await storage.save({ lastSyncTimestamp: state.lastSyncTimestamp, files: state.files });
    },
  };
  return state;
}
