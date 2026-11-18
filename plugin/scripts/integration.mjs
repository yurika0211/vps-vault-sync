// Runs the real TypeScript clients against a real Go server on loopback.
// Only Obsidian's requestUrl and vault filesystem boundary are adapted for Node.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { randomBytes, webcrypto } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { build } from 'esbuild';

globalThis.crypto ??= webcrypto;
const plugin = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const temp = await mkdtemp(join(tmpdir(), 'vault-sync-integration-'));
const binary = join(temp, 'server');
const token = randomBytes(32).toString('hex');
let process;
let exit;
let serverOutput = '';
const socket = createServer();
socket.listen(0, '127.0.0.1');
await once(socket, 'listening');
const port = socket.address().port;
await new Promise(resolve => socket.close(resolve));
const url = `http://127.0.0.1:${port}`;

async function start() {
  process = spawn(binary, [], { env: { ...globalThis.process.env, DATA_DIR: temp, BIND_HOST: '127.0.0.1', PORT: String(port), BOOTSTRAP_TOKEN: token }, stdio: ['ignore', 'pipe', 'pipe'] });
  exit = once(process, 'exit');
  process.stdout.on('data', b => { serverOutput += b.toString(); });
  process.stderr.on('data', b => { serverOutput += b.toString(); });
  for (let i = 0; i < 100; i++) {
    if (process.exitCode !== null) throw new Error('Server exited before becoming ready');
    try { if ((await fetch(`${url}/health`)).ok) return; } catch { /* starting */ }
    await delay(50);
  }
  throw new Error('Server startup timed out');
}
async function stop() {
  if (process && process.exitCode === null) {
    process.kill('SIGTERM');
    await exit;
  }
  process = undefined;
}
const bytes = s => new TextEncoder().encode(s).buffer;
const text = b => new TextDecoder().decode(b);

