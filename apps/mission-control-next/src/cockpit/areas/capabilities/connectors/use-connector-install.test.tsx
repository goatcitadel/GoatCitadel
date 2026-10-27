// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type {
  CapabilityConnectorItem,
  ChangePlanRecord,
  ChangePlanRequiredAction,
  ConnectorInstallResponse,
  McpReviewedOAuthStartResponse,
  McpServerRecord,
} from "@goatcitadel/contracts";
import { ApiRequestError } from "@goatcitadel/mission-control-shared/api/http-internal";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __resetMcpOAuthFlowsForTests,
  writeMcpOAuthFlow,
} from "../../../../features/native-routes/settings/mcp-oauth-flow-state";
import {
  __resetMcpOAuthReturnForTests,
  consumeMcpOAuthReturnFragment,
} from "../../../../features/native-routes/settings/mcp-oauth-return";
import {
  __resetConnectorInstallForTests,
  useConnectorInstall,
  useConnectorInstallStatus,
  type ConnectorInstallState,
} from "./use-connector-install";

const install = vi.hoisted(() => ({ installCapabilityConnector: vi.fn(), fetchCapabilityConnectors: vi.fn() }));
vi.mock("@goatcitadel/mission-control-shared/api/capability-connectors", () => install);
const plans = vi.hoisted(() => ({ fetchChangePlan: vi.fn(), cancelChangePlan: vi.fn() }));
vi.mock("@goatcitadel/mission-control-shared/api/chat", async (original) => ({
  ...(await original<object>()),
  ...plans,
}));
const servers = vi.hoisted(() => ({ fetchMcpServer: vi.fn() }));
vi.mock("@goatcitadel/mission-control-shared/api/mcp-operations", async (original) => ({
  ...(await original<object>()),
  ...servers,
}));
const wrappers = vi.hoisted(() => ({
  commitMcpOAuth: vi.fn(),
  commitMcpServerUpdate: vi.fn(),
  commitMcpConnection: vi.fn(),
}));
vi.mock("../../../../features/native-routes/settings/mcp-oauth-mutation", () => ({
  commitMcpOAuth: wrappers.commitMcpOAuth,
}));
vi.mock("../../../../features/native-routes/settings/mcp-server-mutation", async (original) => ({
  ...(await original<object>()),
  commitMcpServerUpdate: wrappers.commitMcpServerUpdate,
}));
vi.mock("../../../../features/native-routes/settings/mcp-connection-mutation", async (original) => ({
  ...(await original<object>()),
  commitMcpConnection: wrappers.commitMcpConnection,
}));
vi.mock("@goatcitadel/mission-control-shared/state/ui-preferences", () => ({
  useUiPreferences: () => ({ activeWorkspaceId: "ws-1" }),
}));

const REVISION = "a".repeat(64);
const NONCE = "n".repeat(32);
const SUMMARY = "Allowed mcp.linear.app. Saved Linear, switched off. Let Chat use connectors.";
const AUTHORIZE_URL = "https://auth.linear.app/oauth/authorize?scope=read+write&state=state-1";

const TEMPLATE: CapabilityConnectorItem = {
  id: "mcp-template:linear",
  name: "Linear",
  description: "Issues and projects",
  kind: "mcp",
  source: "mcp_template",
  category: "development",
  state: "available",
  reason: "not_installed",
  group: "available",
  auth: "oauth",
  runsOnThisDevice: false,
  networkHosts: ["mcp.linear.app"],
  templateId: "linear",
  chat: { available: true },
  hiddenInWorkspace: false,
};

/** The saved server's row once the list is read again; it keeps the template's id. */
const SAVED: CapabilityConnectorItem = {
  ...TEMPLATE,
  id: "mcp-server:srv-1",
  source: "mcp_server",
  state: "needs_sign_in",
  reason: "sign_in_needed",
  group: "connected",
  serverId: "srv-1",
  serverRevision: REVISION,
};

function server(overrides: Partial<McpServerRecord> = {}): McpServerRecord {
  return {
    serverId: "srv-1",
    revision: REVISION,
    connectionRevision: "c".repeat(64),
    label: "Linear",
    transport: "http",
    url: "https://mcp.linear.app/mcp",
    authType: "oauth2",
    enabled: false,
    status: "disconnected",
    category: "development",
    trustTier: "verified",
    costTier: "free",
    policy: {},
    createdAt: "2026-10-27T00:00:00.000Z",
    updatedAt: "2026-10-27T00:00:00.000Z",
    ...overrides,
  } as unknown as McpServerRecord;
}

