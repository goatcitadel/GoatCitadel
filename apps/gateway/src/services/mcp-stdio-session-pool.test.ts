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
