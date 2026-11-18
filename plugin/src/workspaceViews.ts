import { ItemView, Notice, WorkspaceLeaf } from 'obsidian';
import diffSequence from 'diff-sequences';
import type VaultSyncPlugin from './main';
import type { ComparedNote, WorkspaceActions } from './workspaceActions';
import type { Manifest, Revision, Snapshot } from './client';
import { errorMessage } from './errors';

export const CONFLICTS = 'vps-vault-sync-conflicts';
export const HISTORY = 'vps-vault-sync-history';

function button(parent: HTMLElement, text: string, run: () => void, primary = false) {
  const el = parent.createEl('button', { text });
  if (primary) el.addClass('mod-cta');
  el.onclick = run;
  return el;
}

function previewText(data: ArrayBuffer | null): string {
  if (!data) return '（已删除）';
  if (data.byteLength > 512 * 1024) return '（文件较大，已省略正文预览）';
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(data);
    return text.includes('\0') ? '（二进制文件）' : text;
  } catch {
    return '（二进制文件）';
  }
}

function lineDiff(parent: HTMLElement, left: string, right: string) {
  const a = left.split(/\r?\n/),
    b = right.split(/\r?\n/);
  if (a.length + b.length > 4000) {
    parent.createEl('p', { text: '行数超过预览上限。' });
    return;
  }
  let x = 0,
    y = 0;
  const row = (l: string | undefined, r: string | undefined, changed: boolean) => {
    const pair = parent.createDiv({ cls: 'vvs-diff-row' });
    for (const [value, sign] of [
      [l, '−'],
      [r, '+'],
    ] as const) {
      const cell = pair.createEl('pre', {
        text: value === undefined ? '' : (changed ? sign + ' ' : '  ') + value,
      });
      if (changed && value !== undefined) cell.addClass(sign === '+' ? 'vvs-add' : 'vvs-remove');
    }
  };
  const section = (common: number, ax: number, by: number) => {
    while (x < ax || y < by) row(x < ax ? a[x++] : undefined, y < by ? b[y++] : undefined, true);
    for (let i = 0; i < common; i++) row(a[x++], b[y++], false);
  };
  diffSequence(a.length, b.length, (i, j) => a[i] === b[j], section);
  section(0, a.length, b.length);
}

abstract class SyncView extends ItemView {
  private generation = 0;
  protected busy = false;
  constructor(
    leaf: WorkspaceLeaf,
    protected plugin: VaultSyncPlugin,
  ) {
    super(leaf);
  }
  async onOpen() {
    await this.refresh();
  }
  onClose() {
    this.generation++;
    return Promise.resolve();
  }
  protected abstract draw(root: HTMLElement, actions: WorkspaceActions): Promise<void>;
  async refresh() {
    const generation = ++this.generation;
    const root = this.contentEl.createDiv({ cls: 'vvs-workspace' });
    root.remove();
    root.createEl('h2', { text: this.getDisplayText() });
    button(root, '刷新', () => {
      void this.refresh();
    });
    try {
      await this.draw(root, this.plugin.workspaceActions());
    } catch (e) {
      root.createEl('p', { text: errorMessage(e), cls: 'mod-warning' });
    }
    if (this.generation === generation) this.contentEl.replaceChildren(root);
  }
  protected async act(action: () => Promise<void>) {
    if (this.busy) return;
    this.busy = true;
    this.contentEl.addClass('vvs-busy');
    try {
      await action();
    } catch (e) {
      new Notice(errorMessage(e));
    } finally {
      this.busy = false;
      this.contentEl.removeClass('vvs-busy');
      await this.refresh();
    }
  }
}

