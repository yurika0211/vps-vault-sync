import { Modal, Notice } from 'obsidian';
import type { App } from 'obsidian';
import {
  ConflictItem,
  ConflictVault,
  dismissConflict,
  keepLocal,
  keepServer,
  listConflicts,
} from './conflicts';
import type { SyncState } from './state';
import type { SyncClient } from './client';
import { errorMessage } from './errors';

/**
 * Lists conflict siblings and server conflict copies. Resolution calls the
 * existing client; it does not run a second sync loop.
 */
export class ConflictModal extends Modal {
  constructor(
    app: App,
    private vault: ConflictVault,
    private client: SyncClient,
    private state?: SyncState,
  ) {
    super(app);
  }

  onOpen(): void {
    void this.render();
  }

  onClose(): void {
    this.contentEl.empty();
  }

  private async render(): Promise<void> {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl('h2', { text: 'Sync conflicts' });
    contentEl.createEl('p', {
      text: 'Pick a side. The canonical file changes only when the upload base hash still matches. Nothing is merged automatically.',
    });

    let items: ConflictItem[];
    try {
      const listed = await listConflicts(this.vault, this.client);
      items = listed.items;
      if (listed.remoteError) {
        contentEl.createEl('p', { text: `Server conflict copies could not be listed: ${listed.remoteError}` });
      }
    } catch (e) {
      contentEl.createEl('p', { text: `Could not list conflicts: ${errorMessage(e)}` });
      return;
    }

    if (items.length === 0) {
      contentEl.createEl('p', { text: 'No conflict copies.' });
      return;
    }

    for (const item of items) {
      this.renderRow(contentEl, item);
    }
  }

  private renderRow(container: HTMLElement, item: ConflictItem): void {
    const row = container.createDiv();
    row.createDiv({ text: `Original: ${item.originalPath}` });
    row.createDiv({ text: `Conflict copy: ${item.conflictPath}` });
    row.createDiv({
      text: item.canonical === 'server'
        ? 'Canonical: server'
        : 'Canonical: local file',
    });

    const actions = row.createDiv();
    actions.setCssStyles({ display: 'flex', gap: '8px', flexWrap: 'wrap', margin: '8px 0 16px' });

    const openBoth = actions.createEl('button', { text: 'Open both' });
    openBoth.onclick = () => {
      void this.openBoth(item);
    };

    const keepLocalButton = actions.createEl('button', { text: 'Keep local' });
    keepLocalButton.onclick = () => {
      void this.runKeepLocal(item);
    };

    const keepServerButton = actions.createEl('button', { text: 'Keep server' });
    keepServerButton.onclick = () => {
      void this.runKeepServer(item);
    };

    const dismiss = actions.createEl('button', { text: 'Dismiss', cls: 'mod-warning' });
    dismiss.onclick = () => {
      this.renderDismissConfirm(item, actions);
    };
  }

  private renderDismissConfirm(item: ConflictItem, actions: HTMLElement): void {
    actions.empty();
    actions.createSpan({ text: `Delete ${item.conflictPath}? The original file stays.` });
    const cancel = actions.createEl('button', { text: 'Cancel' });
    cancel.onclick = () => {
      void this.render();
    };
    const confirm = actions.createEl('button', { text: 'Delete conflict copy', cls: 'mod-warning' });
    confirm.onclick = () => {
      void this.runDismiss(item);
    };
  }

  private async openBoth(item: ConflictItem): Promise<void> {
    try {
      await this.vault.openFile(item.originalPath);
      if (item.copyLocation === 'vault') await this.vault.openFile(item.conflictPath);
      else new Notice(`Server copy is ${item.conflictPath}. It is not in the vault.`);
    } catch (e) {
      new Notice(`Could not open: ${errorMessage(e)}`);
    }
  }

  private async runKeepLocal(item: ConflictItem): Promise<void> {
    const result = await keepLocal(item, this.vault, this.client);
    if (!result.ok) {
      new Notice(result.message);
      return;
    }
    if (result.hash) await this.state?.setFileHash(item.originalPath, result.hash);
    new Notice(`Kept local bytes for ${item.originalPath}`);
    await this.render();
  }

  private async runKeepServer(item: ConflictItem): Promise<void> {
    const result = await keepServer(item, this.vault, this.client);
    if (!result.ok) {
      new Notice(result.message);
      return;
    }
    if (result.hash) await this.state?.setFileHash(item.originalPath, result.hash);
    new Notice(`Kept server bytes for ${item.originalPath}`);
    await this.render();
  }

  private async runDismiss(item: ConflictItem): Promise<void> {
    const result = await dismissConflict(item, this.vault, this.client);
    if (!result.ok) {
      new Notice(result.message);
      return;
    }
    new Notice(`Deleted ${item.conflictPath}`);
    await this.render();
  }
}
