// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import type { CapabilityConnectorItem, CapabilityConnectorsResponse, McpServerRecord } from "@goatcitadel/contracts";
import { ApiRequestError } from "@goatcitadel/mission-control-shared/api/http-internal";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { connectorListQuery } from "../../../data/capability-connectors-query";
import { queryKeys } from "../../../data/query-keys";
import { useConnectorEnabled } from "./use-connector-enabled";

const api = vi.hoisted(() => ({ updateMcpServer: vi.fn(), fetchMcpServer: vi.fn() }));
vi.mock("@goatcitadel/mission-control-shared/api/mcp-operations", () => api);
const listApi = vi.hoisted(() => ({ fetchCapabilityConnectors: vi.fn() }));
vi.mock("@goatcitadel/mission-control-shared/api/capability-connectors", () => listApi);
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

/**
 * Reads the item the way the panel does, live from the cached list. With `reads` it is also the list's reader, like the
 * Connectors tab, so a confirming read really runs.
 */
function Probe({ id, reads }: { id: string; reads: boolean }) {
  const live = useQuery({
    ...connectorListQuery("ws-1"),
    enabled: reads,
    select: (list: CapabilityConnectorsResponse) => list.items.find((entry) => entry.id === id),
  });
  latest = useConnectorEnabled(live.data!);
  return null;
}

async function render(id = LINEAR.id, reads = false) {
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <Probe id={id} reads={reads} />
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
  listApi.fetchCapabilityConnectors.mockReset();
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
    await vi.waitFor(() => expect(latest.pending).toBe(false));
    expect(latest.error).toBeUndefined();
    // The next switch must use the version the save produced.
    expect(cached(LINEAR.id)?.serverRevision).toBe(NEXT_REVISION);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: KEY });
  });

  describe("switching on", () => {
    beforeEach(() => {
      client.setQueryData(KEY, response([OFF_LINEAR, NOTION]));
      api.fetchMcpServer.mockResolvedValue(savedServer());
      // The list's reader: the first read answers at once, the confirming read is held until the test lets it go.
      listApi.fetchCapabilityConnectors.mockResolvedValueOnce(response([OFF_LINEAR, NOTION]));
    });

    async function ready() {
      await render(LINEAR.id, true);
      await vi.waitFor(() => expect(listApi.fetchCapabilityConnectors).toHaveBeenCalledTimes(1));
      await vi.waitFor(() => expect(latest.pending).toBe(false));
      expect(latest.unavailableReason).toBeUndefined();
    }

    it("moves only the switch, and leaves the rows alone until the confirming read lands", async () => {
      const confirming = deferred<CapabilityConnectorsResponse>();
      listApi.fetchCapabilityConnectors.mockReturnValueOnce(confirming.promise);
      api.updateMcpServer.mockResolvedValue(savedServer({ revision: NEXT_REVISION, enabled: true }));
      await ready();

      await act(async () => latest.setEnabled(true));
      expect(api.updateMcpServer).toHaveBeenCalledExactlyOnceWith("linear", {
        expectedRevision: REVISION,
        enabled: true,
      });
      // The switch shows the choice at once; no row or badge claims the server is connected yet.
      expect(latest.enabled).toBe(true);
      await vi.waitFor(() => expect(listApi.fetchCapabilityConnectors).toHaveBeenCalledTimes(2));
      expect(cached(LINEAR.id)).toMatchObject({ state: "turned_off", reason: "turned_off", group: "turned_off" });
      // The saved version is kept so a second switch does not collide with this save.
      expect(cached(LINEAR.id)?.serverRevision).toBe(NEXT_REVISION);
      // Still waiting on the Gateway's answer.
      expect(latest.pending).toBe(true);
      expect(latest.enabled).toBe(true);

      const connected = { ...OFF_LINEAR, state: "connected", reason: "ready", group: "connected" } as const;
      await act(async () => confirming.resolve(response([connected, NOTION])));
      await vi.waitFor(() => expect(latest.pending).toBe(false));
      expect(cached(LINEAR.id)).toMatchObject({ state: "connected", reason: "ready", group: "connected" });
      expect(latest.enabled).toBe(true);
    }, 10_000);

    it("shows what the Gateway says when the confirming read disagrees", async () => {
      listApi.fetchCapabilityConnectors.mockResolvedValueOnce(
        response([{ ...OFF_LINEAR, state: "needs_sign_in", reason: "sign_in_needed", group: "connected" }, NOTION]),
      );
      api.updateMcpServer.mockResolvedValue(savedServer({ revision: NEXT_REVISION, enabled: true }));
      await ready();
      await act(async () => latest.setEnabled(true));
      await vi.waitFor(() => expect(latest.pending).toBe(false));
      expect(cached(LINEAR.id)?.state).toBe("needs_sign_in");
      expect(latest.enabled).toBe(true);
    });

    it("puts the switch back when the save fails, with nothing in the list to undo", async () => {
      api.updateMcpServer.mockRejectedValue(new Error("The server said no"));
      await ready();
      await act(async () => latest.setEnabled(true));
      await vi.waitFor(() => expect(latest.error).toBe("The server said no"));
      expect(latest.enabled).toBe(false);
      expect(cached(LINEAR.id)).toEqual(OFF_LINEAR);
      // No confirming read for a save that did not happen.
      expect(listApi.fetchCapabilityConnectors).toHaveBeenCalledTimes(1);
    });

    it("keeps the server check usable after a save, so the server can be switched off and on again", async () => {
      api.updateMcpServer.mockResolvedValue(savedServer({ revision: NEXT_REVISION, enabled: true }));
      listApi.fetchCapabilityConnectors.mockResolvedValueOnce(
        response([{ ...OFF_LINEAR, state: "connected", reason: "ready", group: "connected" }, NOTION]),
      );
      await ready();
      await act(async () => latest.setEnabled(true));
      await vi.waitFor(() => expect(latest.pending).toBe(false));
      expect(cached(LINEAR.id)?.state).toBe("connected");
      // Off again later: the server check starts from a healthy query, not from an error left by the first save.
      act(() => {
        client.setQueryData(KEY, response([OFF_LINEAR, NOTION]));
      });
      await vi.waitFor(() => expect(latest.enabled).toBe(false));
      await vi.waitFor(() => expect(latest.pending).toBe(false));
      expect(latest.unavailableReason).toBeUndefined();
      expect(client.getQueryState(queryKeys.capabilityConnectorServer("linear"))?.status).not.toBe("error");
    });
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

    it("says so when the check itself fails, and offers to check again", async () => {
      api.fetchMcpServer.mockRejectedValueOnce(new Error("offline"));
      await render();
      await vi.waitFor(() => expect(latest.unavailableReason).toBe("Couldn't check whether it can be switched on."));
      expect(latest.checkRetry?.running).toBe(false);
      await act(async () => latest.setEnabled(true));
      expect(api.updateMcpServer).not.toHaveBeenCalled();

      const again = deferred<McpServerRecord>();
      api.fetchMcpServer.mockReturnValueOnce(again.promise);
      await act(async () => latest.checkRetry?.run());
      // The failure stays on screen, with the retry busy, until the check answers.
      await vi.waitFor(() => expect(latest.checkRetry?.running).toBe(true));
      expect(latest.unavailableReason).toBe("Couldn't check whether it can be switched on.");
      expect(latest.pending).toBe(false);

      await act(async () => again.resolve(savedServer()));
      await vi.waitFor(() => expect(latest.unavailableReason).toBeUndefined());
      expect(latest.checkRetry).toBeUndefined();
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
