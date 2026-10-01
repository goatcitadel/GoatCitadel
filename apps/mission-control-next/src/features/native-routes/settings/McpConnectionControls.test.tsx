import { StrictMode } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { McpServerRecord } from "@goatcitadel/contracts";
import { ApiRequestError } from "@goatcitadel/mission-control-shared/api/http-internal";
import { McpConnectionControls } from "./McpConnectionControls";
import { commitMcpConnection } from "./mcp-connection-mutation";
import { commitMcpServerUpdate, __resetMcpServerMutationsForTests } from "./mcp-server-mutation";

const api = vi.hoisted(() => ({
  fetchMcpServer: vi.fn(),
  connectReviewedMcpServer: vi.fn(),
  disconnectReviewedMcpServer: vi.fn(),
  updateMcpServer: vi.fn(),
}));
vi.mock("@goatcitadel/mission-control-shared/api/client", async (original) => ({
  ...(await original<object>()),
  ...api,
}));
const server: McpServerRecord = {
  serverId: "fixture",
  revision: "a".repeat(64),
  connectionRevision: "b".repeat(64),
  configurationBindingId: "original-binding",
  label: "Reviewed fixture",
  transport: "stdio",
  command: "node",
  args: ["path with spaces", "--readonly"],
  authType: "none",
  enabled: true,
  status: "disconnected",
  category: "development",
  trustTier: "restricted",
  costTier: "free",
  policy: {
    requireFirstToolApproval: true,
    redactionMode: "strict",
    allowedToolPatterns: [],
    blockedToolPatterns: [],
    allowedEnvKeys: ["LANG"],
  },
  createdAt: "2026-09-30T00:00:00Z",
  updatedAt: "2026-09-30T00:00:00Z",
};
const saved = (action: "connect" | "disconnect" = "connect"): McpServerRecord => ({
  ...structuredClone(server),
  status: action === "connect" ? "connected" : "disconnected",
  revision: action === "connect" ? "c".repeat(64) : server.revision,
  configurationBindingId: action === "connect" ? "enrolled-binding" : server.configurationBindingId,
  connectionRevision: "d".repeat(64),
  updatedAt: "2026-09-30T00:00:01Z",
});
const receipt = (action: "connect" | "disconnect" = "connect") => ({
  version: 1,
  action,
  reviewed: { expectedRevision: server.revision, expectedConnectionRevision: server.connectionRevision },
  server: saved(action),
});
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
let root: ReactTestRenderer | undefined;
const reload = vi.fn(async () => undefined);
async function render(scope = "workspace", record = server) {
  await act(async () => {
    const element = (
      <StrictMode>
        <McpConnectionControls
          server={record}
          scope={scope}
          onSettled={reload}
          button={(label, click, disabled) => (
            <button type="button" disabled={disabled} onClick={click}>
              {label}
            </button>
          )}
        />
      </StrictMode>
    );
    if (root) root.update(element);
    else root = create(element);
  });
}
const button = (label: string) => root!.root.findAllByType("button").find((item) => item.props.children === label)!;
const click = (label: string) => act(async () => button(label).props.onClick());
const content = () => JSON.stringify(root!.toJSON());
beforeEach(() => {
  vi.resetAllMocks();
  __resetMcpServerMutationsForTests();
  api.fetchMcpServer.mockResolvedValue(structuredClone(server));
  api.connectReviewedMcpServer.mockImplementation(async () => {
    api.fetchMcpServer.mockResolvedValue(saved());
    return receipt();
  });
  api.disconnectReviewedMcpServer.mockImplementation(async () => {
    api.fetchMcpServer.mockResolvedValue(saved("disconnect"));
    return receipt("disconnect");
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw new Error("No network in connection tests");
    }),
  );
});
afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  expect(globalThis.fetch).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
});

it.each(["connect", "disconnect"] as const)(
  "requires explicit exact %s review and cancellation has zero writes",
  async (action) => {
    await render();
    expect(api.fetchMcpServer).not.toHaveBeenCalled();
    const label = action === "connect" ? "Review connection" : "Review disconnect";
    await click(label);
    expect(content()).toContain("path with spaces");
    await click("Cancel connection review");
    expect(api.connectReviewedMcpServer).not.toHaveBeenCalled();
    expect(api.disconnectReviewedMcpServer).not.toHaveBeenCalled();
    await click(label);
    await click(action === "connect" ? "Connect reviewed server" : "Disconnect reviewed server");
    expect(
      action === "connect" ? api.connectReviewedMcpServer : api.disconnectReviewedMcpServer,
    ).toHaveBeenCalledExactlyOnceWith("fixture", {
      expectedRevision: server.revision,
      expectedConnectionRevision: server.connectionRevision,
    });
    expect(reload).toHaveBeenCalledOnce();
    expect(content()).toContain(action === "connect" ? "Tool calls remain governed" : "disconnect state confirmed");
  },
);

