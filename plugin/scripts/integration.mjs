// Runs the real TypeScript clients against a real Go server on loopback.
// Only Obsidian's requestUrl and vault filesystem boundary are adapted for Node.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { randomBytes, webcrypto } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
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
    stdin: { contents: "export { SyncEngine } from './src/engine'; export { SyncClient } from './src/client'; export { createState } from './src/state'; export { keepServer } from './src/conflicts';", resolveDir: plugin },
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
  const { SyncClient, SyncEngine, createState, keepServer } = await import(pathToFileURL(bundle).href);
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
  const resolved = await keepServer({ originalPath: 'a.md', conflictPath: 'unused', copyLocation: 'server', canonical: 'server' }, b.vault, client);
  assert.ok(resolved.ok);
  assert.equal(b.files.get('a.md'), 'A edit');
  await b.state.setFileHash('a.md', resolved.hash);
  await b.state.setConflict('a.md', null);
  await b.state.queue('a.md', null);

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
  console.log('PASS: two clients; conflicts; offline/reload/restart; delete/recreate; 260-write cursor paging');
} catch (e) {
  console.error(serverOutput.replaceAll(token, '[test-token]').slice(-3000));
  throw e;
} finally {
  await stop();
  await rm(temp, { recursive: true, force: true });
}
