import { Notice, ObsidianProtocolData, Platform, Plugin, TFile } from 'obsidian';
import { SyncSettings, SyncSettingTab, DEFAULT_SETTINGS, clampPushDebounceSeconds, pushDebounceDelayMs } from './settings';
import { defaultExcludePatterns, matchGlob } from './util';
import { createState, PersistedSyncState, StateStorage, SyncState } from './state';
import { SyncClient } from './client';
import { SyncEngine, VaultAdapter } from './engine';
import { SSEClient } from './sse';
import { writeFileResilient, pruneEmptyParents } from './vaultio';
import { PairingClient, PairResult, PAIRING_PROTOCOL_ACTION, parsePairingParams } from './pairing';
import { errorMessage } from './errors';
import { OnboardingModal } from './onboardingWizard';
import { MassChangeModal } from './massChangeModal';
import { ConflictModal } from './conflictModal';
import type { ConflictVault } from './conflicts';
import { SyncLog, Throttle, LogEntry } from './synclog';

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

    if (!this.settings.serverUrl || !this.settings.authToken) {
      new OnboardingModal(this.app, this).open();
      return;
    }
    await this.initEngine();

    // Defer the first pull until the workspace is ready. Pulling during onload
    // both blocks startup (a full pull can write hundreds of files) and races
    // Obsidian's not-yet-populated file/folder cache. onLayoutReady fires once
    // the vault is indexed, so file writes land cleanly and startup stays fast.
    this.app.workspace.onLayoutReady(() => this.startSyncLoop());
  }

  onunload(): void {
    window.clearInterval(this.pollIntervalId);
    this.sseClient?.disconnect();
  }

  async saveSettings(): Promise<void> {
    this.persistAuthToken(this.settings.authToken);
    const cur = pluginDataWithoutAuthToken((await this.loadData()) as PluginData | undefined);
    const { authToken: _memory, ...persisted } = this.settings;
    await this.saveData({ ...cur, ...persisted });
  }

  private persistAuthToken(token: string): void {
    const secrets = this.app.secretStorage;
    if (!secrets?.setSecret || !token) return;
    secrets.setSecret(AUTH_TOKEN_SECRET, token);
  }

  async openConflictPanel(): Promise<void> {
    if (!this.settings.serverUrl || !this.settings.authToken) {
      new Notice('Set a server URL and auth token first');
      return;
    }
    if (!this.engine) await this.initEngine();
    const client = new SyncClient(this.settings.serverUrl, this.settings.authToken);
    new ConflictModal(this.app, this.makeConflictVault(), client, this.state).open();
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
    if (!this.engine) await this.initEngine();
    this.setStatus('syncing');
    try {
      const { skippedDeleted } = await this.engine.initialSync((path) => this.isExcluded(path));
      this.setStatus('synced');
      new Notice('Initial sync complete');
      if (skippedDeleted.length > 0) {
        // Not uploaded: the server had these deleted and the local copies are
        // not newer. Say so, so nothing silently differs between devices.
        console.warn('[vault-sync] initial sync skipped files deleted on the server:', skippedDeleted);
        new Notice(
          `${skippedDeleted.length} local file(s) were deleted on the server and were not uploaded. ` +
          'Delete them here too, or edit them to keep them.',
          10000,
        );
      }
    } catch (e) {
      this.setStatus('error');
      new Notice(`Initial sync failed: ${errorMessage(e)}`);
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
   * manual field entry required. Runs a full initialSync (not just a pull) so
   * that a device which already has local-only notes — e.g. created before
   * pairing — gets them uploaded, not just server files downloaded.
   */
  private async handlePairingUri(params: ObsidianProtocolData): Promise<void> {
    const parsed = parsePairingParams(params);
    if (!parsed) {
      new Notice('Invalid pairing link');
      return;
    }
    await this.connectToServer(parsed.server, parsed.token);
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
    this.settings.serverUrl = serverUrl;
    this.settings.authToken = authToken;
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
    // Run the first pull to completion BEFORE attaching file listeners.
    // Pull writes via the adapter, which fires Obsidian 'create'/'modify'
    // events; if listeners were already live they'd push every pulled file
    // straight back. The per-file echo guard in push() also covers this, but
    // ordering avoids a pointless burst of no-op pushes at startup.
    await this.runPull();

    // Then send deletions made while the plugin wasn't listening (see
    // SyncEngine.reconcileDeletions). Still before the listeners, so a file
    // removed here can't also be reported by a 'delete' event.
    await this.runReconcile();

    if (!this.listenersRegistered) {
      this.listenersRegistered = true;
      this.registerEvent(this.app.vault.on('modify', this.onFileModify.bind(this)));
      this.registerEvent(this.app.vault.on('create', this.onFileModify.bind(this)));
      this.registerEvent(this.app.vault.on('delete', this.onFileDelete.bind(this)));

      if (Platform.isMobile) {
        this.registerDomEvent(activeDocument, 'visibilitychange', () => {
          if (activeDocument.visibilityState === 'visible') this.runPull().catch(console.error);
        });
      }
    }

    window.clearInterval(this.pollIntervalId);
    this.pollIntervalId = window.setInterval(
      () => { this.runPull().catch(console.error); },
      this.settings.syncInterval * 1000,
    );

    if (!Platform.isMobile) {
      this.sseClient.connect();
    }
  }

  private async initEngine(): Promise<void> {
    // Tear down any previously-connected SSE client before replacing it —
    // otherwise re-pairing to a different server (see startSyncLoop) leaks a
    // live connection to the old one.
    this.sseClient?.disconnect();

    const saved = ((await this.loadData()) as PluginData | undefined)?.syncLog;
    this.syncLog = new SyncLog(saved, async (entries) => {
      const cur = pluginDataWithoutAuthToken((await this.loadData()) as PluginData | undefined);
      await this.saveData({ ...cur, syncLog: entries });
    });

    const storage: StateStorage = {
      load: async () => {
        const d = (await this.loadData()) as PluginData | undefined;
        return d?.syncState;
      },
      save: async (d: PersistedSyncState) => {
        const cur = pluginDataWithoutAuthToken((await this.loadData()) as PluginData | undefined);
        await this.saveData({ ...cur, syncState: d });
      },
    };
    const state = await createState(storage);
    this.state = state;
    const client = new SyncClient(this.settings.serverUrl, this.settings.authToken);
    const vault = this.makeVaultAdapter();

    this.engine = new SyncEngine(client, vault, state, (path) => {
      new Notice(`Sync conflict: ${path}`);
      this.setStatus('conflict');
    }, this.app.vault.configDir, (affected, known) => {
      return new MassChangeModal(this.app, affected, known).waitForChoice();
    }, this.syncLog);

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
        // getAbstractFileByPath (not the newer getFileByPath, which needs
        // Obsidian 1.5.7+) for compatibility with older mobile builds that
        // can't be updated past ~1.12.x.
        const file = vault.getAbstractFileByPath(path);
        if (!(file instanceof TFile)) throw new Error(`File not found: ${path}`);
        return vault.readBinary(file);
      },
      writeFile: async (path, data) => {
        // Write through the adapter to dodge Obsidian's startup cache lag
        // (otherwise sequential writes into one folder throw "already exists").
        // No cast needed: Vault's real `adapter` (DataAdapter) already
        // structurally satisfies MinimalVault's narrower shape.
        await writeFileResilient(vault, path, data);
      },
      deleteFile: async (path) => {
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
    if (this.isExcluded(file.path)) return;
    window.clearTimeout(this.debounceMap.get(file.path));
    this.debounceMap.set(file.path, window.setTimeout(() => {
      this.runPush(file.path).catch(console.error);
    }, pushDebounceDelayMs(this.settings.pushDebounceSeconds)));
  }

  private onFileDelete(file: { path: string }): void {
    if (this.isExcluded(file.path)) return;
    // Cancel pending push debounce for this file
    const pending = this.debounceMap.get(file.path);
    if (pending !== undefined) {
      window.clearTimeout(pending);
      this.debounceMap.delete(file.path);
    }
    this.engine?.pushDelete(file.path).catch((e) => {
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
    if (!this.engine) return;
    this.setStatus('syncing');
    try {
      const r = await this.engine.pull();
      this.lastPullAt = Date.now();
      if (r.failed > 0) {
        this.setStatus('error');
        this.notifyMobileError(`${r.failed} file(s) failed to sync. Details: plugin settings → Sync log.`);
      } else {
        this.setStatus('synced');
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
    if (!this.engine) return;
    this.setStatus('syncing');
    try {
      await this.engine.push(path);
      this.setStatus('synced');
    } catch (e) {
      this.setStatus('error');
      console.error(`Sync push error (${path}):`, e);
      this.logError(`push "${path}"`, e);
    }
  }

  private isExcluded(path: string): boolean {
    return this.settings.exclude.some(pat => matchGlob(pat, path));
  }

  private setStatus(status: 'idle' | 'syncing' | 'synced' | 'error' | 'conflict'): void {
    const icons: Record<string, string> = {
      idle: '↕ idle',
      syncing: '↕ syncing…',
      synced: '↕ synced',
      error: '✗ sync error',
      conflict: '⚠ conflict',
    };
    this.statusBarItem.setText(icons[status]);
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