export class ConflictsView extends SyncView {
  private path = '';
  private refreshTimer?: number;
  scheduleRefresh() {
    window.clearTimeout(this.refreshTimer);
    this.refreshTimer = window.setTimeout(() => {
      if (!this.busy) void this.refresh();
    }, 180);
  }
  onClose() {
    window.clearTimeout(this.refreshTimer);
    return super.onClose();
  }
  getViewType() {
    return CONFLICTS;
  }
  getDisplayText() {
    return '全仓冲突';
  }
  getIcon() {
    return 'git-compare-arrows';
  }
  protected async draw(root: HTMLElement, actions: WorkspaceActions) {
    await actions.migrateCopies();
    const notes: ComparedNote[] = [];
    const errors: string[] = [];
    for (const path of actions.paths()) {
      try {
        notes.push(await actions.compare(path));
      } catch (e) {
        errors.push(path + ' · ' + errorMessage(e));
      }
    }
    const eligible = notes.filter((n) => n.newer);
    const bar = root.createDiv({ cls: 'vvs-toolbar' });
    const apply = button(
      bar,
      '一键使用最新修改　' + eligible.length + ' 篇',
      () => {
        void this.act(async () => {
          let done = 0;
          const failed: string[] = [];
          for (const note of eligible) {
            try {
              if (note.newer) {
                await actions.resolve(note, note.newer);
                done++;
              }
            } catch (e) {
              failed.push(note.path + ' · ' + errorMessage(e));
            }
          }
          new Notice(['已处理 ' + done + ' 篇。', ...failed].join('\n'), 8000);
        });
      },
      true,
    );
    apply.disabled = !eligible.length;
    if (errors.length) root.createEl('p', { text: errors.join('\n') });
    if (!notes.length) {
      root.createEl('p', { text: errors.length ? '请刷新以重试。' : '没有待处理的冲突。' });
      if (this.path)
        button(root, '查看这篇笔记的历史 · ' + this.path, () => {
          void this.plugin.openHistory(this.path);
        });
      return;
    }
    const grid = root.createDiv({ cls: 'vvs-grid' }),
      queue = grid.createDiv(),
      detail = grid.createDiv();
    queue.createEl('h3', { text: '待处理 · ' + (notes.length + errors.length) });
    const selected = notes.find((n) => n.path === this.path) ?? notes[0];
    this.path = selected.path;
    for (const n of notes) {
      const el = button(queue, n.path, () => {
        this.path = n.path;
        void this.refresh();
      });
      el.setAttribute('aria-pressed', String(n === selected));
    }
    detail.createEl('h3', { text: selected.path });
    const [local, remote] = await actions.preview(selected);
    const heads = detail.createDiv({ cls: 'vvs-diff-row' });
    for (const [side, title] of [
      ['local', '本地当前版'],
      ['server', '服务器当前版'],
    ] as const) {
      const h = heads.createEl('strong', { text: title });
      if (selected.newer === side) {
        h.addClass('vvs-later');
        h.setAttribute('aria-label', title + '，较晚修改');
      }
    }
    lineDiff(detail, previewText(local), previewText(remote));
    const buttons = detail.createDiv({ cls: 'vvs-toolbar' });
    button(buttons, '用本地版更新服务器', () => {
      void this.act(() => actions.resolve(selected, 'local'));
    });
    button(buttons, '用服务器版更新本地', () => {
      void this.act(() => actions.resolve(selected, 'server'));
    });
    button(detail, '查看这篇笔记的历史', () => {
      void this.plugin.openHistory(selected.path);
    });
  }
}

export class HistoryView extends SyncView {
  private path = '';
  private snapshot = '';
  private manifestPage = 0;
  private revision?: Revision;
  private body = '';
  private query = '';
  private offset = 0;
  private searchGeneration = 0;
  getViewType() {
    return HISTORY;
  }
  getDisplayText() {
    return '版本历史';
  }
  getIcon() {
    return 'history';
  }
  async show(path: string) {
    this.path = path;
    this.revision = undefined;
    this.body = '';
    this.query = '';
    this.offset = 0;
    await this.refresh();
  }
  protected async draw(root: HTMLElement, a: WorkspaceActions) {
    const scope = this.path;
    const controls = root.createDiv({ cls: 'vvs-toolbar' });
    if (scope)
      button(controls, '全仓快照', () => {
        void this.show('');
      });
    const search = controls.createEl('input', { type: 'search', placeholder: '输入笔记名或路径' });
    search.setAttribute('aria-label', '查找笔记');
    search.value = this.query;
    const results = root.createDiv();
    const find = async () => {
      const ticket = ++this.searchGeneration;
      const q = search.value.trim();
      results.empty();
      if (!q) return;
      try {
        const page = await a.client.searchNotes(q, this.offset);
        if (ticket !== this.searchGeneration) return;
        for (const p of page.paths)
          button(results, p, () => {
            void this.show(p);
          });
        if (!page.paths.length) results.createSpan({ text: '没有匹配的笔记' });
        if (this.offset)
          button(results, '上一页', () => {
            this.offset -= 5;
            void find();
          });
        if (page.more)
          button(results, '下一页', () => {
            this.offset += 5;
            void find();
          });
      } catch (e) {
        if (ticket === this.searchGeneration) results.setText(errorMessage(e));
      }
    };
    search.oninput = () => {
      this.query = search.value;
      this.offset = 0;
      void find();
    };
    if (this.query) await find();
    if (scope) {
      await this.note(root, a, scope);
      return;
    }
    const name = controls.createEl('input', { type: 'text', placeholder: '快照名称（选填）' });
    name.maxLength = 128;
    button(
      controls,
      '创建全仓快照',
      () => {
        void this.act(async () => {
          const cursor = await a.synchronizedCursor();
          const saved = await a.client.createSnapshot(name.value.trim(), cursor);
          this.snapshot = saved.id;
          this.manifestPage = 0;
        });
      },
      true,
    );
    const list = await a.client.snapshots();
    if (!list.length) {
      root.createEl('p', { text: '还没有全仓快照。' });
      return;
    }
    const grid = root.createDiv({ cls: 'vvs-grid' }),
      nav = grid.createDiv(),
      detail = grid.createDiv();
    const active = list.find((s) => s.id === this.snapshot) ?? list[0];
    for (const s of list) {
      const el = button(nav, s.name + ' · ' + new Date(s.time).toLocaleString(), () => {
        this.snapshot = s.id;
        this.manifestPage = 0;
        void this.refresh();
      });
      if (s === list[0]) el.addClass('vvs-later');
      el.setAttribute('aria-pressed', String(s === active));
    }
    const manifest = await a.client.manifest(active.id);
    detail.createEl('h3', { text: active.name });
    const files = Object.keys(manifest.files).sort();
    const size = 50;
    this.manifestPage = Math.max(0, Math.min(this.manifestPage, Math.ceil(files.length / size) - 1));
    const first = this.manifestPage * size;
    for (const p of files.slice(first, first + size)) {
      const row = detail.createDiv({ cls: 'vvs-file-row' });
      row.createSpan({ text: p });
      if (manifest.current[p]?.hash !== manifest.files[p].hash)
        button(row, '恢复此文件…', () => {
          void this.act(() => this.restore(a, active, manifest, p));
        });
    }
    if (files.length > size) {
      const pages = detail.createDiv({ cls: 'vvs-toolbar' });
      button(pages, '上一页', () => {
        this.manifestPage--;
        void this.refresh();
      }).disabled = first === 0;
      pages.createSpan({ text: `${first + 1}–${Math.min(first + size, files.length)} / ${files.length}` });
      button(pages, '下一页', () => {
        this.manifestPage++;
        void this.refresh();
      }).disabled = first + size >= files.length;
    }
    button(detail, '恢复整个仓…', () => {
      void this.act(() => this.restore(a, active, manifest, ''));
    });
  }

