/** App-private process ownership. Keys are supplied only by the canonical gateway scope owner. */
export interface RetainedMcpClient {
  close(): void;
  isClosed(): boolean;
}

interface Session<C extends RetainedMcpClient> {
  serverId: string;
  binding: string;
  client: Promise<C>;
  queue: Promise<void>;
  users: number;
  invalidated: boolean;
  abort: AbortController;
  idleTimer?: ReturnType<typeof setTimeout>;
}

export class McpStdioSessionPool<C extends RetainedMcpClient> {
  private readonly sessions = new Map<string, Session<C>>();
  private closed = false;

  public constructor(
    private readonly idleMs = 15 * 60_000,
    private readonly maxSessions = 16,
  ) {}

  public async use<T>(
    serverId: string,
    scopeKey: string,
    binding: string,
    create: (signal: AbortSignal) => Promise<C>,
    run: (client: C) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    if (this.closed) throw new Error("MCP session owner is closed.");
    signal?.throwIfAborted();
    const key = JSON.stringify([serverId, scopeKey]);
    let session = this.sessions.get(key);
    if (session && session.binding !== binding) {
      this.invalidate(key, session);
      session = undefined;
    }
    if (!session) {
      if (this.sessions.size >= this.maxSessions) {
        throw new Error("MCP session limit reached. Disconnect an idle server before opening another session.");
      }
      const abort = new AbortController();
      const creationSignal = signal ? AbortSignal.any([signal, abort.signal]) : abort.signal;
      session = {
        serverId,
        binding,
        client: Promise.resolve().then(() => create(creationSignal)),
        queue: Promise.resolve(),
        users: 0,
        invalidated: false,
        abort,
      };
      this.sessions.set(key, session);
      // Observe creation failure even if the caller cancels while waiting.
      void session.client.catch(() => undefined);
    }
    clearTimeout(session.idleTimer);
    session.users += 1;
    const owned = session;
    const work = session.queue.then(async () => {
      signal?.throwIfAborted();
      if (owned.invalidated || this.closed) throw new Error("MCP session was disconnected before dispatch.");
      const client = await owned.client;
      signal?.throwIfAborted();
      if (owned.invalidated || this.closed || client.isClosed()) {
        throw new Error("MCP session is no longer connected. Request a new invocation.");
      }
      return run(client);
    });
    session.queue = work.then(
      () => undefined,
      () => undefined,
    );
    try {
      return await work;
    } catch (error) {
      this.invalidate(key, owned);
      throw error;
    } finally {
      owned.users -= 1;
      if (owned.users === 0 && !owned.invalidated) {
        owned.idleTimer = setTimeout(() => this.invalidate(key, owned), this.idleMs);
        owned.idleTimer.unref();
      }
    }
  }

  public closeServer(serverId: string): void {
    for (const [key, session] of this.sessions) {
      if (session.serverId === serverId) this.invalidate(key, session);
    }
  }

  public closeSession(serverId: string, scopeKey: string): void {
    const key = JSON.stringify([serverId, scopeKey]);
    const session = this.sessions.get(key);
    if (session) this.invalidate(key, session);
  }

  public close(): void {
    this.closed = true;
    for (const [key, session] of this.sessions) this.invalidate(key, session);
  }

  private invalidate(key: string, session: Session<C>): void {
    if (session.invalidated) return;
    session.invalidated = true;
    session.abort.abort();
    clearTimeout(session.idleTimer);
    if (this.sessions.get(key) === session) this.sessions.delete(key);
    void session.client.then(
      (client) => client.close(),
      () => undefined,
    );
  }
}
