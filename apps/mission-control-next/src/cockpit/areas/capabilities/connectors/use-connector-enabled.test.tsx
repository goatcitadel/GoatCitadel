// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider, skipToken, useQuery } from "@tanstack/react-query";
import type { CapabilityConnectorItem, CapabilityConnectorsResponse, McpServerRecord } from "@goatcitadel/contracts";
import { ApiRequestError } from "@goatcitadel/mission-control-shared/api/http-internal";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { queryKeys } from "../../../data/query-keys";
import { useConnectorEnabled } from "./use-connector-enabled";

const api = vi.hoisted(() => ({ updateMcpServer: vi.fn(), fetchMcpServer: vi.fn() }));
vi.mock("@goatcitadel/mission-control-shared/api/mcp-operations", () => api);
vi.mock("@goatcitadel/mission-control-shared/state/ui-preferences", () => ({
  useUiPreferences: () => ({ activeWorkspaceId: "ws-1" }),
}));

const REVISION = "a".repeat(64);
const NEXT_REVISION = "b".repeat(64);

function item(overrides: Partial<CapabilityConnectorItem>): CapabilityConnectorItem {
  return {
    id: "mcp-server:linear",
    name: "Linear",
    description: "Issues and projects",
    kind: "mcp",
    source: "mcp_server",
    category: "development",
    state: "connected",
    reason: "ready",
    group: "connected",
    auth: "oauth",
    runsOnThisDevice: false,
    networkHosts: [],
    serverId: "linear",
    serverRevision: REVISION,
    chat: { available: true },
    hiddenInWorkspace: false,
    ...overrides,
  };
}

const LINEAR = item({});
const NOTION = item({ id: "mcp-server:notion", name: "Notion", serverId: "notion" });
const OFF_LINEAR = item({ state: "turned_off", reason: "turned_off", group: "turned_off" });

function savedServer(overrides: Partial<McpServerRecord> = {}): McpServerRecord {
  return {
    serverId: "linear",
    revision: REVISION,
    label: "Linear",
    transport: "stdio",
    authType: "none",
    enabled: false,
    status: "disconnected",
    category: "development",
    trustTier: "verified",
    costTier: "free",
    policy: {},
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    ...overrides,
  } as unknown as McpServerRecord;
}

function response(items: CapabilityConnectorItem[]): CapabilityConnectorsResponse {
  return { workspaceId: "ws-1", items, issues: [], generatedAt: "2026-10-25T10:00:00.000Z" };
}

const KEY = queryKeys.capabilityConnectors("ws-1");
let container: HTMLDivElement;
let root: Root;
let client: QueryClient;
let latest: ReturnType<typeof useConnectorEnabled>;

/** Reads the item the way the panel does, live from the cached list, so the hook sees the optimistic change. */
function Probe({ id }: { id: string }) {
  const live = useQuery({
    queryKey: KEY,
    queryFn: skipToken,
    select: (list: CapabilityConnectorsResponse) => list.items.find((entry) => entry.id === id),
  });
  latest = useConnectorEnabled(live.data!);
  return null;
}

async function render(id = LINEAR.id) {
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <Probe id={id} />
      </QueryClientProvider>,
    ),
  );
}

const cached = (id: string) => client.getQueryData<CapabilityConnectorsResponse>(KEY)?.items.find((e) => e.id === id);

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((ok, fail) => {
    resolve = ok;
    reject = fail;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  api.updateMcpServer.mockReset();
  api.fetchMcpServer.mockReset();
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(KEY, response([LINEAR, NOTION]));
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  client.clear();
});

