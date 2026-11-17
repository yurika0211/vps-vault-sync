# VPS Vault Sync

Local fork of Self-Hosted Vault Sync. MIT. Upstream copyright stays in `plugin/LICENSE` and `server/LICENSE` (Copyright (c) 2026 Valentin Britvich).

This tree is one git repo. Upstream URLs are recorded beside each copy:

| Tree | Upstream | Commit copied |
| --- | --- | --- |
| `plugin/` | https://github.com/PeoneEr/self-hosted-vault-sync | `64aaafb33f530687cb86a808b1c9ed7182455efa` |
| `server/` | https://github.com/PeoneEr/self-hosted-vault-sync-server | `c86534f11168e1105a1e7d46f37eb7346aa1591a` |

The same URLs are in `plugin/.upstream-url` and `server/.upstream-url`.

Nested `plugin/.github` and `server/.github` workflows are upstream provenance. GitHub Actions runs only the workflows at the repository root.

## Tag scheme

One tag releases both artifacts. Push a tag named exactly `vX.Y.Z`, three numeric parts and nothing else, for example `v0.1.0`. The release jobs exit before publish if the tag is not that shape. `v1.2` and `v1.2.3-extra` do not release.

That tag push builds and pushes the storage-server image, and attaches the plugin files to a GitHub Release. The image tags are `vX.Y.Z` and `latest`. The plugin `manifest.json` version is `X.Y.Z` (the tag without the leading `v`). Do not push a tag from a machine that should not publish.

CI on pull requests and on pushes to `feat/vps-vault-sync-sample`, `main`, and `master` runs plugin lint, type checking, tests and build, Go race tests, and two-client HTTP integration tests. It does not push an image.

## Upgrade and sync behavior

Upgrade this repository's **server first**, then all plugins. The plugin requires Obsidian **1.11.4+** and the new sequence-cursor API; an upstream server or an older image cannot provide that API. The server retains the legacy `since` endpoint, but old clients still have its timestamp limitations. Back up the complete server data directory before upgrading. Do not trim/reorder `changelog.jsonl` or restore only its index: saved cursors refer to stable log positions. Run one server process per data directory.

New clients use bounded pages and fetch each file by its content hash. Failed pages remain retriable. Local edits/deletions are queued persistently and rescanned on startup; successful uploads precede pending deletions so a failed rename does not delete the old server copy. Exclude patterns apply in both directions. Vault configuration, `.git`, `.trash`, and conflict copies are never automatically synced.

Settings offer **Review connection**, **Pause/Resume sync**, **Sync now / retry**, and **Disconnect and clear token**. Pairing links open a review screen showing the destination and current vault; connecting requires confirmation. Sync status distinguishes pending work, conflicts, errors, and completed work. Changes while paused are picked up when resumed.

If the server reports a deletion but a local file has unsent edits, the local file is retained for an explicit conflict choice. Initial sync never restores a tombstoned path based on device timestamps. A fully empty local listing is treated conservatively: the plugin does not infer an offline delete-all from it.

## Deploy the server on a VPS

After the tag workflow finishes, on the VPS:

```bash
cd server
export VPS_VAULT_SYNC_TAG=v0.1.0
docker compose -f docker-compose.prod.yml pull
docker compose -f docker-compose.prod.yml up -d
docker compose -f docker-compose.prod.yml logs -f vault-sync
```

`docker-compose.prod.yml` uses `ghcr.io/yurika0211/vps-vault-sync-server`. It publishes `127.0.0.1:8080` and mounts `./data` to `/data`. Put a TLS reverse proxy in front. For direct private-network access, explicitly set `VPS_VAULT_SYNC_BIND` to that host's private/Tailscale IPv4 address. Omit `VPS_VAULT_SYNC_TAG` to pull `:latest`. Do not put a token in the compose file or the image.

On a fresh `./data` the process logs one bootstrap device token. Copy it from that log line. It is not printed again. Do not commit it.

```text
bootstrap device token (save this now — it will not be shown again): <token>
```

Health check, no token:

```bash
curl -sS http://127.0.0.1:8080/health
```

Expect `{"ok":true}`.

The compose file in the next section pulls the upstream PeoneEr image for local experiments. It is not the VPS deploy path.

## Run the server locally from upstream image

From `server/`, using the compose file already in that tree:

```bash
cd server
docker compose up
```

The image is `ghcr.io/peoneer/self-hosted-vault-sync-server:latest` and publishes `127.0.0.1:8080`. It is an upstream experiment, **not compatible with this fork's new cursor client**. Build this tree or use this repository's server release for the current plugin.

On a fresh data directory the process logs one bootstrap device token. Copy it from that log line. It is not printed again. Do not commit it.

