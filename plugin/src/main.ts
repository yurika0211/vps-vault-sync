import { Notice, ObsidianProtocolData, Platform, Plugin, TFile } from 'obsidian';
import { SyncSettings, SyncSettingTab, DEFAULT_SETTINGS, clampPushDebounceSeconds, pushDebounceDelayMs } from './settings';
import { defaultExcludePatterns, matchGlob } from './util';
import { createState, PersistedSyncState, StateStorage, SyncState } from './state';
import { SyncClient } from './client';
import { SyncEngine, VaultAdapter, isSafeSyncPath, isSafeVaultPath } from './engine';
import { SSEClient } from './sse';
import { writeFileResilient, pruneEmptyParents } from './vaultio';
import { PairingClient, PairResult, PAIRING_PROTOCOL_ACTION, parsePairingParams } from './pairing';
import { errorMessage } from './errors';
import { OnboardingModal } from './onboardingWizard';
import { MassChangeModal } from './massChangeModal';
import { ConflictModal } from './conflictModal';
import type { ConflictVault } from './conflicts';
import { SyncLog, Throttle, LogEntry } from './synclog';
import { ConfirmModal } from './confirmModal';

// The full shape of what this plugin persists via loadData()/saveData() —
// settings fields plus the sync engine's own state, stored together under
// one JSON blob (Obsidian's plugin data.json). Typing this boundary
// explicitly (instead of leaving loadData()'s `any` to propagate) is what
// lets everything downstream — settings fields, syncState — stay fully typed.
interface PluginData {
  serverUrl?: string;
  // Legacy field only. New saves omit it; load migrates any leftover into
  // secretStorage and strips it from data.json.
  authToken?: string;
  syncInterval?: number;
  pushDebounceSeconds?: number;
  exclude?: string[];
  syncState?: PersistedSyncState;
  syncLog?: LogEntry[];
  paused?: boolean;
}

const AUTH_TOKEN_SECRET = 'auth-token';

export default class VaultSyncPlugin extends Plugin {
  settings!: SyncSettings;
  private engine!: SyncEngine;
  private state?: SyncState;
  private sseClient!: SSEClient;
  private statusBarItem!: HTMLElement;
  private pollIntervalId?: number;
  private listenersRegistered = false;
  syncLog = new SyncLog();
  // When the last pull finished without throwing (this session); shown in settings.
  lastPullAt: number | null = null;
  // Mobile has no status bar or console, so failures surface as a Notice —
  // at most one per 10 minutes so a persistent error doesn't spam.
  private errorNotice = new Throttle(10 * 60 * 1000);
  private dataWrites: Promise<void> = Promise.resolve();
  private activeCycle: Promise<void> | null = null;
  private stopping = false;
  private needsInitialSync = false;
  statusText = 'Idle';

  private updateData(update: (current: PluginData) => PluginData): Promise<void> {
    const next = (this.dataWrites ?? Promise.resolve()).catch(() => {}).then(async () => {
      const current = pluginDataWithoutAuthToken((await this.loadData()) as PluginData | undefined);
      await this.saveData(update(current));
    });
    this.dataWrites = next;
    return next;
  }

  confirmAction(message: string, action: string): Promise<boolean> { return new ConfirmModal(this.app, message, action).wait(); }

  async setPaused(paused: boolean): Promise<void> {
    if (!paused && (!this.settings.serverUrl || !this.settings.authToken)) {
      new Notice('Configure a connection first');
      return;
    }
    this.settings.paused = paused;
    await this.saveSettings();
    if (paused) { await this.stopSync(); this.setStatus('paused'); }
    else { await this.initEngine(); await this.startSyncLoop(); }
  }

  async syncNow(): Promise<void> {
    if (this.settings.paused) { new Notice('Resume sync first'); return; }
    if (!this.settings.serverUrl || !this.settings.authToken) { new Notice('Configure a connection first'); return; }
    if (!this.engine) await this.initEngine();
    if (this.needsInitialSync) await this.runInitialSync();
    await this.engine.scanLocalChanges();
    await this.runPull();
  }

  private async stopSync(): Promise<void> {
    this.stopping = true;
    window.clearInterval(this.pollIntervalId);
    for (const timer of this.debounceMap.values()) window.clearTimeout(timer);
    this.debounceMap.clear();
    this.sseClient?.disconnect();
    await this.engine?.stop();
    await this.activeCycle;
    await this.state?.flush();
    await this.dataWrites;
  }

