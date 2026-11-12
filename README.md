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

CI on pull requests and on pushes to `feat/vps-vault-sync-sample`, `main`, and `master` runs plugin lint, test, and build, and `go test ./...`. It does not push an image.

## Deploy the server on a VPS

After the tag workflow finishes, on the VPS:

```bash
cd server
export VPS_VAULT_SYNC_TAG=v0.1.0
docker compose -f docker-compose.prod.yml pull
docker compose -f docker-compose.prod.yml up -d
docker compose -f docker-compose.prod.yml logs -f vault-sync
```

`docker-compose.prod.yml` uses `ghcr.io/yurika0211/vps-vault-sync-server`. It publishes `8080` and mounts `./data` to `/data`. Omit `VPS_VAULT_SYNC_TAG` to pull `:latest`. Do not put a token in the compose file or the image.

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

The image is `ghcr.io/peoneer/self-hosted-vault-sync-server:latest` and publishes `8080`.

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

## Tests

```bash
cd plugin && npm test
cd server && go test ./...
```
