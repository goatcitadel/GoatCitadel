import { afterEach, describe, expect, it, vi } from "vitest";
import { McpStdioSessionPool } from "./mcp-stdio-session-pool.js";

const pools: McpStdioSessionPool<ReturnType<typeof createClient>>[] = [];
function createClient() {
  let closed = false;
  return {
    close: vi.fn(() => {
      closed = true;
    }),
    isClosed: () => closed,
    values: [] as string[],
  };
}
function createPool(idleMs?: number, maxSessions?: number) {
  const pool = new McpStdioSessionPool<ReturnType<typeof createClient>>(idleMs, maxSessions);
  pools.push(pool);
  return pool;
}
afterEach(() => {
  pools.splice(0).forEach((pool) => pool.close());
  vi.useRealTimers();
});

describe("MCP stdio session ownership", () => {
  it("settles only the exact child owner, leaving sibling, parent and unowned sessions connected", async () => {
    const pool = createPool();
    const owners = [
      { sessionId: "child", turnId: "turn" },
      { sessionId: "child", turnId: "other-turn" },
      { sessionId: "parent", turnId: "turn" },
      undefined,
    ];
    const clients = owners.map(() => createClient());
    for (const [index, owner] of owners.entries()) {
      await pool.use(
        "server",
        `scope-${index}`,
        "binding",
        async () => clients[index]!,
        async () => undefined,
        undefined,
        owner,
      );
    }
    const closeOwned = pool.captureOwnerCloser({ sessionId: "child", turnId: "turn" });
    expect(closeOwned()).toBe(1);
    await Promise.resolve();
    expect(clients[0]!.close).toHaveBeenCalledOnce();
    clients.slice(1).forEach((client) => expect(client.close).not.toHaveBeenCalled());
    expect(closeOwned()).toBe(0);
  });

  it("copies ownership and refuses to reuse a process across different child owners", async () => {
    const pool = createPool();
    const owner = { sessionId: "child", turnId: "first" };
    const first = createClient(),
      replacement = createClient();
    await pool.use(
      "server",
      "scope",
      "binding",
      async () => first,
      async () => undefined,
      undefined,
      owner,
    );
    owner.turnId = "second";
    const closeFirst = pool.captureOwnerCloser({ sessionId: "child", turnId: "first" });
    await pool.use(
      "server",
      "scope",
      "binding",
      async () => replacement,
      async () => undefined,
      undefined,
      owner,
    );
    expect(first.close).toHaveBeenCalledOnce();
    expect(closeFirst()).toBe(0);
    expect(replacement.close).not.toHaveBeenCalled();
    expect(pool.captureOwnerCloser(owner)()).toBe(1);
  });

  it("a delayed child closer does not close a replacement for the same owner", async () => {
    const pool = createPool();
    const owner = { sessionId: "child", turnId: "turn" };
    const first = createClient(),
      replacement = createClient();
    await pool.use(
      "server",
      "scope",
      "old-binding",
      async () => first,
      async () => undefined,
      undefined,
      owner,
    );
    const closeCaptured = pool.captureOwnerCloser(owner);
    await pool.use(
      "server",
      "scope",
      "new-binding",
      async () => replacement,
      async () => undefined,
      undefined,
      owner,
    );
    expect(closeCaptured()).toBe(0);
    expect(first.close).toHaveBeenCalledOnce();
    expect(replacement.close).not.toHaveBeenCalled();
  });

  it("closes a captured client that finishes creation after settlement and rejects queued work", async () => {
    const pool = createPool();
    const owner = { sessionId: "child", turnId: "turn" };
    const client = createClient();
    let release!: (value: typeof client) => void;
    let creationSignal!: AbortSignal;
    const create = vi.fn((signal: AbortSignal) => {
      creationSignal = signal;
      return new Promise<typeof client>((resolve) => {
        release = resolve;
      });
    });
    const run = vi.fn(async () => undefined);
    const first = pool.use("server", "scope", "binding", create, run, undefined, owner);
    const firstRejected = expect(first).rejects.toThrow("no longer connected");
    const queued = pool.use("server", "scope", "binding", create, run, undefined, owner);
    const queuedRejected = expect(queued).rejects.toThrow("disconnected before dispatch");
    await vi.waitFor(() => expect(create).toHaveBeenCalledOnce());
    expect(pool.captureOwnerCloser(owner)()).toBe(1);
    expect(creationSignal.aborted).toBe(true);
    release(client);
    await Promise.all([firstRejected, queuedRejected]);
    expect(client.close).toHaveBeenCalledOnce();
    expect(run).not.toHaveBeenCalled();
  });

  it("rejects later acquisition from a cancelled child before creating a client", async () => {
    const pool = createPool();
    const controller = new AbortController();
    controller.abort(new Error("child settled"));
    const create = vi.fn(async () => createClient());
    await expect(
      pool.use("server", "scope", "binding", create, async () => undefined, controller.signal, {
        sessionId: "child",
        turnId: "turn",
      }),
    ).rejects.toThrow("child settled");
    expect(create).not.toHaveBeenCalled();
  });

  it("isolates a client close failure from other captured child sessions", async () => {
    const pool = createPool();
    const owner = { sessionId: "child", turnId: "turn" };
    const failing = createClient(),
      healthy = createClient();
    failing.close.mockImplementation(() => {
      throw new Error("native close unavailable");
    });
    await pool.use(
      "server",
      "first",
      "binding",
      async () => failing,
      async () => undefined,
      undefined,
      owner,
    );
    await pool.use(
      "server",
      "second",
      "binding",
      async () => healthy,
      async () => undefined,
      undefined,
      owner,
    );
    expect(pool.captureOwnerCloser(owner)()).toBe(2);
    await Promise.resolve();
    expect(failing.close).toHaveBeenCalledOnce();
    expect(healthy.close).toHaveBeenCalledOnce();
  });

  it("a delayed configuration cleanup closes only the captured sessions", async () => {
    const pool = createPool();
    const first = createClient(),
      replacement = createClient(),
      another = createClient();
    await pool.use(
      "server",
      "session",
      "old-binding",
      async () => first,
      async () => undefined,
    );
    const closeOwned = pool.captureServerCloser("server");
    await pool.use(
      "server",
      "session",
      "new-binding",
      async () => replacement,
      async () => undefined,
    );
    await pool.use(
      "server",
      "new-session",
      "new-binding",
      async () => another,
      async () => undefined,
    );
    closeOwned();
    expect(first.close).toHaveBeenCalledOnce();
    expect(replacement.close).not.toHaveBeenCalled();
    expect(another.close).not.toHaveBeenCalled();
  });
  it("reuses a process only for the same scope and spawn binding", async () => {
    const pool = createPool();
    const create = vi.fn(async () => createClient());
    const read = (client: Awaited<ReturnType<typeof create>>) => Promise.resolve(client);
    const first = await pool.use("server", "workspace:session:actor", "binding", create, read);
    expect(await pool.use("server", "workspace:session:actor", "binding", create, read)).toBe(first);
    const other = await pool.use("server", "different-actor", "binding", create, read);
    expect(other).not.toBe(first);
    const changed = await pool.use("server", "workspace:session:actor", "new-command", create, read);
    expect(changed).not.toBe(first);
    expect(first.close).toHaveBeenCalledOnce();
    expect(other.close).not.toHaveBeenCalled();
  });

  it("serializes calls in one browser session and rejects queued work after disconnect", async () => {
    const pool = createPool();
    const client = createClient();
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const firstRun = vi.fn(async () => barrier);
    const first = pool.use("server", "session", "binding", async () => client, firstRun);
    const secondRun = vi.fn(async () => undefined);
    const second = pool.use("server", "session", "binding", async () => client, secondRun);
    const rejected = expect(second).rejects.toThrow("disconnected before dispatch");
    await vi.waitFor(() => expect(firstRun).toHaveBeenCalledOnce());
    pool.closeServer("server");
    release();
    await first;
    await rejected;
    expect(secondRun).not.toHaveBeenCalled();
    expect(client.close).toHaveBeenCalledOnce();
  });

  it("expires idle processes and releases the capacity limit", async () => {
    vi.useFakeTimers();
    const pool = createPool(100, 1);
    const client = createClient();
    await pool.use(
      "server",
      "session",
      "binding",
      async () => client,
      async () => undefined,
    );
    await expect(
      pool.use(
        "server",
        "another",
        "binding",
        async () => createClient(),
        async () => undefined,
      ),
    ).rejects.toThrow("session limit");
    await vi.advanceTimersByTimeAsync(100);
    expect(client.close).toHaveBeenCalledOnce();
    await expect(
      pool.use(
        "server",
        "another",
        "binding",
        async () => createClient(),
        async () => "new",
      ),
    ).resolves.toBe("new");
  });

  it("never automatically replays a failed call", async () => {
    const pool = createPool();
    const client = createClient();
    const run = vi.fn(async () => {
      throw new Error("unknown after send");
    });
    await expect(pool.use("server", "session", "binding", async () => client, run)).rejects.toThrow(
      "unknown after send",
    );
    expect(run).toHaveBeenCalledOnce();
    expect(client.close).toHaveBeenCalledOnce();
  });

  it("aborts initializing processes and forbids use after shutdown", async () => {
    const pool = createPool();
    const creating = vi.fn(
      (signal: AbortSignal) =>
        new Promise<ReturnType<typeof createClient>>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new Error("initialization cancelled")), { once: true });
        }),
    );
    const work = pool.use("server", "session", "binding", creating, async () => undefined);
    const rejected = expect(work).rejects.toThrow("initialization cancelled");
    await vi.waitFor(() => expect(creating).toHaveBeenCalledOnce());
    pool.close();
    await rejected;
    await expect(
      pool.use(
        "server",
        "session",
        "binding",
        async () => createClient(),
        async () => undefined,
      ),
    ).rejects.toThrow("owner is closed");
  });
});
