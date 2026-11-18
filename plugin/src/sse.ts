interface SSEEventPayload {
  path: string;
  action: string;
}

export class SSEClient {
  private source: EventSource | null = null;
  private retryTimer?: number;
  private retryDelay = 1000;
  private stopped = false;

  constructor(
    private url: string,
    private token: string,
    private onEvent: (path: string, action: string) => void,
    private onError: () => void,
  ) {}

  connect(): void {
    this.stopped = false;
    if (this.source || this.retryTimer !== undefined) return;
    // EventSource doesn't support custom headers — pass token as query param
    const sseUrl = `${this.url}/events?token=${encodeURIComponent(this.token)}`;
    this.source = new EventSource(sseUrl);
    this.source.onopen = () => { this.retryDelay = 1000; };
    this.source.onmessage = (e: MessageEvent) => {
      try {
        // MessageEvent.data is typed `any` (shared with WebSocket, which can
        // carry Blob/ArrayBuffer); EventSource's is always a string per spec.
        const data = JSON.parse(e.data as string) as SSEEventPayload;
        this.onEvent(data.path, data.action);
      } catch { /* ignore malformed events */ }
    };
    this.source.onerror = () => {
      this.source?.close();
      this.source = null;
      this.onError();
      if (!this.stopped) {
        this.retryTimer = window.setTimeout(() => { this.retryTimer = undefined; this.connect(); }, this.retryDelay);
        this.retryDelay = Math.min(this.retryDelay * 2, 30000);
      }
    };
  }

  disconnect(): void {
    this.stopped = true;
    if (this.retryTimer !== undefined) window.clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    this.source?.close();
    this.source = null;
  }

  get connected(): boolean {
    return this.source?.readyState === EventSource.OPEN;
  }
}
