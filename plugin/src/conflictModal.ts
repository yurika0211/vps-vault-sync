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
    private exclusive: (action: () => Promise<void>) => Promise<void> = action => action(),
  ) {
    super(app);
  }
  private busy = false;
  private resolved = new Set<string>();

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
      text: 'Compare the current local and server versions, then choose which to keep. Nothing is merged automatically.',
    });

    let items: ConflictItem[];
    try {
      const listed = await listConflicts(this.vault, this.client);
      items = listed.items;
      for (const [path, hash] of Object.entries(this.state?.conflicts ?? {})) {
        const matching = items.filter(item => item.originalPath === path);
        if (!matching.length) {
          const item: ConflictItem = { originalPath: path, conflictPath: path, copyLocation: 'server', canonical: 'server' };
          items.push(item);
          matching.push(item);
        }
        for (const item of matching) {
          item.remoteDeleted = hash === 'deleted';
          item.localDeleted = this.state?.pending[path] === 'delete';
        }
      }
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
    const resolved = !this.state?.conflicts[item.originalPath] && (this.resolved.has(item.originalPath) || this.state?.resolvedCopies[item.conflictPath]);
    if (resolved) row.createDiv({ text: 'Resolved. The copy is kept for recovery; delete it when no longer needed.' });
    row.createDiv({
      text: item.canonical === 'server'
        ? 'Canonical: server'
        : 'Canonical: local file',
    });

    const actions = row.createDiv();
    actions.setCssStyles({ display: 'flex', gap: '8px', flexWrap: 'wrap', margin: '8px 0 16px' });

    const openBoth = actions.createEl('button', { text: 'Compare local and server' });
    openBoth.onclick = () => {
      void this.openBoth(item);
    };

    const keepLocalButton = actions.createEl('button', { text: 'Keep local' });
    keepLocalButton.disabled = !!resolved;
    keepLocalButton.onclick = () => {
      void this.runAction(() => this.runKeepLocal(item));
    };

    const keepServerButton = actions.createEl('button', { text: 'Keep server' });
    keepServerButton.disabled = !!resolved;
    keepServerButton.onclick = () => {
      void this.runAction(() => this.runKeepServer(item));
    };

    const dismiss = actions.createEl('button', { text: 'Dismiss', cls: 'mod-warning' });
    dismiss.disabled = item.conflictPath === item.originalPath;
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
      void this.runAction(() => this.runDismiss(item));
    };
  }

  private async openBoth(item: ConflictItem): Promise<void> {
    try {
      const local = await this.vault.readFile(item.originalPath).catch(() => null);
      const remote = item.remoteDeleted ? null : await this.client.getFile(item.originalPath);
      const preview = new Modal(this.app);
      preview.contentEl.createEl('h2', { text: item.originalPath });
      for (const [label, data] of [['Local', local], ['Current server file', remote]] as const) {
        preview.contentEl.createEl('h3', { text: label });
        preview.contentEl.createEl('pre', { text: data ? new TextDecoder().decode(data.slice(0, 128 * 1024)) : '(deleted or unavailable)' });
        if (data && data.byteLength > 128 * 1024) preview.contentEl.createEl('p', { text: 'Preview truncated to 128 KiB.' });
      }
      preview.open();
    } catch (e) {
      new Notice(`Could not open: ${errorMessage(e)}`);
    }
  }

  private async runAction(action: () => Promise<void>): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try { await this.exclusive(action); } catch (e) { new Notice(`Conflict action failed: ${errorMessage(e)}`); }
    finally { this.busy = false; }
  }

  private async markResolved(item: ConflictItem, hash?: string): Promise<void> {
    if (hash) await this.state?.setFileHash(item.originalPath, hash);
    else if (hash === '') await this.state?.removeFileHash(item.originalPath);
    await this.state?.setConflict(item.originalPath, null);
    await this.state?.queue(item.originalPath, null);
    this.resolved.add(item.originalPath);
    await this.state?.resolveCopy(item.conflictPath);
  }

  private async runKeepLocal(item: ConflictItem): Promise<void> {
    const result = await keepLocal(item, this.vault, this.client);
    if (!result.ok) {
      new Notice(result.message);
      return;
    }
    await this.markResolved(item, result.hash);
    new Notice(`Kept local bytes for ${item.originalPath}`);
    await this.render();
  }

  private async runKeepServer(item: ConflictItem): Promise<void> {
    const result = await keepServer(item, this.vault, this.client);
    if (!result.ok) {
      new Notice(result.message);
      return;
    }
    await this.markResolved(item, result.hash);
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