```text
bootstrap device token (save this now — it will not be shown again): <token>
```

Health check, no token:

```bash
curl -sS http://127.0.0.1:8080/health
```

Expect `{"ok":true}`.

To build this tree instead of the published image, use `server/Dockerfile` with context `server/`. Do not put a token in the image.

## Install the plugin from a GitHub Release

After the `vX.Y.Z` workflow finishes, the release at `https://github.com/yurika0211/vps-vault-sync/releases/tag/vX.Y.Z` has `main.js` and `manifest.json`.

This repo is not an Obsidian community-plugin listing. Install by downloading those assets (manual or BRAT pointing at this repository's releases):

```bash
TAG=v0.1.0
DEST="<throwaway>/.obsidian/plugins/vps-vault-sync"
mkdir -p "$DEST"
base="https://github.com/yurika0211/vps-vault-sync/releases/download/${TAG}"
curl -fsSL -o "$DEST/main.js" "$base/main.js"
curl -fsSL -o "$DEST/manifest.json" "$base/manifest.json"
```

`styles.css` is not part of the build. The release attaches it only if a later build emits it. Copy it into the same folder when the release lists it.

Then enable **VPS Vault Sync** in Obsidian. Paste the server URL and the bootstrap token from the server log.

## Load the plugin in a throwaway vault from a local build

1. Create an empty folder. Open it in Obsidian as a vault. Do not use an existing vault.
2. Build the plugin: `cd plugin && npm install && npm run build`.
3. Copy `plugin/main.js`, `plugin/manifest.json`, and `plugin/styles.css` if present into `<throwaway>/.obsidian/plugins/vps-vault-sync/`.
4. In Obsidian, enable **VPS Vault Sync**.
5. Paste the server URL (`http://127.0.0.1:8080` from the host) and the bootstrap token from the server log.

The token is stored in Obsidian `secretStorage`, not in `data.json`. Server URL, interval, and exclude patterns stay in plugin data.

Pairing links use `obsidian://vps-vault-sync?...`.

Initial sync keeps the local file when hashes differ and writes the server bytes to `<stem>.conflict.<device>.<timestamp><ext>`.

## Conflicts

The plugin does not merge files and does not overwrite the canonical copy unless the upload's base hash still matches.

A stale daily push leaves the server file as canonical and stores the incoming bytes as `<file>.conflict.<timestamp>.<ext>`. The response sets `X-Conflict: true` and `X-Current-Hash` to the canonical hash. Those markdown copies stay on the server; the sync engine does not pull them into the vault. `GET /changes` still lists them, and `GET /file/{path}` can read one copy.

Initial sync writes a local sibling, `<stem>.conflict.<device>.<timestamp><ext>`, and leaves the original path holding the local bytes.

Open **Open conflict panel** from the command palette, or **Conflicts** in plugin settings. Each row shows the original path, the conflict copy path, and which side is canonical.

- **Compare local and server** previews the current versions, capped at 128 KiB each. Binary files are not rendered as a visual diff.
- **Keep local** uploads the original path's current bytes with the server's current hash as `X-Base-Hash`. A mismatch leaves the canonical file unchanged.
- **Keep server** downloads the current canonical server file and verifies its hash before writing locally. A rejected upload is never mistaken for server content. An explicit deletion conflict can also be resolved by keeping the server deletion.
- **Dismiss** asks first, then deletes the conflict copy. The original path stays.

Resolved copies remain available for recovery and are labelled accordingly; delete them explicitly when no longer needed. Automatic uploads for an unresolved path remain blocked.

## Security and capacity boundaries

This is a single-owner server: every paired device can read/write the whole vault, pair another device, and revoke any device. The separate admin token only opens the admin API. Revoking a device closes its active event streams. Tokens are long-lived; pairing links and QR codes are credentials. The server sees plaintext files: transport TLS/private tunnels are required, and there is no end-to-end encryption.

The server admits two uploads at a time (excess returns `429`, retried by the client), with a 100 MiB per-file limit; uploads and downloads still buffer complete files. Incremental lookup uses a cached log and pages of at most 256 entries. The log cache still grows with history, index updates still rewrite `index.json`, and blob garbage collection/quotas are not implemented. Capacity follow-up: [issue #8](https://github.com/yurika0211/vps-vault-sync/issues/8). Durable mutation intents recover interrupted metadata commits; a storage error may return `503` for an operation that is later completed during recovery, so clients reconcile before retrying.

## Tests

```bash
cd plugin
npm ci
npm run typecheck
npm run lint
npm test -- --runInBand
npm run build
npm run test:integration # needs Go; isolated temporary data and loopback only
cd ../server
GOWORK=off go test -race ./...
```