describe("useConnectorEnabled", () => {
  it("reads on or off from the connector's state", async () => {
    await render();
    expect(latest.enabled).toBe(true);
    client.setQueryData(KEY, response([OFF_LINEAR, NOTION]));
    api.fetchMcpServer.mockResolvedValue(savedServer());
    await render();
    await vi.waitFor(() => expect(latest.enabled).toBe(false));
  });

  it("turns a server off right away, saves it with the server's version, and reads the list again", async () => {
    const saving = deferred<McpServerRecord>();
    api.updateMcpServer.mockReturnValue(saving.promise);
    const invalidate = vi.spyOn(client, "invalidateQueries");
    await render();
    await act(async () => latest.setEnabled(false));
    // Before the Gateway answers, the cached row already reads turned off.
    expect(latest.enabled).toBe(false);
    expect(latest.pending).toBe(true);
    expect(cached(LINEAR.id)).toMatchObject({ state: "turned_off", reason: "turned_off", group: "turned_off" });
    expect(api.updateMcpServer).toHaveBeenCalledExactlyOnceWith("linear", {
      expectedRevision: REVISION,
      enabled: false,
    });

    await act(async () => saving.resolve(savedServer({ revision: NEXT_REVISION, enabled: false })));
    expect(latest.pending).toBe(false);
    expect(latest.error).toBeUndefined();
    // The next switch must use the version the save produced.
    expect(cached(LINEAR.id)?.serverRevision).toBe(NEXT_REVISION);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: KEY });
  });

  it("shows a switched-on server as connected until the list is read again", async () => {
    api.fetchMcpServer.mockResolvedValue(savedServer());
    api.updateMcpServer.mockResolvedValue(savedServer({ revision: NEXT_REVISION, enabled: true }));
    client.setQueryData(KEY, response([OFF_LINEAR, NOTION]));
    await render();
    await vi.waitFor(() => expect(latest.unavailableReason).toBeUndefined());
    await vi.waitFor(() => expect(latest.pending).toBe(false));
    await act(async () => latest.setEnabled(true));
    expect(api.updateMcpServer).toHaveBeenCalledExactlyOnceWith("linear", {
      expectedRevision: REVISION,
      enabled: true,
    });
    expect(cached(LINEAR.id)).toMatchObject({ state: "connected", reason: "ready", group: "connected" });
  });

  it("rolls back only the failed row and says why", async () => {
    const saving = deferred<McpServerRecord>();
    api.updateMcpServer.mockReturnValue(saving.promise);
    await render();
    await act(async () => latest.setEnabled(false));
    // A newer list lands for another row while the save is out.
    const newerNotion = { ...NOTION, state: "broken" as const, reason: "error" as const };
    client.setQueryData(KEY, (list: CapabilityConnectorsResponse) => ({
      ...list,
      items: list.items.map((entry) => (entry.id === NOTION.id ? newerNotion : entry)),
    }));

    await act(async () => saving.reject(new Error("The server said no")));
    expect(latest.enabled).toBe(true);
    expect(latest.pending).toBe(false);
    expect(latest.conflict).toBe(false);
    expect(latest.error).toBe("The server said no");
    expect(cached(LINEAR.id)).toMatchObject({ state: "connected", reason: "ready", group: "connected" });
    expect(cached(NOTION.id)).toEqual(newerNotion);
  });

  it("explains a conflict and reloads on request", async () => {
    api.updateMcpServer.mockRejectedValue(
      new ApiRequestError("conflict", {
        kind: "http",
        method: "PATCH",
        path: "/api/v1/mcp/servers/linear",
        status: 409,
        body: { code: "WRITE_CONFLICT" },
      }),
    );
    const invalidate = vi.spyOn(client, "invalidateQueries");
    await render();
    await act(async () => latest.setEnabled(false));
    expect(latest.conflict).toBe(true);
    expect(latest.error).toBe("Changed elsewhere. Reload to see the latest.");
    expect(latest.enabled).toBe(true);

    await act(async () => latest.reload());
    expect(invalidate).toHaveBeenCalledWith({ queryKey: KEY });
    expect(latest.conflict).toBe(false);
    expect(latest.error).toBeUndefined();
  });

  it("clears an old error when the next save starts", async () => {
    api.updateMcpServer.mockRejectedValueOnce(new Error("The server said no"));
    await render();
    await act(async () => latest.setEnabled(false));
    expect(latest.error).toBe("The server said no");
    api.updateMcpServer.mockResolvedValue(savedServer({ revision: NEXT_REVISION }));
    await act(async () => latest.setEnabled(false));
    expect(latest.error).toBeUndefined();
  });

  it("ignores a second toggle while one is saving", async () => {
    const saving = deferred<McpServerRecord>();
    api.updateMcpServer.mockReturnValue(saving.promise);
    await render();
    await act(async () => {
      latest.setEnabled(false);
      latest.setEnabled(true);
    });
    expect(api.updateMcpServer).toHaveBeenCalledTimes(1);
    await act(async () => saving.resolve(savedServer({ revision: NEXT_REVISION })));
  });

  describe("when the server can't be switched on", () => {
    beforeEach(() => {
      client.setQueryData(KEY, response([OFF_LINEAR, NOTION]));
    });

    it("gives the reason and does not save", async () => {
      // An unreviewed remote server with sign-in that isn't ready can't run yet.
      api.fetchMcpServer.mockResolvedValue(
        savedServer({ transport: "http", url: "https://mcp.example.com", authType: "oauth2" }),
      );
      await render();
      await vi.waitFor(() =>
        expect(latest.unavailableReason).toBe(
          "Transport, trust, or authentication setup is incomplete. Review server setup before enabling.",
        ),
      );
      await act(async () => latest.setEnabled(true));
      expect(api.updateMcpServer).not.toHaveBeenCalled();
      expect(cached(LINEAR.id)?.state).toBe("turned_off");
    });

    it("waits for the check before it lets the switch move", async () => {
      const checking = deferred<McpServerRecord>();
      api.fetchMcpServer.mockReturnValue(checking.promise);
      await render();
      expect(latest.pending).toBe(true);
      await act(async () => latest.setEnabled(true));
      expect(api.updateMcpServer).not.toHaveBeenCalled();
      await act(async () => checking.resolve(savedServer()));
      await vi.waitFor(() => expect(latest.pending).toBe(false));
      expect(latest.unavailableReason).toBeUndefined();
    });

    it("says so when the check itself fails", async () => {
      api.fetchMcpServer.mockRejectedValue(new Error("offline"));
      await render();
      await vi.waitFor(() =>
        expect(latest.unavailableReason).toBe("Couldn't check whether it can be switched on. Try again."),
      );
      await act(async () => latest.setEnabled(true));
      expect(api.updateMcpServer).not.toHaveBeenCalled();
    });
  });

  it("does not check a server that is already on, because it can always be switched off", async () => {
    await render();
    expect(api.fetchMcpServer).not.toHaveBeenCalled();
    expect(latest.unavailableReason).toBeUndefined();
  });

  it("gives a reason when the server has no version to save against", async () => {
    client.setQueryData(KEY, response([item({ serverRevision: undefined }), NOTION]));
    await render();
    expect(latest.unavailableReason).toBe("This server's saved version isn't available, so it can't be switched here.");
    await act(async () => latest.setEnabled(false));
    expect(api.updateMcpServer).not.toHaveBeenCalled();
  });
});