  restartPoll(): void {
    window.clearInterval(this.pollIntervalId);
    if (!this.settings.paused && !this.stopping && this.engine) {
      this.pollIntervalId = window.setInterval(() => { void this.runPull(); }, this.settings.syncInterval * 1000);
    }
  }

  async onload(): Promise<void> {
    await this.loadSettings();
    this.addSettingTab(new SyncSettingTab(this.app, this));

    this.statusBarItem = this.addStatusBarItem();
    this.setStatus('idle');

    this.addCommand({
      id: 'open-conflicts',
      name: 'Open conflict panel',
      callback: () => { void this.openConflictPanel(); },
    });

    this.registerObsidianProtocolHandler(PAIRING_PROTOCOL_ACTION, this.handlePairingUri.bind(this));
    if (this.settings.paused) { this.setStatus('paused'); return; }

    if (!this.settings.serverUrl || !this.settings.authToken) {
      new OnboardingModal(this.app, this).open();
      return;
    }
    await this.initEngine();

    // Defer the first pull until the workspace is ready. Pulling during onload
    // both blocks startup (a full pull can write hundreds of files) and races
    // Obsidian's not-yet-populated file/folder cache. onLayoutReady fires once
    // the vault is indexed, so file writes land cleanly and startup stays fast.
    this.app.workspace.onLayoutReady(() => {
      void this.startSyncLoop().catch(e => { this.setStatus('error'); this.logError('startup', e); });
    });
  }

  onunload(): void {
    void this.stopSync();
  }

  async saveSettings(): Promise<void> {
    this.persistAuthToken(this.settings.authToken);
    const { authToken: _memory, ...persisted } = this.settings;
    await this.updateData(cur => ({ ...cur, ...persisted }));
  }

  private persistAuthToken(token: string): void {
    const secrets = this.app.secretStorage;
    if (!secrets?.setSecret) throw new Error('Obsidian 1.11.4 or newer is required to store credentials');
    secrets.setSecret(AUTH_TOKEN_SECRET, token);
  }

  async openConflictPanel(): Promise<void> {
    if (!this.settings.serverUrl || !this.settings.authToken) {
      new Notice('Set a server URL and auth token first');
      return;
    }
    if (!this.engine) await this.initEngine();
    const client = new SyncClient(this.settings.serverUrl, this.settings.authToken);
    new ConflictModal(this.app, this.makeConflictVault(), client, this.state, action => this.engine.runExclusive(action)).open();
  }

  private makeConflictVault(): ConflictVault {
    const vault = this.app.vault;
    const workspace = this.app.workspace;
    return {
      listAll: async () => vault.getFiles().map((file: TFile) => file.path),
      readFile: (path) => this.makeVaultAdapter().readFile(path),
      writeFile: (path, data) => this.makeVaultAdapter().writeFile(path, data),
      deleteFile: (path) => this.makeVaultAdapter().deleteFile(path),
      openFile: async (path) => {
        const file = vault.getAbstractFileByPath(path);
        if (!(file instanceof TFile)) throw new Error(`File not found: ${path}`);
        await workspace.getLeaf(true).openFile(file);
      },
    };
  }

  async runInitialSync(): Promise<void> {
    if (this.settings.paused) { new Notice('Resume sync first'); return; }
    if (!this.settings.serverUrl || !this.settings.authToken) { new Notice('Configure a connection first'); return; }
    if (!this.engine) await this.initEngine();
    this.setStatus('syncing');
    try {
      const { skippedDeleted } = await this.engine.initialSync((path) => this.isExcluded(path));
      this.needsInitialSync = false;
      this.setSettledStatus();
      new Notice('Initial sync complete');
      if (skippedDeleted.length > 0) {
        // A tombstone always requires an explicit choice to restore a local copy.
        console.warn('[vault-sync] initial sync skipped files deleted on the server:', skippedDeleted);
        new Notice(
          `${skippedDeleted.length} local file(s) were deleted on the server and were not uploaded. ` +
          'Open the conflict panel to choose whether to restore them or keep the deletion.',
          10000,
        );
      }
    } catch (e) {
      this.setStatus('error');
      new Notice(`Initial sync failed: ${errorMessage(e)}`);
      throw e;
    }
  }

  /** Issues a new device token from the currently configured server. Called by the settings tab's "Pair new device" action. */
  async pairNewDevice(label: string): Promise<PairResult> {
    const client = new PairingClient(this.settings.serverUrl, this.settings.authToken);
    return client.pair(label);
  }

