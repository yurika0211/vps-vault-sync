import { App, Modal, Setting } from 'obsidian';

export class ConfirmModal extends Modal {
  private settle?: (value: boolean) => void;
  constructor(app: App, private message: string, private action: string) { super(app); }
  wait(): Promise<boolean> { return new Promise(resolve => { this.settle = resolve; this.open(); }); }
  onOpen(): void {
    this.contentEl.createEl('p', { text: this.message });
    new Setting(this.contentEl)
      .addButton(b => b.setButtonText('Cancel').onClick(() => this.close()))
      .addButton(b => {
        b.buttonEl.addClass('mod-warning');
        return b.setButtonText(this.action).onClick(() => { this.settle?.(true); this.settle = undefined; this.close(); });
      });
  }
  onClose(): void { this.settle?.(false); this.settle = undefined; this.contentEl.empty(); }
}