const APPROVAL: ChangePlanRequiredAction = {
  kind: "approval",
  actionId: "action-1",
  actionNonce: NONCE,
  title: "Install Linear",
  risk: "danger",
  approvalId: "approval-1",
};

function plan(overrides: Partial<ChangePlanRecord> = {}): ChangePlanRecord {
  return {
    planId: "plan-1",
    kind: "connector_install",
    request: { kind: "connector_install", templateId: "linear", enableChatConnectors: true },
    origin: { workspaceId: "default", surface: "capabilities", actorId: "operator" },
    status: "completed",
    revision: 3,
    summary: "Allow mcp.linear.app. Save Linear, switched off, set to Reading is free.",
    evidenceRefs: ["mcp_template:linear", "mcp_server:srv-1"],
    result: { summary: SUMMARY },
    ...overrides,
  } as unknown as ChangePlanRecord;
}

function receipt(overrides: Partial<ConnectorInstallResponse["changePlanReceipt"]> = {}): ConnectorInstallResponse {
  return {
    templateId: "linear",
    changePlanReceipt: {
      planId: "plan-1",
      status: "completed",
      revision: 3,
      risk: "danger",
      summary: SUMMARY,
      ...overrides,
    },
  };
}

let container: HTMLDivElement;
let root: Root;
let client: QueryClient;
let latest: ReturnType<typeof useConnectorInstall>;
/** The calls that change or read something, in the order the flow made them. */
let calls: string[];

function Probe({ item }: { item: CapabilityConnectorItem }) {
  latest = useConnectorInstall(item);
  return null;
}

async function render(item: CapabilityConnectorItem) {
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <Probe item={item} />
      </QueryClientProvider>,
    ),
  );
}

/** Lets every awaited mock in the chain settle. */
async function flush() {
  await act(async () => {
    for (let round = 0; round < 40; round += 1) await Promise.resolve();
  });
}

/** The provider's redirect reaching Settings in this tab, which hands it on. */
async function returnFromProvider(state: string, code = "code-1") {
  window.history.replaceState(null, "", `/settings/connections#mcp-oauth-return&state=${state}&code=${code}`);
  await act(async () => {
    consumeMcpOAuthReturnFragment();
  });
  await flush();
}