  /**
   * Handles an obsidian://vps-vault-sync pairing link. This is how an
   * unconfigured device (no serverUrl/authToken yet) gets set up: scanning the
   * QR from an already-paired device opens Obsidian and lands here with no
   * manual field entry required. The wizard reviews the destination and vault
   * before the user explicitly connects and starts the initial sync.
   */
  private async handlePairingUri(params: ObsidianProtocolData): Promise<void> {
    const parsed = parsePairingParams(params);
    if (!parsed) {
      new Notice('Invalid pairing link');
      return;
    }
    new OnboardingModal(this.app, this, parsed).open();
  }

  /**
   * Applies a server/token pair and brings the sync engine up from a cold
   * start: save settings, (re)build the engine and SSE client against the
   * new server, run a full initial sync, then start the poll/SSE loop.
   * Shared by the obsidian:// protocol handler (handlePairingUri) and the
   * onboarding wizard's manual-entry and paste-link steps, so there's one
   * place that defines what "connected" means.
   */
  async connectToServer(serverUrl: string, authToken: string): Promise<void> {
    await this.stopSync();
    if (this.settings.serverUrl !== serverUrl) {
      await this.updateData(cur => ({ ...cur, syncState: undefined, syncLog: [] }));
    }
    this.settings.serverUrl = serverUrl;
    this.settings.authToken = authToken;
    this.settings.paused = false;
    await this.saveSettings();
    new Notice('Paired — starting sync');
    await this.initEngine();
    await this.runInitialSync();
    await this.startSyncLoop();
  }

  /**
   * Starts pulling, attaches file-change listeners, and starts the poll/SSE loop.
   * Called once the vault is ready to receive writes — either at startup
   * (onLayoutReady) or right after a fresh pairing (handlePairingUri), so this
   * must be safe to call more than once in one session:
   *
   * - File-change listeners and the visibility listener read `this.engine`
   *   fresh on every event (never captured at registration time), so they
   *   stay correct across a re-pair without needing to be re-attached —
   *   `listenersRegistered` guards them so re-pairing doesn't stack a second
   *   set of listeners on top of the first.
   * - The poll timer and SSE connection are NOT guarded: `initEngine` builds
   *   a brand-new `SyncEngine`/`SSEClient` bound to the (possibly new)
   *   server/token, so the timer is unconditionally cleared and restarted and
   *   `connect()` is called on the current `sseClient` every time, ensuring a
   *   re-pair actually starts talking to the new server. `initEngine`
   *   disconnects the previous `sseClient` before replacing it, so no
   *   connection is leaked.
   */
  private async startSyncLoop(): Promise<void> {
    if (this.settings.paused) return;
    // Listen before network work so edits made during startup are queued.
    // The engine serializes uploads and skips echoes of its own writes.
    if (!this.listenersRegistered) {
      this.listenersRegistered = true;
      this.registerEvent(this.app.vault.on('modify', this.onFileModify.bind(this)));
      this.registerEvent(this.app.vault.on('create', this.onFileModify.bind(this)));
      this.registerEvent(this.app.vault.on('delete', this.onFileDelete.bind(this)));
      this.registerEvent(this.app.vault.on('rename', (file, oldPath) => {
        const moved = file instanceof TFile ? [file.path] : this.app.vault.getFiles().map(f => f.path).filter(p => p.startsWith(file.path + '/'));
        for (const path of moved) {
          this.onFileDelete({ path: oldPath + path.slice(file.path.length) });
          this.onFileModify({ path });
        }
      }));

      if (Platform.isMobile) {
        this.registerDomEvent(activeDocument, 'visibilitychange', () => {
          if (activeDocument.visibilityState === 'visible') this.runPull().catch(console.error);
        });
      }
    }

    try {
      if (this.needsInitialSync) await this.runInitialSync();
      await this.engine.scanLocalChanges();
      await this.runPull();
    } finally {
      // A temporary startup failure must still leave a way to retry.
      this.restartPoll();
      if (!Platform.isMobile && !this.stopping) this.sseClient.connect();
    }
  }

