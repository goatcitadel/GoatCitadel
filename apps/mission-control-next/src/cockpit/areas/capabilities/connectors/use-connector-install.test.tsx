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
  __resetMcpServerMutationsForTests,
  IDLE_MCP_ATTEMPT,
  readMcpServerAttempt,
  writeMcpServerAttempt,
} from "../../../../features/native-routes/settings/mcp-server-attempts";
import {
  __resetConnectorInstallForTests,
  useConnectorInstall,
  useConnectorInstallStatus,
  useRecoveredInstalls,
  type ConnectorInstallState,
} from "./use-connector-install";

const install = vi.hoisted(() => ({ installCapabilityConnector: vi.fn(), fetchCapabilityConnectors: vi.fn() }));
vi.mock("@goatcitadel/mission-control-shared/api/capability-connectors", () => install);
const plans = vi.hoisted(() => ({ fetchChangePlan: vi.fn(), fetchChangePlans: vi.fn(), cancelChangePlan: vi.fn() }));
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
const approvals = vi.hoisted(() => ({ fetchApproval: vi.fn(), resolveApproval: vi.fn() }));
vi.mock("@goatcitadel/mission-control-shared/api/approvals", async (original) => ({
  ...(await original<object>()),
  ...approvals,
}));
// The Gateway's record of a lost write is read through this; the lock itself is the real module's.
const outcome = vi.hoisted(() => ({ checkMcpServerOutcome: vi.fn() }));
vi.mock("../../../../features/native-routes/settings/mcp-server-attempts", async (original) => ({
  ...(await original<object>()),
  checkMcpServerOutcome: outcome.checkMcpServerOutcome,
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
  plans.fetchChangePlans.mockResolvedValue({ items: [] });
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
  approvals.fetchApproval.mockImplementation(async (approvalId: string) => ({
    approvalId,
    kind: "change_plan_effect",
    status: "pending",
    payload: { planId: "plan-1" },
  }));
  approvals.resolveApproval.mockImplementation(async () => {
    calls.push("deny approval");
    return {};
  });
  outcome.checkMcpServerOutcome.mockImplementation(async () => {
    calls.push("check outcome");
    return undefined;
  });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  client.clear();
  __resetConnectorInstallForTests();
  __resetMcpOAuthFlowsForTests();
  __resetMcpOAuthReturnForTests();
  __resetMcpServerMutationsForTests();
  window.history.replaceState(null, "", "/");
  vi.useRealTimers();
  vi.restoreAllMocks();
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
      startedAt: expect.any(Number),
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
      startedAt: expect.any(Number),
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
    expect(latest.state).not.toHaveProperty("link");
    expect(plans.fetchChangePlan).not.toHaveBeenCalled();
  });

  it("links a refusal that sends the app to Settings", async () => {
    install.installCapabilityConnector.mockRejectedValueOnce(
      new ApiRequestError("Linear needs an API key. Set it up in Settings.", {
        kind: "http",
        method: "POST",
        path: "/api/v1/capabilities/connectors/install",
        status: 409,
        body: { error: "Linear needs an API key. Set it up in Settings.", details: { field: "needsApiKey" } },
      }),
    );

    await startInstall();

    expect(latest.state).toMatchObject({
      phase: "failed",
      step: "plan",
      message: "This app needs an API key. Set it up in Settings.",
      link: { label: "Open in Settings", href: "/settings/connections#mcp-servers" },
    });
  });

  // M5: the Gateway's 503 for this says why, so the panel says it plainly instead of a generic error.
  it("says plainly that installing is switched off when Change Plans are off", async () => {
    const gatewayText = "Installing connectors needs Change Plans, which are off on this install.";
    install.installCapabilityConnector.mockRejectedValueOnce(
      new ApiRequestError(gatewayText, {
        kind: "http",
        method: "POST",
        path: "/api/v1/capabilities/connectors/install",
        status: 503,
        body: { error: gatewayText, code: "EXTERNAL_SERVICE_FAILED", details: { reason: "change_plans_off" } },
      }),
    );

    await startInstall();

    expect(latest.state).toMatchObject({
      phase: "failed",
      step: "plan",
      message:
        "Installing from here is switched off on this install, so nothing was changed. You can add it yourself in Settings.",
      changed: [],
      link: { label: "Open in Settings", href: "/settings/connections#mcp-servers" },
    });
    expect((latest.state as { message: string }).message).not.toContain("gateway");
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

  // I1: a sign-in the Gateway refused before it changed anything says why, and what to do, in plain words.
  describe("when sign-in is refused", () => {
    // The words that point at Settings link to the page that fixes it (DESIGN.md).
    const ALLOWLIST_LINK = { label: "Open in Settings", href: "/settings/first-run" } as const;
    const MCP_LINK = { label: "Open in Settings", href: "/settings/connections#mcp-servers" } as const;
    it.each([
      [
        "its sign-in site isn't on the network allowlist",
        { refused: "not_allowed", refusedHost: "auth.linear.app" },
        "Couldn't start signing in to Linear. Its sign-in site auth.linear.app isn't on your network allowlist. Add " +
          "it under Change installation defaults in Settings, then sign in again.",
        { link: ALLOWLIST_LINK },
      ],
      [
        "a sign-in site it can't name isn't on the network allowlist",
        { refused: "not_allowed" },
        "Couldn't start signing in to Linear. Its sign-in site isn't on your network allowlist. Add it under Change " +
          "installation defaults in Settings, then sign in again.",
        { link: ALLOWLIST_LINK },
      ],
      [
        "its sign-in site can't be read",
        { refused: "sign_in_site" },
        "Couldn't start signing in to Linear. Its sign-in site couldn't be read. Try again in a moment, or set up " +
          "its sign-in in Settings.",
        { link: MCP_LINK },
      ],
      [
        "the app won't register GoatCitadel",
        { refused: "registration" },
        "Couldn't start signing in to Linear. It wouldn't register GoatCitadel for sign-in. Set up its sign-in in " +
          "Settings instead.",
        // Signing in again would only be refused the same way, so the flow says so for its controls.
        { link: MCP_LINK, signInBlocked: true },
      ],
    ] as const)("names the cause when %s", async (_label, refusal, message, next) => {
      const gatewayText = "Sign-in discovery for Linear failed: Host is not yet allowlisted: https://auth.linear.app";
      wrappers.commitMcpOAuth.mockResolvedValueOnce({ status: "conflict", message: gatewayText, ...refusal });

      await startInstall();

      expect(latest.state).toEqual({
        phase: "failed",
        step: "sign_in",
        message,
        changed: [SUMMARY],
        detail: gatewayText,
        ...next,
      });
      expect(JSON.stringify(latest.state)).not.toContain("Changed elsewhere");
    });

    it("says an expired sign-in request needs a new one", async () => {
      const gatewayText = "This sign-in expired or the Gateway restarted since it began. Start authorization again.";
      await startInstall();
      await render(SAVED);
      wrappers.commitMcpOAuth.mockResolvedValueOnce({ status: "conflict", message: gatewayText, refused: "expired" });
      await returnFromProvider("state-1");

      expect(latest.state).toEqual({
        phase: "failed",
        step: "finish_sign_in",
        message: "Couldn't finish signing in to Linear. This sign-in request expired. Sign in again to get a new one.",
        changed: [SUMMARY],
        detail: gatewayText,
      });
    });

    it("keeps the reload advice for a real review conflict", async () => {
      wrappers.commitMcpOAuth.mockResolvedValueOnce({
        status: "conflict",
        message: "The server or authorization request changed. Refresh and review it again.",
      });

      await startInstall();

      expect(latest.state).toMatchObject({
        phase: "failed",
        step: "sign_in",
        message: "Couldn't start signing in to Linear. Changed elsewhere. Reload to see the latest.",
      });
    });
  });

  // R94: a sign-in started in the background may be old by the time the operator comes back.
  it("starts an old sign-in again on demand, keeping what already changed", async () => {
    await startInstall();
    await render(SAVED);
    const first = latest.state;
    expect(first).toMatchObject({ phase: "signing_in" });
    vi.spyOn(Date, "now").mockReturnValue((first as { startedAt: number }).startedAt + 9.5 * 60_000);

    await act(async () => latest.restartSignIn());
    await flush();

    expect(latest.state).toMatchObject({
      phase: "signing_in",
      startedAt: (first as { startedAt: number }).startedAt + 9.5 * 60_000,
    });
    expect(calls.filter((call) => call === "sign in: start")).toHaveLength(2);
    await returnFromProvider("state-1");
    expect(latest.state).toEqual({ phase: "done", serverId: "srv-1" });
    expect(install.installCapabilityConnector).toHaveBeenCalledTimes(1);
  });

  // I2: an unconfirmed write is settled from the Gateway's record before the flow fails or tries again.
  describe("when a switch-on or connect can't be confirmed", () => {
    const BROKEN = { ...SAVED, state: "broken", reason: "error" } as const;
    const UNCONFIRMED =
      "MCP connection outcome is unconfirmed. Further changes to this server are locked for this app session; inspect its current owner state.";
    /** What the Settings wrapper does with a lost connect: it locks the server and says so. */
    const lostConnect = async () => {
      calls.push("connect");
      writeMcpServerAttempt("srv-1", { phase: "uncertain", message: UNCONFIRMED });
      return { status: "uncertain", message: UNCONFIRMED };
    };
    const lockedConnect = async () => {
      calls.push("connect");
      return { status: "locked", message: readMcpServerAttempt("srv-1").message ?? "" };
    };

    it("says it couldn't be confirmed, then settles it and connects on Try again", async () => {
      wrappers.commitMcpConnection.mockImplementationOnce(lostConnect).mockImplementationOnce(lockedConnect);
      const invalidate = vi.spyOn(client, "invalidateQueries");
      await render(BROKEN);
      await act(async () => latest.resume("connect"));
      await flush();

      expect(latest.state).toEqual({
        phase: "failed",
        step: "connect",
        message: "Couldn't connect Linear. Its last change couldn't be confirmed. Reload, then try again.",
        changed: [],
        detail: UNCONFIRMED,
      });
      expect(outcome.checkMcpServerOutcome).toHaveBeenCalledWith("srv-1", expect.any(Function));
      expect(invalidate).toHaveBeenCalledWith({ queryKey: ["mcp", "capability-connectors", "ws-1"] });

      // The Gateway's record has settled it by the time Try again is pressed: the lock is released and it connects.
      outcome.checkMcpServerOutcome.mockImplementationOnce(async () => {
        calls.push("check outcome");
        writeMcpServerAttempt("srv-1", IDLE_MCP_ATTEMPT);
        return "settled";
      });
      calls = [];
      await act(async () => latest.resume("connect"));
      await flush();

      expect(latest.state).toEqual({ phase: "done", serverId: "srv-1" });
      expect(calls).toEqual(["read server", "connect", "check outcome", "read server", "connect"]);
      expect(JSON.stringify(latest.state)).not.toContain("still running");
    });

    it.each([
      [
        "a program on this computer",
        { transport: "stdio", command: "uvx", url: undefined },
        "Couldn't connect Linear. Check that it can run on this computer, then try again.",
        undefined,
      ],
      [
        "a remote app",
        { transport: "http" },
        "Couldn't connect Linear. Try again in a moment, or check its setup in Settings.",
        { label: "Open in Settings", href: "/settings/connections#mcp-servers" },
      ],
    ] as const)(
      "shows the server's own last error once a failed connect of %s is settled",
      async (_l, shape, words, link) => {
        const secret = "abc123def456ghi789jkl0123";
        wrappers.commitMcpConnection.mockImplementationOnce(lostConnect);
        outcome.checkMcpServerOutcome.mockImplementationOnce(async () => {
          writeMcpServerAttempt("srv-1", IDLE_MCP_ATTEMPT);
          return "settled";
        });
        const failed = { ...shape, enabled: true, status: "error" } as Partial<McpServerRecord>;
        servers.fetchMcpServer
          .mockResolvedValueOnce(server(failed))
          .mockResolvedValueOnce(server({ ...failed, lastError: `spawn uvx ENOENT\nAuthorization: Bearer ${secret}` }));
        await render(BROKEN);
        await act(async () => latest.resume("connect"));
        await flush();

        expect(latest.state).toMatchObject({ phase: "failed", step: "connect", message: words, changed: [] });
        // The words that point at Settings link there (DESIGN.md); the others link nowhere.
        expect((latest.state as { link?: unknown }).link).toEqual(link);
        const detail = (latest.state as { detail?: string }).detail ?? "";
        expect(detail).toContain("spawn uvx ENOENT");
        expect(detail).not.toContain(secret);
      },
    );

    it("finishes when the settled connect turns out to have gone through", async () => {
      wrappers.commitMcpConnection.mockImplementationOnce(lostConnect);
      outcome.checkMcpServerOutcome.mockImplementationOnce(async () => {
        writeMcpServerAttempt("srv-1", IDLE_MCP_ATTEMPT);
        return "settled";
      });
      servers.fetchMcpServer
        .mockResolvedValueOnce(server({ enabled: true, status: "error" }))
        .mockResolvedValueOnce(server({ enabled: true, status: "connected" }));
      await render(BROKEN);
      await act(async () => latest.resume("connect"));
      await flush();

      expect(latest.state).toEqual({ phase: "done", serverId: "srv-1" });
      expect(wrappers.commitMcpConnection).toHaveBeenCalledTimes(1);
    });

    it("settles an unconfirmed switch-on and goes on once it is on", async () => {
      servers.fetchMcpServer.mockResolvedValue(server({ authType: "none" }));
      wrappers.commitMcpServerUpdate.mockImplementationOnce(async () => {
        calls.push("switch on");
        writeMcpServerAttempt("srv-1", { phase: "uncertain", message: "MCP update outcome is unconfirmed." });
        return { status: "uncertain", message: "MCP update outcome is unconfirmed." };
      });
      outcome.checkMcpServerOutcome.mockImplementationOnce(async () => {
        writeMcpServerAttempt("srv-1", IDLE_MCP_ATTEMPT);
        servers.fetchMcpServer.mockResolvedValue(server({ authType: "none", enabled: true }));
        return "settled";
      });

      await startInstall({ ...TEMPLATE, auth: "none" });

      expect(latest.state).toEqual({ phase: "done", serverId: "srv-1" });
      expect(wrappers.commitMcpServerUpdate).toHaveBeenCalledTimes(1);
      expect(wrappers.commitMcpConnection).toHaveBeenCalledTimes(1);
    });
  });

  // M3: a plan that failed after it saved the app names the server, so the panel hands over to it.
  it("takes on the saved server when the install fails after saving it", async () => {
    install.installCapabilityConnector.mockResolvedValueOnce(receipt({ status: "manual_required" }));
    plans.fetchChangePlan.mockResolvedValueOnce(
      plan({
        status: "manual_required",
        result: {
          summary:
            "Saved Linear, switched off. Couldn't set Linear to Reading is free, so everything it does asks you first.",
          failureCode: "connector_install_posture_failed",
        },
      }),
    );

    await startInstall();

    expect(latest.state).toMatchObject({ phase: "failed", step: "plan", message: "The install didn't finish." });
    expect(latest.serverId).toBe("srv-1");
    await render(SAVED);
    expect(latest.state).toMatchObject({ phase: "failed", step: "plan" });
  });

  // R93: Stop withdraws the plan and then denies its own Inbox approval, so Inbox stops asking about it.
  describe("Stop while waiting in Inbox", () => {
    async function waitThenStop() {
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
    }

    it("denies the plan's own pending approval after the withdrawal", async () => {
      await waitThenStop();

      expect(approvals.fetchApproval).toHaveBeenCalledWith("approval-1", { workspaceId: "default" });
      expect(approvals.resolveApproval).toHaveBeenCalledExactlyOnceWith("approval-1", "reject");
      expect(plans.cancelChangePlan.mock.invocationCallOrder[0]).toBeLessThan(
        approvals.resolveApproval.mock.invocationCallOrder[0]!,
      );
      expect(latest.state).toEqual({ phase: "stopped", message: "Install stopped. Nothing was changed.", changed: [] });
    });

    it.each([
      ["another plan's", { payload: { planId: "plan-other" } }],
      ["an already decided", { status: "rejected" }],
      ["a different kind of", { kind: "tool_invoke" }],
    ])("leaves %s approval alone", async (_label, overrides) => {
      approvals.fetchApproval.mockImplementationOnce(async (approvalId: string) => ({
        approvalId,
        kind: "change_plan_effect",
        status: "pending",
        payload: { planId: "plan-1" },
        ...overrides,
      }));

      await waitThenStop();

      expect(approvals.resolveApproval).not.toHaveBeenCalled();
      expect(latest.state).toEqual({ phase: "stopped", message: "Install stopped. Nothing was changed.", changed: [] });
    });

    it("keeps the stop and says where to deny it when the denial fails", async () => {
      approvals.resolveApproval.mockRejectedValueOnce(new Error("offline"));

      await waitThenStop();

      expect(latest.state).toEqual({
        phase: "stopped",
        message: "Install stopped. Nothing was changed. Its request is still in Inbox, where you can deny it.",
        changed: [],
        link: { label: "Open in Inbox", href: "/inbox?approvalId=approval-1&workspaceId=default" },
      });
    });
  });

  // A reload forgets every flow; an install that still waits in Inbox is taken on again when the list loads.
  describe("after a reload", () => {
    const WAITING = plan({ status: "awaiting_approval", requiredAction: APPROVAL, revision: 4, evidenceRefs: [] });

    /** The Connectors tab as it loads its list, and one row's flow, read the way the panel reads it. */
    function Loaded({ items, item }: { items: CapabilityConnectorItem[]; item: CapabilityConnectorItem }) {
      useRecoveredInstalls(items);
      latest = useConnectorInstall(item);
      return null;
    }

    async function load(items: CapabilityConnectorItem[], item = items[0]!) {
      await act(async () =>
        root.render(
          <QueryClientProvider client={client}>
            <Loaded items={items} item={item} />
          </QueryClientProvider>,
        ),
      );
      await flush();
    }

    it("takes on an install still waiting in Inbox, so its row shows it and Stop withdraws it", async () => {
      plans.fetchChangePlans.mockResolvedValueOnce({ items: [WAITING] });

      await load([TEMPLATE]);

      expect(plans.fetchChangePlans).toHaveBeenCalledExactlyOnceWith(
        { workspaceId: "default" },
        { status: "awaiting_approval", limit: 100 },
      );
      expect(latest.state).toEqual({ phase: "waiting_inbox", approvalId: "approval-1", planId: "plan-1" });
      expect(install.installCapabilityConnector).not.toHaveBeenCalled();

      plans.fetchChangePlan.mockResolvedValueOnce(WAITING);
      plans.cancelChangePlan.mockResolvedValueOnce(plan({ status: "cancelled", revision: 5, evidenceRefs: [] }));
      await act(async () => latest.cancel());
      await flush();

      expect(plans.cancelChangePlan).toHaveBeenCalledWith(
        "plan-1",
        { workspaceId: "default" },
        { expectedRevision: 4, actionNonce: NONCE },
      );
      expect(latest.state).toEqual({ phase: "stopped", message: "Install stopped. Nothing was changed.", changed: [] });
    });

    it("goes on to sign in once the install it took on is approved", async () => {
      vi.useFakeTimers();
      plans.fetchChangePlans.mockResolvedValueOnce({ items: [WAITING] });
      plans.fetchChangePlan.mockResolvedValueOnce(plan());

      await load([TEMPLATE]);
      await act(async () => vi.advanceTimersByTimeAsync(5_000));
      await flush();

      expect(latest.state).toMatchObject({ phase: "signing_in", signInHost: "auth.linear.app" });
      expect(latest.serverId).toBe("srv-1");
    });

    it("takes on only a Capabilities install of a template in the list, and reads the plans once", async () => {
      const elsewhere = plan({
        ...WAITING,
        planId: "plan-settings",
        origin: { workspaceId: "default", surface: "settings", actorId: "operator" },
      } as Partial<ChangePlanRecord>);
      const unlisted = plan({
        ...WAITING,
        planId: "plan-notion",
        request: { kind: "connector_install", templateId: "notion", enableChatConnectors: false },
      } as Partial<ChangePlanRecord>);
      plans.fetchChangePlans.mockResolvedValueOnce({ items: [elsewhere, unlisted] });

      await load([TEMPLATE]);
      await load([{ ...TEMPLATE }]);

      expect(latest.state).toEqual({ phase: "idle" });
      expect(plans.fetchChangePlans).toHaveBeenCalledOnce();
    });

    it("reads the plans again on the next list load when they couldn't be read", async () => {
      plans.fetchChangePlans.mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce({ items: [WAITING] });

      await load([TEMPLATE]);
      expect(latest.state).toEqual({ phase: "idle" });
      await load([{ ...TEMPLATE }]);

      expect(plans.fetchChangePlans).toHaveBeenCalledTimes(2);
      expect(latest.state).toEqual({ phase: "waiting_inbox", approvalId: "approval-1", planId: "plan-1" });
    });

    /**
     * Web Locks as another tab sees them: a name in `held` is another tab's, and a lock this tab takes is held until
     * the promise its callback returned settles.
     */
    function withLocks(held: Set<string>) {
      const locks = {
        request: (name: string, options: { ifAvailable?: boolean }, callback: (lock: unknown) => unknown) => {
          if (options.ifAvailable && held.has(name)) return Promise.resolve(callback(null));
          held.add(name);
          const result = Promise.resolve(callback({ name }));
          void result.finally(() => held.delete(name));
          return result;
        },
      };
      Object.defineProperty(window.navigator, "locks", { value: locks, configurable: true });
      return () => {
        Reflect.deleteProperty(window.navigator, "locks");
      };
    }

    it("leaves an install another tab already follows to that tab", async () => {
      const restore = withLocks(new Set(["goatcitadel:connector-install:plan-1"]));
      try {
        plans.fetchChangePlans.mockResolvedValueOnce({ items: [WAITING] });

        await load([TEMPLATE]);

        // Only one tab goes on to sign in, switch on and connect once it is approved.
        expect(latest.state).toEqual({ phase: "idle" });
      } finally {
        restore();
      }
    });

    it("holds an install's plan for the tab that follows it until the flow settles", async () => {
      const held = new Set<string>();
      const restore = withLocks(held);
      try {
        plans.fetchChangePlans.mockResolvedValueOnce({ items: [WAITING] });
        await load([TEMPLATE]);
        expect(latest.state).toMatchObject({ phase: "waiting_inbox" });
        expect([...held]).toEqual(["goatcitadel:connector-install:plan-1"]);

        plans.fetchChangePlan.mockResolvedValueOnce(WAITING);
        plans.cancelChangePlan.mockResolvedValueOnce(plan({ status: "cancelled", revision: 5, evidenceRefs: [] }));
        await act(async () => latest.cancel());
        await flush();

        expect(latest.state).toMatchObject({ phase: "stopped" });
        expect([...held]).toEqual([]);
      } finally {
        restore();
      }
    });

    it("holds the plan of an install this tab started, so a reload elsewhere leaves it alone", async () => {
      const held = new Set<string>();
      const restore = withLocks(held);
      try {
        install.installCapabilityConnector.mockResolvedValueOnce(
          receipt({ status: "awaiting_approval", requiredAction: APPROVAL }),
        );

        await startInstall();

        expect(latest.state).toMatchObject({ phase: "waiting_inbox" });
        expect([...held]).toEqual(["goatcitadel:connector-install:plan-1"]);
      } finally {
        restore();
      }
    });

    it("leaves a flow this tab already has alone", async () => {
      vi.useFakeTimers();
      install.installCapabilityConnector.mockResolvedValueOnce(
        receipt({ status: "awaiting_approval", requiredAction: APPROVAL }),
      );
      plans.fetchChangePlan.mockResolvedValue(WAITING);
      await startInstall();
      plans.fetchChangePlans.mockResolvedValueOnce({ items: [WAITING] });

      await load([TEMPLATE]);
      await act(async () => vi.advanceTimersByTimeAsync(5_000));

      expect(latest.state).toEqual({ phase: "waiting_inbox", approvalId: "approval-1", planId: "plan-1" });
      // One flow follows the plan: a second one for the same plan would read it on its own timer too.
      expect(plans.fetchChangePlan).toHaveBeenCalledOnce();
    });
  });

  // T17: a resume on a switched-on server knows it is on before it reads the server.
  it("says a stopped sign-in left a switched-on server switched on", async () => {
    servers.fetchMcpServer.mockImplementationOnce(() => new Promise(() => undefined));
    await render({ ...SAVED, state: "sign_in_expired", reason: "sign_in_expired" });
    await act(async () => latest.resume("sign_in"));
    expect(latest.state).toEqual({ phase: "working", step: "sign_in" });

    await act(async () => latest.cancel());

    expect(latest.state).toEqual({
      phase: "stopped",
      message: "Stopped. Linear is switched on but may not be connected. Reload to check.",
      changed: [],
    });
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