it.each(["revision", "connectionRevision", "command"] as const)("rejects changed %s before dispatch", async (field) => {
  await render();
  await click("Review connection");
  api.fetchMcpServer.mockResolvedValue({ ...server, [field]: field === "command" ? "other-command" : "e".repeat(64) });
  await click("Connect reviewed server");
  expect(api.connectReviewedMcpServer).not.toHaveBeenCalled();
  expect(content()).toContain("connection changed");
});

it.each(["away-back", "unmount", "cancel"])("cancels %s during final preflight without dispatch", async (timing) => {
  await render();
  await click("Review connection");
  const pending = deferred<McpServerRecord>();
  api.fetchMcpServer.mockReturnValueOnce(pending.promise);
  await click("Connect reviewed server");
  if (timing === "away-back") {
    await render("other");
    await render();
  }
  if (timing === "unmount") {
    await act(async () => root!.unmount());
    root = undefined;
  }
  if (timing === "cancel") await click("Cancel connection review");
  await act(async () => pending.resolve(server));
  expect(api.connectReviewedMcpServer).not.toHaveBeenCalled();
  expect(reload).not.toHaveBeenCalled();
});

it("retains a lost admitted outcome across workspace changes, remount and configuration editors", async () => {
  await render();
  await click("Review connection");
  api.connectReviewedMcpServer.mockRejectedValueOnce(new Error("transport lost"));
  await click("Connect reviewed server");
  await act(async () => root!.unmount());
  root = undefined;
  await render("other-workspace");
  expect(button("Review connection").props.disabled).toBe(true);
  expect(button("Review disconnect").props.disabled).toBe(true);
  expect(content()).toContain("outcome is unconfirmed");
  const result = await commitMcpServerUpdate({
    reviewed: server,
    input: { expectedRevision: server.revision!, label: "changed" },
    isCurrent: () => true,
  });
  expect(result.status).toBe("locked");
  expect(api.updateMcpServer).not.toHaveBeenCalled();
});

it("admits only one duplicate dispatch and confirms a late receipt without stale-view callbacks", async () => {
  await render();
  await click("Review connection");
  const pending = deferred<ReturnType<typeof receipt>>();
  api.connectReviewedMcpServer.mockReturnValueOnce(pending.promise);
  await act(async () => {
    button("Connect reviewed server").props.onClick();
    button("Connect reviewed server").props.onClick();
  });
  expect(api.connectReviewedMcpServer).toHaveBeenCalledOnce();
  await render("other-workspace");
  api.fetchMcpServer.mockResolvedValue(saved());
  await act(async () => pending.resolve(receipt()));
  expect(reload).not.toHaveBeenCalled();
  expect(content()).toContain("discovery completed");
});

it.each(["action", "review", "configuration", "generation", "readback"])(
  "locks unverified %s acknowledgements",
  async (mismatch) => {
    const value = receipt();
    if (mismatch === "action") value.action = "disconnect";
    if (mismatch === "review") value.reviewed.expectedConnectionRevision = "e".repeat(64);
    if (mismatch === "configuration") value.server.args = ["unreviewed"];
    if (mismatch === "generation") value.server.connectionRevision = server.connectionRevision;
    api.connectReviewedMcpServer.mockImplementation(async () => {
      api.fetchMcpServer.mockResolvedValue(
        mismatch === "readback" ? { ...saved(), connectionRevision: "e".repeat(64) } : value.server,
      );
      return value;
    });
    expect((await commitMcpConnection({ reviewed: server, action: "connect", isCurrent: () => true })).status).toBe(
      "uncertain",
    );
  },
);

it.each([false, true])("unlocks an exact stale rejection only before admission (%s)", async (committed) => {
  api.connectReviewedMcpServer.mockRejectedValue(
    new ApiRequestError("conflict", {
      kind: "http",
      method: "POST",
      path: "/api/v1/mcp/servers/fixture/connect-reviewed",
      status: 409,
      body: {
        code: "WRITE_CONFLICT",
        details: { reason: "MCP_CONNECTION_REVIEW_REQUIRED" },
        ...(committed ? { mutationCommitted: true } : {}),
      },
    }),
  );
  expect((await commitMcpConnection({ reviewed: server, action: "connect", isCurrent: () => true })).status).toBe(
    committed ? "uncertain" : "conflict",
  );
});

it("withholds requester-scoped and disabled connection controls", async () => {
  await render("workspace", { ...server, connectionMode: "requester_scoped" });
  expect(button("Review connection").props.disabled).toBe(true);
  expect(button("Review disconnect").props.disabled).toBe(true);
  await render("workspace", { ...server, enabled: false });
  expect(button("Review connection").props.disabled).toBe(true);
  expect(api.fetchMcpServer).not.toHaveBeenCalled();
});