  private async initEngine(): Promise<void> {
    this.stopping = false;
    // Tear down any previously-connected SSE client before replacing it —
    // otherwise re-pairing to a different server (see startSyncLoop) leaks a
    // live connection to the old one.
    this.sseClient?.disconnect();

    const persisted = (await this.loadData()) as PluginData | undefined;
    this.needsInitialSync = persisted?.syncState?.cursor === undefined;
    const saved = persisted?.syncLog;
    this.syncLog = new SyncLog(saved, async (entries) => {
      await this.updateData(cur => ({ ...cur, syncLog: entries }));
    });

    const storage: StateStorage = {
      load: async () => {
        const d = (await this.loadData()) as PluginData | undefined;
        return d?.syncState;
      },
      save: async (d: PersistedSyncState) => {
        await this.updateData(cur => ({ ...cur, syncState: d }));
      },
    };
    const state = await createState(storage);
    this.state = state;
    const client = new SyncClient(this.settings.serverUrl, this.settings.authToken);
    const vault = this.makeVaultAdapter();

    this.engine = new SyncEngine(client, vault, state, (path) => {
      new Notice(`Sync conflict: ${path}`);
      this.setStatus('conflict');
    }, this.app.vault.configDir, (affected, known, paths) => {
      return new MassChangeModal(this.app, affected, known, paths).waitForChoice();
    }, this.syncLog, path => this.isExcluded(path));

    this.sseClient = new SSEClient(
      this.settings.serverUrl,
      this.settings.authToken,
      (_path, _action) => { this.runPull().catch(console.error); },
      () => { /* SSE disconnected — fall back to polling */ },
    );
  }

  private makeVaultAdapter(): VaultAdapter {
    const vault = this.app.vault;

    return {
      readFile: async (path) => {
        if (!isSafeVaultPath(path, vault.configDir)) throw new Error('Unsafe vault path');
        // getAbstractFileByPath (not the newer getFileByPath, which needs
        // Obsidian 1.5.7+) for compatibility with older mobile builds that
        // can't be updated past ~1.12.x.
        const file = vault.getAbstractFileByPath(path);
        if (!(file instanceof TFile)) throw new Error(`File not found: ${path}`);
        return vault.readBinary(file);
      },
      writeFile: async (path, data) => {
        if (!isSafeVaultPath(path, vault.configDir)) throw new Error('Unsafe vault path');
        // Write through the adapter to dodge Obsidian's startup cache lag
        // (otherwise sequential writes into one folder throw "already exists").
        // No cast needed: Vault's real `adapter` (DataAdapter) already
        // structurally satisfies MinimalVault's narrower shape.
        await writeFileResilient(vault, path, data);
      },
      deleteFile: async (path) => {
        if (!isSafeVaultPath(path, vault.configDir)) throw new Error('Unsafe vault path');
        const file = vault.getAbstractFileByPath(path);
        // vault.trash (not the newer FileManager.trashFile, which needs
        // Obsidian 1.6.6+) for the same older-mobile-build reason. `false`
        // sends it to Obsidian's own .trash rather than the OS trash — a
        // fixed choice instead of trashFile's "respect the user's system
        // vs. Obsidian trash preference", but still recoverable, not a
        // permanent delete.
        // (see eslint.config.js for the corresponding rule override)
        if (file instanceof TFile) await vault.trash(file, false);
      },
      listAll: async () => {
        return vault.getFiles()
          .map((f: TFile) => f.path)
          .filter((p: string) => !this.isExcluded(p));
      },
      // Straight to disk through the adapter, not the Obsidian file cache.
      exists: (path) => vault.adapter.exists(path),
      mtime: async (path) => (await vault.adapter.stat(path))?.mtime ?? null,
      pruneEmptyParents: (path) => pruneEmptyParents(vault, path, vault.configDir),
    };
  }

  private debounceMap = new Map<string, number>();

  private onFileModify(file: { path: string }): void {
    if (this.stopping || this.settings.paused || this.isExcluded(file.path) || !isSafeSyncPath(file.path, this.app.vault.configDir)) return;
    this.state?.queue(file.path, 'upload').catch(console.error);
    window.clearTimeout(this.debounceMap.get(file.path));
    this.debounceMap.set(file.path, window.setTimeout(() => {
      this.debounceMap.delete(file.path);
      this.runPush(file.path).catch(console.error);
    }, pushDebounceDelayMs(this.settings.pushDebounceSeconds)));
  }

  private onFileDelete(file: { path: string }): void {
    if (this.stopping || this.settings.paused || this.isExcluded(file.path) || !isSafeSyncPath(file.path, this.app.vault.configDir)) return;
    // Cancel pending push debounce for this file
    const pending = this.debounceMap.get(file.path);
    if (pending !== undefined) {
      window.clearTimeout(pending);
      this.debounceMap.delete(file.path);
    }
    this.state?.queue(file.path, 'delete').catch((e) => {
      console.error(e);
      this.logError(`delete "${file.path}"`, e);
    });
  }