try {
  execFileSync('go', ['build', '-o', binary, './cmd/server'], { cwd: join(plugin, '../server'), env: { ...globalThis.process.env, GOWORK: 'off' }, stdio: 'pipe' });
  const bundle = join(temp, 'engine.mjs');
  await build({
    stdin: { contents: "export { SyncEngine } from './src/engine'; export { SyncClient } from './src/client'; export { createState } from './src/state'; export { WorkspaceActions } from './src/workspaceActions';", resolveDir: plugin },
    bundle: true, platform: 'node', format: 'esm', outfile: bundle,
    plugins: [{ name: 'obsidian-http', setup(b) {
      b.onResolve({ filter: /^obsidian$/ }, () => ({ path: 'obsidian', namespace: 'shim' }));
      b.onLoad({ filter: /.*/, namespace: 'shim' }, () => ({ contents: `export async function requestUrl(o) {
        const r = await fetch(o.url, { method: o.method, headers: o.headers, body: o.body });
        const arrayBuffer = await r.arrayBuffer();
        return { status: r.status, headers: Object.fromEntries(r.headers), arrayBuffer,
          get json() { return JSON.parse(new TextDecoder().decode(arrayBuffer)); } };
      }` }));
    } }],
  });
  const { SyncClient, SyncEngine, createState, WorkspaceActions } = await import(pathToFileURL(bundle).href);
  await start();
  const client = new SyncClient(url, token);
  const makeDevice = async (name, contents, persisted = false) => {
    const stateFile = join(temp, `client-${name}.json`);
    const state = await createState({ load: async () => persisted ? JSON.parse(await readFile(stateFile, 'utf8')) : undefined, save: async d => writeFile(stateFile, JSON.stringify(d)) });
    const files = contents instanceof Map ? contents : new Map(Object.entries(contents));
    const vault = {
      listAll: async () => [...files.keys()], exists: async p => files.has(p),
      readFile: async p => { if (!files.has(p)) throw new Error(`Missing ${p}`); return bytes(files.get(p)); },
      writeFile: async (p, b) => { files.set(p, text(b)); }, deleteFile: async p => { files.delete(p); },
      mtime: async () => 0, pruneEmptyParents: async () => {},
    };
    const engine = new SyncEngine(client, vault, state, () => {}, '.obsidian', async () => true);
    return { state, files, vault, engine };
  };
  const a = await makeDevice('a', { 'a.md': 'original' });
  let b = await makeDevice('b', {});
  await a.engine.initialSync();
  await b.engine.initialSync();
  assert.equal(b.files.get('a.md'), 'original');

  a.files.set('a.md', 'A edit');
  b.files.set('a.md', 'B edit');
  await a.state.queue('a.md', 'upload');
  await b.state.queue('a.md', 'upload');
  await a.engine.retryPending();
  await b.engine.retryPending();
  assert.ok(b.state.conflicts['a.md']);
  assert.equal(text(await client.getFile('a.md')), 'A edit');
  assert.equal(b.files.get('a.md'), 'B edit');
  const actions = device => new WorkspaceActions(client, device.vault, device.engine, device.state, () => true);
  await actions(b).resolve(await actions(b).compare('a.md'), 'server');
  assert.equal(b.files.get('a.md'), 'A edit');
  assert.equal(b.state.conflicts['a.md'], undefined);
  const discarded = (await client.revisions('a.md')).find(e => e.kind === '冲突时保留');
  assert.equal(text(await client.getFileAt('a.md', discarded.hash)), 'B edit');

  // Offline edits survive a new engine/state instance and server restart.
  await stop();
  b.files.set('offline.md', 'offline edit');
  await b.engine.scanLocalChanges();
  assert.ok(await b.engine.retryPending() > 0);
  await b.engine.stop();
  b = await makeDevice('b', b.files, true);
  assert.equal(b.state.pending['offline.md'], 'upload');
  await start();
  assert.equal(await b.engine.retryPending(), 0);
  await a.engine.pull();
  assert.equal(a.files.get('offline.md'), 'offline edit');

  // A stale deletion task cannot remove a recreated local file.
  await b.state.queue('offline.md', 'delete');
  b.files.set('offline.md', 'recreated');
  await b.engine.retryPending();
  await b.engine.retryPending();
  assert.equal(text(await client.getFile('offline.md')), 'recreated');

  // Ordinary remote deletion propagates after both devices agree on content.
  await a.engine.pull();
  b.files.delete('offline.md');
  await b.state.queue('offline.md', 'delete');
  await b.engine.retryPending();
  await a.engine.pull();
  assert.equal(a.files.has('offline.md'), false);

  // History paging returns every write, including writes sharing a second.
  const cursor = (await client.getSnapshot()).cursor;
  for (let i = 0; i < 260; i++) await client.putFile(`page-${i}.md`, bytes(`value ${i}`), '');
  const page1 = await client.getChangePage(cursor);
  const page2 = await client.getChangePage(page1.cursor);
  assert.equal(page1.changes.length, 256);
  assert.equal(page1.hasMore, true);
  assert.equal(page2.changes.length, 4);
  assert.equal(page2.hasMore, false);
  const finalCursor = page2.cursor;
  await stop();
  await start();
  assert.equal((await client.getChangePage(finalCursor)).changes.length, 0);
  await a.engine.pull();
  assert.equal(a.files.get('page-259.md'), 'value 259');
  const now = Date.now();
  const names = ['review/local.md','review/remote.md'];
  for (const p of names) {
    await client.putFile(p, bytes('cloud:'+p), '', now - 600000);
    b.files.set(p, 'offline:'+p);
    await b.state.setConflict(p,(await client.getFileInfo(p)).hash);
  }
  b.vault.mtime = async p => now - (p === names[0] ? 10000 : 1200000);
  const workspace = actions(b);
  const compared = await Promise.all(names.map(p => workspace.compare(p)));
  assert.deepEqual(compared.map(n => n.newer),['local','server']);
  for (const note of compared) await workspace.resolve(note,note.newer);
  assert.equal(text(await client.getFile(names[0])),'offline:'+names[0]);
  assert.equal(b.files.get(names[1]),'cloud:'+names[1]);
  for (const [i,p] of names.entries()) {
    const old = (await client.revisions(p)).find(e=>e.kind==='冲突时保留');
    assert.equal(text(await client.getFileAt(p,old.hash)), (i===0?'cloud:':'offline:')+p);
  }
  // A second writer invalidates the preview, including when the path changes back.
  const path = names[1];
  b.files.set(path,'unsaved text');
  await b.state.setConflict(path,(await client.getFileInfo(path)).hash);
  const stale = await workspace.compare(path);
  await client.putFile(path,bytes('concurrent edit'),stale.remote.hash,now);
  await assert.rejects(workspace.resolve(stale,'local'));
  assert.ok(b.state.conflicts[path]);
  assert.equal(b.files.get(path),'unsaved text');
  const fresh=await workspace.compare(path);
  // A durable archive must succeed before the current body is replaced.
  const pendingFile=join(temp,'vault','pending-change.json');
  await mkdir(pendingFile);
  await assert.rejects(workspace.resolve(fresh,'server'));
  assert.equal(b.files.get(path),'unsaved text');
  assert.ok(b.state.conflicts[path]);
  await rm(pendingFile,{recursive:true});
  await stop(); await start();
  await workspace.resolve(fresh,'server');
  const snap=await client.createSnapshot('before reorganization',await workspace.synchronizedCursor());
  const info=await client.getFileInfo(path);
  await client.deleteFile(path,info.hash);
  await client.putFile('after.md',bytes('keep until full restore'),'');
  assert.deepEqual((await client.searchNotes('',0)).paths,[]);
  assert.deepEqual((await client.searchNotes('review/remote',0)).paths,[path]);
  const first=await client.searchNotes('page-',0),second=await client.searchNotes('page-',5);
  assert.equal(first.paths.length,5);assert.ok(first.more);assert.equal(new Set([...first.paths,...second.paths]).size,10);
  const manifest=await client.manifest(snap.id);
  await client.restoreSnapshot(snap.id,path,manifest.cursor);
  assert.equal(text(await client.getFile(path)),'concurrent edit');
  assert.equal(text(await client.getFile('after.md')),'keep until full restore');
  await assert.rejects(client.restoreSnapshot(snap.id,'',manifest.cursor));
  await client.restoreSnapshot(snap.id,'',(await client.manifest(snap.id)).cursor);
  assert.equal((await client.getFileInfo('after.md')).action,'deleted');
  await stop();await start();
  assert.ok((await client.snapshots()).some(s=>s.name.startsWith('恢复前')));
  const revision=(await client.revisions(path)).find(e=>e.kind==='冲突时保留' && e.hash!==info.hash);
  await client.restoreVersion(path,revision.hash,(await client.manifest(snap.id)).cursor);
  assert.equal((await client.getFileInfo(path)).hash,revision.hash);
  console.log('PASS: opposite winners, archive failure, concurrent edits, five-result search, deleted-file restore, full restore and restart');
  console.log('PASS: two clients; conflicts; offline/reload/restart; delete/recreate; 260-write cursor paging');
} catch (e) {
  console.error(serverOutput.replaceAll(token, '[test-token]').slice(-3000));
  throw e;
} finally {
  await stop();
  await rm(temp, { recursive: true, force: true });
}
