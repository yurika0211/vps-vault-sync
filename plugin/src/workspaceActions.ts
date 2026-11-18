import type { FileInfo, SyncClient, Version } from './client';
import type { SyncState } from './state';
import type { SyncEngine, VaultAdapter } from './engine';
import { sha256hex } from './util';
import { parseLocalConflictPath, parseRemoteConflictPath } from './conflicts';

export interface ComparedNote {
  path: string;
  local: Version;
  remote: FileInfo;
  newer: 'local' | 'server' | null;
}

export class WorkspaceActions {
  constructor(
    readonly client: SyncClient,
    private vault: VaultAdapter,
    private engine: SyncEngine,
    private state: SyncState,
    private allowed: (path: string) => boolean,
  ) {}

  private async readLocal(path: string) {
    if (!this.allowed(path)) throw new Error('此路径不在同步范围内');
    if (!(await this.vault.exists(path)))
      return { hash: '', data: new ArrayBuffer(0), modified: undefined };
    const before = await this.vault.mtime(path);
    const data = await this.vault.readFile(path);
    if (before !== (await this.vault.mtime(path))) throw new Error('本地内容已变化，请刷新');
    return { hash: await sha256hex(data), data, modified: before ?? undefined };
  }

  async compare(path: string): Promise<ComparedNote> {
    const start = Date.now();
    const [local, info] = await Promise.all([this.readLocal(path), this.client.getFileInfo(path)]);
    const remote = info ?? { hash: '', action: 'deleted', seq: 0 };
    const now = Date.now();
    const l = local.modified ?? 0,
      r = remote.modified ?? 0;
    // Each device's reported clock may differ from server time by up to 60s.
    const comparable =
      l > 0 &&
      r > 0 &&
      l <= now &&
      Math.abs(l - r) > 120000 &&
      now - start < 60000 &&
      Math.abs((remote.serverTime ?? 0) - now) < 60000;
    return {
      path,
      local: { hash: local.hash, modified: local.modified },
      remote,
      newer: comparable ? (l > r ? 'local' : 'server') : null,
    };
  }

  async migrateCopies() {
    await this.engine.runExclusive(async () => {
      for (const path of await this.vault.listAll()) {
        const original = parseLocalConflictPath(path) ?? parseRemoteConflictPath(path);
        if (!original || !this.allowed(original.originalPath)) continue;
        const data = await this.vault.readFile(path);
        const hash = await sha256hex(data);
        await this.client.archiveCopy(original.originalPath, data, hash, await this.vault.mtime(path));
        if ((await sha256hex(await this.vault.readFile(path))) !== hash) continue;
        // Old clients may only have the sibling, with no persisted conflict marker.
        if (!this.state.resolvedCopies[path] && !this.state.conflicts[original.originalPath]) {
          const note = await this.compare(original.originalPath);
          if (note.local.hash !== note.remote.hash)
            await this.state.setConflict(note.path, note.remote.hash || 'deleted');
        }
        await this.vault.deleteFile(path);
      }
    });
  }

  paths() {
    return Object.keys(this.state.conflicts).filter(this.allowed).sort();
  }

  async preview(note: ComparedNote) {
    const local = await this.readLocal(note.path);
    if (local.hash !== note.local.hash) throw new Error('本地版本已变化，请刷新');
    const remote = note.remote.hash ? await this.client.getFileAt(note.path, note.remote.hash) : null;
    return [local.hash ? local.data : null, remote] as const;
  }

  resolve(note: ComparedNote, keep: 'local' | 'server') {
    return this.engine.runExclusive(async () => {
      if (!this.state.conflicts[note.path]) throw new Error('此冲突已经处理');
      const local = await this.readLocal(note.path);
      if (local.hash !== note.local.hash || local.modified !== note.local.modified)
        throw new Error('本地版本已变化');
      const incoming =
        keep === 'server' && note.remote.hash
          ? await this.client.getFileAt(note.path, note.remote.hash)
          : null;
      const winner = await this.client.resolve(note.path, note.local, note.remote, local.data, keep);
      const expected = keep === 'server' ? note.remote.hash : local.hash;
      if (winner.hash !== expected) throw new Error('服务端版本已变化');
      await this.assertCurrent(note.path, expected);
      if ((await this.readLocal(note.path)).hash !== local.hash)
        throw new Error('本地笔记在处理期间发生变化');
      if (keep === 'server' && expected !== local.hash) {
        if (incoming && this.vault.replaceReviewed)
          await this.vault.replaceReviewed(note.path, local.hash ? local.data : null, incoming);
        else if (incoming) await this.vault.writeFile(note.path, incoming);
        else await this.vault.deleteFile(note.path);
      }
      if ((await this.readLocal(note.path)).hash !== expected) throw new Error('本地写入未完成，请刷新');
      await this.assertCurrent(note.path, expected);
      if (expected) await this.state.setFileHash(note.path, expected);
      else await this.state.removeFileHash(note.path);
      await this.state.queue(note.path, null);
      await this.state.setConflict(note.path, null);
    });
  }

  private async assertCurrent(path: string, expected: string) {
    if (((await this.client.getFileInfo(path))?.hash || '') !== expected)
      throw new Error('服务器在处理期间发生变化');
  }

  async synchronizedCursor() {
    await this.engine.scanLocalChanges();
    const pull = await this.engine.pull();
    if (pull.blocked || pull.failed || (await this.engine.retryPending()))
      throw new Error('同步尚未完成，请重试');
    const final = await this.engine.pull();
    if (final.blocked || final.failed) throw new Error('同步尚未完成');
    return this.engine.runExclusive(async () => {
      if (this.paths().length || Object.keys(this.state.pending).length)
        throw new Error('请先处理待同步修改和冲突');
      const paths = new Set([...(await this.vault.listAll()), ...Object.keys(this.state.files)]);
      for (const p of paths) {
        if (this.allowed(p) && (await this.readLocal(p)).hash !== (this.state.files[p] ?? ''))
          throw new Error('本地内容与云端尚未同步');
      }
      return this.state.cursor;
    });
  }

  async applyRestored() {
    const result = await this.engine.pull();
    if (result.failed || result.blocked || this.paths().length)
      throw new Error('云端已恢复，本地仍有待同步内容或冲突');
  }
}