  private async runReconcile(): Promise<void> {
    if (!this.engine) return;
    try {
      await this.engine.reconcileDeletions((path) => this.isExcluded(path));
    } catch (e) {
      console.error('Vault sync reconcile error:', e);
    }
  }

  private async runPull(): Promise<void> {
    if (this.activeCycle) return this.activeCycle;
    this.activeCycle = this.runCycle().finally(() => { this.activeCycle = null; });
    return this.activeCycle;
  }

  private async runCycle(): Promise<void> {
    if (!this.engine || this.stopping || this.settings.paused) return;
    this.setStatus('syncing');
    try {
      if (this.needsInitialSync) {
        await this.runInitialSync();
        await this.engine.scanLocalChanges();
      }
      const r = await this.engine.pull();
      const retriesFailed = r.blocked ? 0 : await this.engine.retryPending();
      if (r.failed === 0 && !r.blocked) this.lastPullAt = Date.now();
      if (r.failed > 0 || retriesFailed > 0) {
        this.setStatus('error');
        this.notifyMobileError(`${r.failed} file(s) failed to sync. Details: plugin settings → Sync log.`);
      } else {
        if (r.blocked) this.setStatus('pending'); else this.setSettledStatus();
      }
    } catch (e) {
      this.setStatus('error');
      console.error('Vault sync pull error:', e);
      this.logError('pull', e);
      this.notifyMobileError(`Sync failed: ${errorMessage(e)}`);
    }
  }

  private logError(what: string, e: unknown): void {
    this.syncLog.add('error', `${what}: ${errorMessage(e)}`);
    this.syncLog.save().catch(console.error);
  }

  private notifyMobileError(msg: string): void {
    if (Platform.isMobile && this.errorNotice.allow()) new Notice(msg, 8000);
  }

  private async runPush(path: string): Promise<void> {
    if (!this.engine || this.settings?.paused) return;
    this.setStatus('syncing');
    try {
      const result = await this.engine.push(path);
      if (result?.conflict) this.setStatus('conflict'); else this.setSettledStatus();
    } catch (e) {
      this.setStatus('error');
      console.error(`Sync push error (${path}):`, e);
      this.logError(`push "${path}"`, e);
    }
  }

  private isExcluded(path: string): boolean {
    return this.settings.exclude.some(pat => matchGlob(pat, path));
  }

  private setSettledStatus(): void {
    if (this.settings?.paused) this.setStatus('paused');
    else if (Object.keys(this.state?.conflicts ?? {}).length) this.setStatus('conflict');
    else if (Object.keys(this.state?.pending ?? {}).length) this.setStatus('pending');
    else this.setStatus('synced');
  }

  private setStatus(status: 'idle' | 'syncing' | 'synced' | 'error' | 'conflict' | 'pending' | 'paused'): void {
    const icons: Record<string, string> = {
      idle: '↕ idle',
      syncing: '↕ syncing…',
      synced: '↕ synced',
      error: '✗ sync error',
      conflict: '⚠ conflict',
      pending: '↕ pending changes',
      paused: '⏸ paused',
    };
    this.statusText = icons[status];
    this.statusBarItem?.setText(icons[status]);
  }

  private async loadSettings(): Promise<void> {
    const raw = ((await this.loadData()) as PluginData | undefined) ?? {};
    const data = pluginDataWithoutAuthToken(raw);
    const stored = this.app.secretStorage?.getSecret(AUTH_TOKEN_SECRET) ?? '';
    const legacy = raw.authToken ?? '';
    const authToken = stored || legacy || DEFAULT_SETTINGS.authToken;
    this.settings = {
      serverUrl: data.serverUrl ?? DEFAULT_SETTINGS.serverUrl,
      authToken,
      syncInterval: data.syncInterval ?? DEFAULT_SETTINGS.syncInterval,
      pushDebounceSeconds: clampPushDebounceSeconds(
        data.pushDebounceSeconds ?? DEFAULT_SETTINGS.pushDebounceSeconds,
      ),
      exclude: data.exclude ?? defaultExcludePatterns(this.app.vault.configDir),
      paused: data.paused ?? false,
    };
    // Always rewrite plugin data when a legacy token is present, even if
    // secretStorage cannot store it. The token stays in memory only.
    if (legacy || stored !== authToken) {
      await this.saveSettings();
    }
  }
}

/** Plugin data.json never keeps the auth token. */
export function pluginDataWithoutAuthToken(data: PluginData | undefined): Omit<PluginData, 'authToken'> {
  const cur = data ?? {};
  const { authToken: _dropped, ...rest } = cur;
  return rest;
}