async function startInstall(item = TEMPLATE) {
  await render(item);
  await act(async () => latest.start({ enableChatConnectors: true }));
  await flush();
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  calls = [];
  install.installCapabilityConnector.mockImplementation(async () => {
    calls.push("install");
    return receipt();
  });
  plans.fetchChangePlan.mockImplementation(async () => {
    calls.push("read plan");
    return plan();
  });
  servers.fetchMcpServer.mockImplementation(async () => {
    calls.push("read server");
    return server();
  });
  wrappers.commitMcpOAuth.mockImplementation(
    async ({ reviewed, action }: { reviewed: McpServerRecord; action: "start" | "complete" }) => {
      calls.push(`sign in: ${action}`);
      if (action === "start") {
        const started = server({ revision: "b".repeat(64) });
        writeMcpOAuthFlow(reviewed.serverId, {
          authorizeUrl: AUTHORIZE_URL,
          state: "state-1",
          review: {
            version: 1,
            reviewed: { expectedRevision: REVISION, expectedConnectionRevision: null },
            server: started,
          },
        } as McpReviewedOAuthStartResponse);
        return { status: "saved", server: started };
      }
      return { status: "saved", server: server({ revision: "d".repeat(64) }) };
    },
  );
  wrappers.commitMcpServerUpdate.mockImplementation(async () => {
    calls.push("switch on");
    return { status: "saved", server: server({ enabled: true }) };
  });
  wrappers.commitMcpConnection.mockImplementation(async () => {
    calls.push("connect");
    return { status: "saved", server: server({ enabled: true, status: "connected" }) };
  });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  client.clear();
  __resetConnectorInstallForTests();
  __resetMcpOAuthFlowsForTests();
  __resetMcpOAuthReturnForTests();
  window.history.replaceState(null, "", "/");
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("useConnectorInstall", () => {
  it("runs install, sign-in, switch on and connect in order when the skip is on", async () => {
    await startInstall();

    expect(latest.state).toEqual({
      phase: "signing_in",
      authorizeUrl: AUTHORIZE_URL,
      signInHost: "auth.linear.app",
      scopes: "read, write",
    });
    expect(latest.serverId).toBe("srv-1");
    // The panel moves to the saved server's row as soon as it exists (R74).
    await render(SAVED);
    await returnFromProvider("state-1");

    expect(latest.state).toEqual({ phase: "done", serverId: "srv-1" });
    expect(calls).toEqual([
      "install",
      "read plan",
      "read server",
      "sign in: start",
      "sign in: complete",
      "read server",
      "switch on",
      "read server",
      "connect",
    ]);
    expect(install.installCapabilityConnector).toHaveBeenCalledWith({
      templateId: "linear",
      enableChatConnectors: true,
    });
    expect(plans.fetchChangePlan).toHaveBeenCalledWith("plan-1", { workspaceId: "default" });
    expect(wrappers.commitMcpOAuth).toHaveBeenLastCalledWith(
      expect.objectContaining({ action: "complete", code: "code-1", state: "state-1" }),
    );
    expect(wrappers.commitMcpServerUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ input: { expectedRevision: REVISION, enabled: true } }),
    );
    expect(wrappers.commitMcpConnection).toHaveBeenCalledWith(expect.objectContaining({ action: "connect" }));
  });

  it("waits in Inbox with the approval id and resumes when approved", async () => {
    vi.useFakeTimers();
    install.installCapabilityConnector.mockResolvedValueOnce(
      receipt({ status: "awaiting_approval", requiredAction: APPROVAL }),
    );
    plans.fetchChangePlan
      .mockResolvedValueOnce(plan({ status: "awaiting_approval", requiredAction: APPROVAL, evidenceRefs: [] }))
      .mockResolvedValueOnce(plan());
    servers.fetchMcpServer.mockResolvedValue(server({ authType: "none" }));

    await startInstall({ ...TEMPLATE, auth: "none" });
    expect(latest.state).toEqual({ phase: "waiting_inbox", approvalId: "approval-1", planId: "plan-1" });
    await act(async () => vi.advanceTimersByTimeAsync(4_999));
    expect(plans.fetchChangePlan).not.toHaveBeenCalled();
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(plans.fetchChangePlan).toHaveBeenCalledTimes(1);
    expect(latest.state).toEqual({ phase: "waiting_inbox", approvalId: "approval-1", planId: "plan-1" });

    await act(async () => vi.advanceTimersByTimeAsync(5_000));
    await flush();
    await render(SAVED);

    expect(latest.state).toEqual({ phase: "done", serverId: "srv-1" });
    expect(wrappers.commitMcpOAuth).not.toHaveBeenCalled();
    expect(wrappers.commitMcpServerUpdate).toHaveBeenCalledTimes(1);
    expect(wrappers.commitMcpConnection).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("ignores a sign-in return with a different state", async () => {
    await startInstall();
    await returnFromProvider("another-state");

    expect(latest.state).toMatchObject({ phase: "signing_in" });
    // It may be another tab's sign-in, so nothing is said about it (R82).
    expect(latest.state).not.toHaveProperty("manualError");
    expect(wrappers.commitMcpOAuth).toHaveBeenCalledTimes(1);
    expect(wrappers.commitMcpOAuth).not.toHaveBeenCalledWith(expect.objectContaining({ action: "complete" }));
  });

  it("says so when a pasted code's state doesn't match, and goes on once it does", async () => {
    await startInstall();
    await render(SAVED);
    await act(async () => latest.submitManualCode("pasted-code", "typo-state"));
    await flush();

    expect(latest.state).toEqual({
      phase: "signing_in",
      authorizeUrl: AUTHORIZE_URL,
      signInHost: "auth.linear.app",
      scopes: "read, write",
      manualError: "That doesn't match this sign-in. Paste the code and state from the sign-in page again.",
    });
    expect(wrappers.commitMcpOAuth).toHaveBeenCalledTimes(1);
    expect(wrappers.commitMcpOAuth).not.toHaveBeenCalledWith(expect.objectContaining({ action: "complete" }));

    await act(async () => latest.submitManualCode("pasted-code", "state-1"));
    await flush();

    expect(latest.state).toEqual({ phase: "done", serverId: "srv-1" });
    expect(wrappers.commitMcpOAuth).toHaveBeenLastCalledWith(
      expect.objectContaining({ action: "complete", code: "pasted-code", state: "state-1" }),
    );
  });

  it("finishes sign-in from a pasted code with the matching state", async () => {
    await startInstall();
    await render(SAVED);
    await act(async () => latest.submitManualCode("pasted-code", "state-1"));
    await flush();

    expect(latest.state).toEqual({ phase: "done", serverId: "srv-1" });
    expect(wrappers.commitMcpOAuth).toHaveBeenLastCalledWith(
      expect.objectContaining({ action: "complete", code: "pasted-code", state: "state-1" }),
    );
  });

  it("reports the switch-on step and what changed when enabling fails", async () => {
    const refusal = "The MCP server changed. Review its current configuration before applying the retained draft.";
    wrappers.commitMcpServerUpdate.mockResolvedValueOnce({ status: "conflict", message: refusal });

    await startInstall();
    await render(SAVED);
    await returnFromProvider("state-1");

    expect(latest.state).toEqual({
      phase: "failed",
      step: "switch_on",
      message: "Couldn't switch Linear on. Changed elsewhere. Reload to see the latest.",
      changed: [SUMMARY, "Signed in."],
      detail: refusal,
    });
    expect(wrappers.commitMcpConnection).not.toHaveBeenCalled();
  });

  it("cancel leaves the server saved but switched off and says so", async () => {
    await startInstall();
    await render(SAVED);
    await act(async () => latest.cancel());
    await returnFromProvider("state-1");

    expect(latest.state).toEqual({
      phase: "stopped",
      message: "Stopped. Linear is saved but switched off.",
      changed: [SUMMARY],
    });
    expect(wrappers.commitMcpOAuth).toHaveBeenCalledTimes(1);
    expect(wrappers.commitMcpServerUpdate).not.toHaveBeenCalled();
  });

  it("Reconnect starts at sign-in for a saved server and skips the install plan", async () => {
    await render({ ...SAVED, state: "sign_in_expired", reason: "sign_in_expired" });
    await act(async () => latest.resume("sign_in"));
    await flush();

    expect(latest.state).toMatchObject({ phase: "signing_in", signInHost: "auth.linear.app" });
    expect(install.installCapabilityConnector).not.toHaveBeenCalled();
    expect(calls).toEqual(["read server", "sign in: start"]);
    expect(servers.fetchMcpServer).toHaveBeenCalledWith("srv-1");
  });

  it("Try again connects a saved server without signing in or switching on", async () => {
    await render({ ...SAVED, state: "broken", reason: "error" });
    await act(async () => latest.resume("connect"));
    await flush();

    expect(latest.state).toEqual({ phase: "done", serverId: "srv-1" });
    expect(calls).toEqual(["read server", "connect"]);
  });

  it("maps a refused install to its plain words and changes nothing", async () => {
    install.installCapabilityConnector.mockRejectedValueOnce(
      new ApiRequestError("Linear is already saved.", {
        kind: "http",
        method: "POST",
        path: "/api/v1/capabilities/connectors/install",
        status: 409,
        body: { error: "Linear is already saved.", details: { field: "alreadyInstalled" } },
      }),
    );

    await startInstall();

    expect(latest.state).toMatchObject({
      phase: "failed",
      step: "plan",
      message: "This app is already saved. Reload to see it.",
      changed: [],
    });
    expect(plans.fetchChangePlan).not.toHaveBeenCalled();
  });

  it("keeps a finished install on its template row before the list is read again", async () => {
    servers.fetchMcpServer.mockResolvedValue(server({ authType: "none" }));

    // The panel stays on the template row until the list catches up (R80); here the list never reads again.
    await startInstall({ ...TEMPLATE, auth: "none" });

    expect(latest.state).toEqual({ phase: "done", serverId: "srv-1" });
    expect(latest.serverId).toBe("srv-1");
    expect(install.fetchCapabilityConnectors).not.toHaveBeenCalled();
  });

  it("doesn't show a template install that saved nothing on the saved server's row", async () => {
    install.installCapabilityConnector.mockRejectedValueOnce(
      new ApiRequestError("Linear is already saved.", {
        kind: "http",
        method: "POST",
        path: "/api/v1/capabilities/connectors/install",
        status: 409,
        body: { error: "Linear is already saved.", details: { field: "alreadyInstalled" } },
      }),
    );
    await startInstall();
    expect(latest.state).toMatchObject({ phase: "failed", step: "plan" });

    await render({ ...SAVED, state: "sign_in_expired", reason: "sign_in_expired" });
    expect(latest.state).toEqual({ phase: "idle" });
    expect(latest.serverId).toBe("srv-1");
    // Reconnect on the saved row starts its own sign-in rather than being taken by the template's failed install.
    await act(async () => latest.resume("sign_in"));
    await flush();
    expect(latest.state).toMatchObject({ phase: "signing_in" });
  });

  it("keeps a failed plan's error text in its detail, never in its message", async () => {
    install.installCapabilityConnector.mockResolvedValueOnce(receipt({ status: "failed" }));
    plans.fetchChangePlan.mockResolvedValueOnce(
      plan({
        status: "failed",
        evidenceRefs: ["mcp_template:linear"],
        result: {
          summary: "Couldn't save Linear. Trying again is safe.",
          failureCode: "connector_install_save_failed",
          failureDetail: "SQLITE_BUSY: database is locked",
        },
      }),
    );

    await startInstall();

    expect(latest.state).toEqual({
      phase: "failed",
      step: "plan",
      message: "The install didn't finish.",
      changed: ["Couldn't save Linear. Trying again is safe."],
      detail: "SQLITE_BUSY: database is locked",
    });
    expect(servers.fetchMcpServer).not.toHaveBeenCalled();
  });

  it.each([
    ["cancelled", "approval_denied", "You declined this install in Inbox. Nothing was changed."],
    ["failed", "approval_expired", "This request expired after 15 minutes. Start again."],
    ["failed", "expired", "This request expired after 15 minutes. Start again."],
  ] as const)("says plainly when Inbox ends the plan as %s (%s)", async (status, failureCode, message) => {
    vi.useFakeTimers();
    install.installCapabilityConnector.mockResolvedValueOnce(
      receipt({ status: "awaiting_approval", requiredAction: APPROVAL }),
    );
    plans.fetchChangePlan.mockResolvedValueOnce(
      plan({
        status,
        evidenceRefs: ["mcp_template:linear"],
        result: { summary: "Approval is denied. This plan cannot apply its pending effect.", failureCode },
      }),
    );

    await startInstall();
    await act(async () => vi.advanceTimersByTimeAsync(5_000));

    expect(latest.state).toEqual({ phase: "failed", step: "approval", message, changed: [] });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cancel while waiting in Inbox withdraws the plan and says nothing changed", async () => {
    install.installCapabilityConnector.mockResolvedValueOnce(
      receipt({ status: "awaiting_approval", requiredAction: APPROVAL }),
    );
    plans.fetchChangePlan.mockResolvedValueOnce(
      plan({ status: "awaiting_approval", requiredAction: APPROVAL, revision: 4, evidenceRefs: [] }),
    );
    plans.cancelChangePlan.mockResolvedValueOnce(plan({ status: "cancelled", revision: 5, evidenceRefs: [] }));

    await startInstall();
    await act(async () => latest.cancel());
    await flush();

    expect(plans.cancelChangePlan).toHaveBeenCalledWith(
      "plan-1",
      { workspaceId: "default" },
      { expectedRevision: 4, actionNonce: NONCE },
    );
    expect(latest.state).toEqual({ phase: "stopped", message: "Install stopped. Nothing was changed.", changed: [] });
  });

  it("keeps the flow across an unmount and finds it from the saved server's row", async () => {
    await startInstall();
    act(() => root.unmount());
    root = createRoot(container);

    await render(SAVED);
    expect(latest.state).toMatchObject({ phase: "signing_in" });
    expect(latest.serverId).toBe("srv-1");
    await returnFromProvider("state-1");

    expect(latest.state).toEqual({ phase: "done", serverId: "srv-1" });
  });

  describe("when the panel closes (R88)", () => {
    const WAITING = plan({ status: "awaiting_approval", requiredAction: APPROVAL, evidenceRefs: [] });

    async function waitInInboxThenClose(item: CapabilityConnectorItem) {
      vi.useFakeTimers();
      install.installCapabilityConnector.mockResolvedValueOnce(
        receipt({ status: "awaiting_approval", requiredAction: APPROVAL }),
      );
      await startInstall(item);
      expect(latest.state).toMatchObject({ phase: "waiting_inbox" });
      // "Open in Inbox" changes the address, which closes the panel.
      act(() => root.unmount());
      root = createRoot(container);
    }

    it("keeps reading the plan and finishes the install after approval lands", async () => {
      plans.fetchChangePlan.mockResolvedValueOnce(WAITING).mockResolvedValueOnce(plan());
      servers.fetchMcpServer.mockResolvedValue(server({ authType: "none" }));
      await waitInInboxThenClose({ ...TEMPLATE, auth: "none" });

      await act(async () => vi.advanceTimersByTimeAsync(5_000));
      expect(plans.fetchChangePlan).toHaveBeenCalledTimes(1);
      await act(async () => vi.advanceTimersByTimeAsync(5_000));
      await flush();

      expect(wrappers.commitMcpServerUpdate).toHaveBeenCalledTimes(1);
      expect(wrappers.commitMcpConnection).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
      await render(SAVED);
      expect(latest.state).toEqual({ phase: "done", serverId: "srv-1" });
    });

    it("goes on to sign-in in the background and waits there for the operator", async () => {
      plans.fetchChangePlan.mockResolvedValueOnce(plan());
      await waitInInboxThenClose(TEMPLATE);

      await act(async () => vi.advanceTimersByTimeAsync(5_000));
      await flush();

      expect(wrappers.commitMcpOAuth).toHaveBeenCalledWith(expect.objectContaining({ action: "start" }));
      expect(vi.getTimerCount()).toBe(0);
      await render(SAVED);
      expect(latest.state).toMatchObject({ phase: "signing_in", signInHost: "auth.linear.app" });
      await returnFromProvider("state-1");
      expect(latest.state).toEqual({ phase: "done", serverId: "srv-1" });
    });

    it("stops reading the plan once the install is cancelled or forgotten", async () => {
      plans.fetchChangePlan.mockResolvedValue(WAITING);
      plans.cancelChangePlan.mockResolvedValueOnce(plan({ status: "cancelled", evidenceRefs: [] }));
      await waitInInboxThenClose(TEMPLATE);
      expect(vi.getTimerCount()).toBe(1);

      await render(TEMPLATE);
      await act(async () => latest.cancel());
      await flush();
      expect(latest.state).toMatchObject({ phase: "stopped" });
      expect(vi.getTimerCount()).toBe(0);
      const reads = plans.fetchChangePlan.mock.calls.length;
      await act(async () => vi.advanceTimersByTimeAsync(20_000));
      expect(plans.fetchChangePlan).toHaveBeenCalledTimes(reads);

      // A new install waiting in Inbox, then forgotten, leaves no timer either.
      install.installCapabilityConnector.mockResolvedValueOnce(
        receipt({ status: "awaiting_approval", requiredAction: APPROVAL }),
      );
      await act(async () => latest.start({ enableChatConnectors: true }));
      await flush();
      expect(latest.state).toMatchObject({ phase: "waiting_inbox" });
      expect(vi.getTimerCount()).toBe(1);
      __resetConnectorInstallForTests();
      expect(vi.getTimerCount()).toBe(0);
    });

    it("reads the plan once per beat however many hooks show the flow", async () => {
      plans.fetchChangePlan.mockResolvedValue(WAITING);
      await waitInInboxThenClose(TEMPLATE);
      await act(async () =>
        root.render(
          <QueryClientProvider client={client}>
            <Probe item={TEMPLATE} />
            <Probe item={TEMPLATE} />
          </QueryClientProvider>,
        ),
      );

      await act(async () => vi.advanceTimersByTimeAsync(5_000));
      expect(plans.fetchChangePlan).toHaveBeenCalledTimes(1);
      await act(async () => vi.advanceTimersByTimeAsync(5_000));
      expect(plans.fetchChangePlan).toHaveBeenCalledTimes(2);
    });

    it("lets a row read the flow's state without reading the plan itself", async () => {
      let status: ConnectorInstallState | undefined;
      function Row({ item }: { item: CapabilityConnectorItem }) {
        status = useConnectorInstallStatus(item);
        return null;
      }
      vi.useFakeTimers();
      await act(async () => root.render(<Row item={TEMPLATE} />));
      expect(status).toEqual({ phase: "idle" });
      expect(vi.getTimerCount()).toBe(0);

      plans.fetchChangePlan.mockResolvedValue(WAITING);
      await waitInInboxThenClose(TEMPLATE);
      await act(async () => root.render(<Row item={TEMPLATE} />));

      expect(status).toEqual({ phase: "waiting_inbox", approvalId: "approval-1", planId: "plan-1" });
      expect(vi.getTimerCount()).toBe(1);
      expect(plans.fetchChangePlan).not.toHaveBeenCalled();
    });
  });
});
