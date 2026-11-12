// A small ring buffer of sync events, persisted in data.json and shown in the
// settings tab. Exists because mobile Obsidian has no status bar and no console:
// without it a failing sync is invisible. Holds only metadata (time, kind, path,
// error text) — never file contents or the token.

export type LogKind = 'pull' | 'push' | 'delete' | 'error' | 'info';

export interface LogEntry {
  ts: number; // ms since epoch
  kind: LogKind;
  msg: string;
}

export const SYNC_LOG_MAX = 200;

export class SyncLog {
  private items: LogEntry[];

  constructor(
    initial: LogEntry[] = [],
    private persist: (entries: LogEntry[]) => Promise<void> = async () => {},
    private now: () => number = Date.now,
  ) {
    this.items = initial.slice(-SYNC_LOG_MAX);
  }

  add(kind: LogKind, msg: string): void {
    this.items.push({ ts: this.now(), kind, msg });
    if (this.items.length > SYNC_LOG_MAX) this.items.splice(0, this.items.length - SYNC_LOG_MAX);
  }

  entries(): readonly LogEntry[] {
    return this.items;
  }

  /** Writes the buffer out; called once per pull rather than per event. */
  async save(): Promise<void> {
    await this.persist(this.items);
  }

  toText(): string {
    return this.items
      .map(e => `${new Date(e.ts).toISOString()} ${e.kind} ${e.msg}`)
      .join('\n');
  }
}

/** Allows an action at most once per `windowMs` (used to rate-limit mobile error Notices). */
export class Throttle {
  private last = -Infinity;

  constructor(private windowMs: number, private now: () => number = Date.now) {}

  allow(): boolean {
    const t = this.now();
    if (t - this.last < this.windowMs) return false;
    this.last = t;
    return true;
  }
}
