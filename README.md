# VPS Vault Sync

Local fork of Self-Hosted Vault Sync. MIT. Upstream copyright stays in `plugin/LICENSE` and `server/LICENSE` (Copyright (c) 2026 Valentin Britvich).

This tree is one git repo. Upstream URLs are recorded beside each copy:

| Tree | Upstream | Commit copied |
| --- | --- | --- |
| `plugin/` | https://github.com/PeoneEr/self-hosted-vault-sync | `64aaafb33f530687cb86a808b1c9ed7182455efa` |
| `server/` | https://github.com/PeoneEr/self-hosted-vault-sync-server | `c86534f11168e1105a1e7d46f37eb7346aa1591a` |

The same URLs are in `plugin/.upstream-url` and `server/.upstream-url`.

## Run the server

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

## Load the plugin in a throwaway vault

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
