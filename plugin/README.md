# Self-Hosted Vault Sync

Fast, reliable Obsidian vault sync backed by your own sync server — a lightweight
self-hosted alternative to Obsidian Sync / obsidian-livesync, with no vendor
lock-in. See the repository guide for file-size and storage-capacity limits.

This fork requires the matching server in [`../server`](../server). Upgrade the server before the plugin; upstream releases do not implement this fork's sequence cursor API. See the [repository guide](../README.md) for deployment and compatibility.

## Features

- **Push on change** — file edits are pushed after a short debounce (2s)
- **Pull on startup + poll** — vault is refreshed on load and every N seconds
- **Real-time push on desktop** — Server-Sent Events notify connected clients
  the moment another device pushes a change (falls back to polling on mobile,
  driven by app visibility changes)
- **Delta sync** — only changed files are transferred, not the whole vault
- **Conflict-safe writes** — a stale write is saved as a `.conflict.<timestamp>`
  copy instead of silently overwriting newer content
- **Exclude patterns** — glob-based exclusion list (workspace files excluded
  by default)

## Setup

1. Deploy this repository's [sync server](../server)
   somewhere reachable from your devices. Its startup log prints a one-time
   **bootstrap token** — copy it.
2. Install this plugin on your first device and enable it.
3. Open **Settings → Self-Hosted Vault Sync** and set:
   - **Server URL** — e.g. `https://sync.example.com`
   - **Auth token** — paste the bootstrap token here (only needed once, for
     this first device)
   - **Sync interval** — how often to poll for remote changes (seconds)
   - **Exclude patterns** — one glob per line for files to keep local-only
4. Click **Review connection**, check the server and current vault, then confirm. The wizard checks connectivity and starts initial sync. Use **Pause sync**, **Sync now / retry**, or **Disconnect and clear token** from settings as needed.
5. To add another device (e.g. your phone): on this configured device,
   scroll to **Devices → Pair new device**, give it a label, click
   **Generate**. Scan the QR code with the new device's camera — it opens
   Obsidian and opens the destination/vault confirmation screen. (A
   "Copy link" fallback is shown next to the QR if scanning isn't
   convenient.)
6. Manage paired devices any time from the **Devices** list — each entry
   shows when it was last seen and has its own **Revoke** button.

## How conflicts are handled

Every upload carries a base hash of the file it was derived from. If the
server's current version no longer matches that base hash, the incoming
write is saved alongside the original as `<file>.conflict.<timestamp>.<ext>`
instead of overwriting it. The plugin does not merge the two copies.

Open **全仓冲突** from the ribbon, command palette or settings for line-by-line comparison and per-file or vault-wide resolution. The losing version stays in the server's note history. **版本历史** opens vault snapshots; the file menu opens history for a single note. See the [sync and restore behavior](../README.md#conflict-resolution-and-vault-history) for clock handling, snapshot scope and recovery.

## Requirements

- Obsidian 1.11.4 or newer (required for credential storage)
- A running instance of this fork's updated sync server
- `isDesktopOnly: false` — works on desktop and mobile, though real-time
  push (SSE) is desktop-only; mobile relies on polling plus a sync-on-focus
  trigger

## License

MIT — see [LICENSE](LICENSE).
