import { App, Notice, PluginSettingTab, Setting } from 'obsidian';
import type VaultSyncPlugin from './main';
import { PairingClient, PairedDevice } from './pairing';
import { PairingModal } from './pairingModal';
import { OnboardingModal } from './onboardingWizard';
import { errorMessage } from './errors';
import { defaultExcludePatterns } from './util';

export { defaultExcludePatterns };

export interface SyncSettings {
  serverUrl: string;
  authToken: string;
  syncInterval: number;
  pushDebounceSeconds: number;
  exclude: string[];
}

export const DEFAULT_SETTINGS: SyncSettings = {
  serverUrl: '',
  authToken: '',
  syncInterval: 30,
  pushDebounceSeconds: 2,
  exclude: [],
};

export const PUSH_DEBOUNCE_MIN_SECONDS = 0;
export const PUSH_DEBOUNCE_MAX_SECONDS = 30;

/** Clamp to an integer in [0, 30]. Invalid values become the 2 second default. */
export function clampPushDebounceSeconds(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return DEFAULT_SETTINGS.pushDebounceSeconds;
  const rounded = Math.min(
    PUSH_DEBOUNCE_MAX_SECONDS,
    Math.max(PUSH_DEBOUNCE_MIN_SECONDS, Math.round(n)),
  );
  return rounded;
}

export function pushDebounceDelayMs(seconds: unknown): number {
  return clampPushDebounceSeconds(seconds) * 1000;
}

export class SyncSettingTab extends PluginSettingTab {
  private newDeviceLabel = '';

  constructor(app: App, private plugin: VaultSyncPlugin) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName('Run setup wizard')
      .setDesc('Re-open the guided setup — e.g. to connect this device to a different vault.')
      .addButton(b => b
        .setButtonText('Run wizard')
        .onClick(() => new OnboardingModal(this.app, this.plugin).open()));

    new Setting(containerEl)
      .setName('Server URL')
      .setDesc('e.g. https://obsidian-sync.example.com')
      .addText(t => t
        .setPlaceholder('https://')
        .setValue(this.plugin.settings.serverUrl)
        .onChange(async v => {
          this.plugin.settings.serverUrl = v.trim();
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('Auth token')
      .setDesc('Only needed for the first device — pair every device after that from the "devices" section below.')
      .addText(t => t
        .setValue(this.plugin.settings.authToken)
        .onChange(async v => {
          this.plugin.settings.authToken = v.trim();
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('Sync interval (seconds)')
      .setDesc('How often to poll the server. Changing this applies the next time the sync loop starts.')
      .addSlider(s => s
        .setLimits(10, 300, 10)
        .setValue(this.plugin.settings.syncInterval)
        .onChange(async v => {
          this.plugin.settings.syncInterval = v;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('Push debounce (seconds)')
      .setDesc('Wait after a local edit before uploading that file. 0 pushes immediately. The next edit uses the saved value.')
      .addSlider(s => s
        .setLimits(PUSH_DEBOUNCE_MIN_SECONDS, PUSH_DEBOUNCE_MAX_SECONDS, 1)
        .setValue(this.plugin.settings.pushDebounceSeconds)
        .setDynamicTooltip()
        .onChange(async v => {
          this.plugin.settings.pushDebounceSeconds = clampPushDebounceSeconds(v);
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('Exclude patterns')
      .setDesc('One glob per line. These files will not be synced.')
      .addText(t => t
        .setValue(this.plugin.settings.exclude.join('\n'))
        .onChange(async v => {
          this.plugin.settings.exclude = v.split('\n').map(s => s.trim()).filter(Boolean);
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('Initial sync')
      .setDesc('Compare by content hash. Missing files are copied. If both copies differ, the local file stays and the server copy is written beside it as a conflict file.')
      .addButton(b => b
        .setButtonText('Start initial sync')
        .onClick(() => this.plugin.runInitialSync()));

    new Setting(containerEl).setName('Devices').setHeading();

    const devicesListEl = containerEl.createDiv();

    new Setting(containerEl)
      .setName('Pair new device')
      .setDesc('Generates a QR code — scan it with the new device\'s camera to connect it, no typing required.')
      .addText(t => t
        .setPlaceholder('Label, e.g. "phone"')
        .onChange(v => { this.newDeviceLabel = v.trim(); }))
      .addButton(b => b
        .setButtonText('Generate')
        .onClick(async () => {
          if (!this.plugin.settings.serverUrl || !this.plugin.settings.authToken) {
            new Notice('Set a server URL and auth token above first');
            return;
          }
          const label = this.newDeviceLabel || 'unnamed device';
          try {
            const { token } = await this.plugin.pairNewDevice(label);
            new PairingModal(this.app, this.plugin.settings.serverUrl, token, label).open();
            await this.renderDevices(devicesListEl);
          } catch (e) {
            new Notice(`Failed to pair device: ${errorMessage(e)}`);
          }
        }));

    this.renderDevices(devicesListEl).catch(console.error);

    new Setting(containerEl).setName('Sync log').setHeading();
    const logEl = containerEl.createDiv();
    this.renderLog(logEl);
  }

  // Mobile Obsidian has no console, so this is where a failing sync becomes
  // visible: recent events plus a one-tap copy to paste into a bug report.
  private renderLog(container: HTMLElement): void {
    container.empty();
    const last = this.plugin.lastPullAt;
    new Setting(container)
      .setName(`Version ${this.plugin.manifest.version}`)
      .setDesc(`Last successful pull: ${last ? new Date(last).toLocaleString() : 'not yet this session'}`)
      .addButton(b => b
        .setButtonText('Refresh')
        .onClick(() => this.renderLog(container)))
      .addButton(b => b
        .setButtonText('Copy log')
        .onClick(async () => {
          try {
            await navigator.clipboard.writeText(this.plugin.syncLog.toText() || '(log is empty)');
            new Notice('Sync log copied');
          } catch (e) {
            new Notice(`Could not copy: ${errorMessage(e)}`);
          }
        }));

    const entries = this.plugin.syncLog.entries();
    if (entries.length === 0) {
      container.createEl('p', { text: 'No events yet.' });
      return;
    }
    const lines = entries.slice(-30).reverse()
      .map(e => `${new Date(e.ts).toLocaleTimeString()} ${e.kind} ${e.msg}`);
    container.createEl('pre', { text: lines.join('\n') });
  }

  private async renderDevices(container: HTMLElement): Promise<void> {
    container.empty();
    if (!this.plugin.settings.serverUrl || !this.plugin.settings.authToken) {
      container.createEl('p', { text: 'Set a server URL and auth token above first.' });
      return;
    }

    const client = new PairingClient(this.plugin.settings.serverUrl, this.plugin.settings.authToken);
    let devices: PairedDevice[];
    try {
      devices = await client.listDevices();
    } catch (e) {
      container.createEl('p', { text: `Failed to load devices: ${errorMessage(e)}` });
      return;
    }

    for (const device of devices) {
      new Setting(container)
        .setName(device.label)
        .setDesc(`Last seen: ${device.lastSeenAt}`)
        .addButton(b => b
          .setButtonText('Revoke')
          // setWarning (not the newer setDestructive, which needs Obsidian
          // 1.13.0+) is a deliberate choice for compatibility with older
          // mobile builds — see eslint.config.js for the corresponding
          // rule override.
          .setWarning()
          .onClick(async () => {
            try {
              await client.revokeDevice(device.id);
              await this.renderDevices(container);
            } catch (e) {
              new Notice(`Failed to revoke device: ${errorMessage(e)}`);
            }
          }));
    }
  }
}