  private async restore(a: WorkspaceActions, s: Snapshot, manifest: Manifest, path: string) {
    const paths = path
      ? [path]
      : [...new Set([...Object.keys(manifest.current), ...Object.keys(manifest.files)])].sort();
    const changes = paths
      .filter((p) => manifest.current[p]?.hash !== manifest.files[p]?.hash)
      .map(
        (p) =>
          (!Object.prototype.hasOwnProperty.call(manifest.files, p)
            ? '移除'
            : !Object.prototype.hasOwnProperty.call(manifest.current, p)
              ? '找回'
              : '覆盖') +
          '　' +
          p,
      );
    if (!changes.length) {
      new Notice('内容已一致');
      return;
    }
    if (
      !(await this.plugin.confirmAction(
        ['从「' + s.name + '」恢复。将先保存恢复前快照。', ...changes].join('\n'),
        '确认恢复',
      ))
    )
      return;
    const cursor = await a.synchronizedCursor();
    if (cursor !== manifest.cursor) throw new Error('仓库已变化，请重新查看影响范围');
    await a.client.restoreSnapshot(s.id, path, cursor);
    await a.applyRestored();
  }

  private async note(root: HTMLElement, a: WorkspaceActions, path: string) {
    root.createEl('h3', { text: path });
    const entries = await a.client.revisions(path);
    if (!entries.length) {
      root.createEl('p', { text: '暂无历史记录。' });
      return;
    }
    const grid = root.createDiv({ cls: 'vvs-grid' }),
      nav = grid.createDiv(),
      detail = grid.createDiv();
    const detailBody = () => {
      detail.empty();
      if (!this.revision) {
        detail.createSpan({ text: '选择记录查看正文。' });
        return;
      }
      const entry = this.revision;
      detail.createEl('h4', { text: entry.kind + ' · ' + (entry.name || path) });
      detail.createEl('pre', { text: this.body, cls: 'vvs-body' });
      button(detail, '恢复此版本…', () => {
        void this.act(async () => {
          if (!(await this.plugin.confirmAction('将「' + path + '」恢复到选中的版本。', '确认恢复')))
            return;
          const cursor = await a.synchronizedCursor();
          await a.client.restoreVersion(path, entry.hash, cursor);
          await a.applyRestored();
        });
      });
    };
    for (const entry of entries) {
      button(
        nav,
        [entry.kind, entry.name, new Date(entry.time).toLocaleString()].filter(Boolean).join(' · '),
        () => {
          void this.act(async () => {
            const data = await a.client.getFileAt(path, entry.hash);
            if (this.path !== path) return;
            this.body = previewText(data);
            this.revision = entry;
          });
        },
      );
    }
    detailBody();
  }
}
