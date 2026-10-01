import { StrictMode } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { McpReviewedOAuthStartResponse, McpServerRecord } from "@goatcitadel/contracts";
import { ApiRequestError } from "@goatcitadel/mission-control-shared/api/http-internal";
import { McpOAuthControls } from "./McpOAuthControls";
import { commitMcpOAuth } from "./mcp-oauth-mutation";
import { __resetMcpOAuthFlowsForTests, readMcpOAuthFlow } from "./mcp-oauth-flow-state";
import { __resetMcpServerMutationsForTests, readMcpServerAttempt } from "./mcp-server-attempts";
import { commitMcpConnection } from "./mcp-connection-mutation";

const api = vi.hoisted(() => ({
  fetchMcpServer: vi.fn(),
  startReviewedMcpOAuth: vi.fn(),
  completeReviewedMcpOAuth: vi.fn(),
  connectReviewedMcpServer: vi.fn(),
}));
vi.mock("@goatcitadel/mission-control-shared/api/client", async (original) => ({
  ...(await original<object>()),
  ...api,
}));
const initial: McpServerRecord = {
  serverId: "fixture",
  revision: "a".repeat(64),
  connectionRevision: "b".repeat(64),
  configurationBindingId: "11111111-1111-4111-8111-111111111111",
  label: "OAuth fixture",
  transport: "http",
  url: "https://example.invalid/mcp",
  authType: "oauth2",
  enabled: true,
  oauth: {
    authorizationUrl: "https://example.invalid/authorize?audience=fixture",
    tokenUrl: "https://example.invalid/token",
    redirectUri: "http://127.0.0.1/manual",
    scopes: ["inspect"],
  },
  authState: { authType: "oauth2", readiness: "needs_auth" },
  status: "connected",
  category: "development",
  trustTier: "restricted",
  costTier: "free",
  policy: {
    requireFirstToolApproval: true,
    redactionMode: "strict",
    allowedToolPatterns: [],
    blockedToolPatterns: [],
    allowedEnvKeys: [],
  },
  createdAt: "2026-09-30T00:00:00Z",
  updatedAt: "2026-09-30T00:00:00Z",
};
const started: McpServerRecord = {
  ...initial,
  // Starting a first handshake changes only connection generation when no prior token/environment changes.
  revision: initial.revision,
  connectionRevision: "d".repeat(64),
  status: "disconnected",
};
const saved: McpServerRecord = {
  ...started,
  configurationBindingId: "22222222-2222-4222-8222-222222222222",
  revision: "e".repeat(64),
  authState: { authType: "oauth2", readiness: "ready" },
};
const state = "11111111-1111-4111-8111-111111111111";
const review = (server: McpServerRecord) => ({
  expectedRevision: server.revision!,
  expectedConnectionRevision: server.connectionRevision ?? null,
});
function flow(): McpReviewedOAuthStartResponse {
  const url = new URL(initial.oauth!.authorizationUrl!);
  url.searchParams.set("state", state);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", initial.oauth!.redirectUri!);
  url.searchParams.set("scope", "inspect");
  return {
    authorizeUrl: url.toString(),
    state,
    review: { version: 1, reviewed: review(initial), server: structuredClone(started) },
  };
}
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
let root: ReactTestRenderer | undefined;
const reload = vi.fn(async () => undefined);
async function render(record = initial, scope = "one") {
  await act(async () => {
    const element = (
      <StrictMode>
        <McpOAuthControls
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
const button = (name: string) => root!.root.findAllByType("button").find((node) => node.props.children === name)!;
const click = (name: string) => act(async () => button(name).props.onClick());
const content = () => JSON.stringify(root!.toJSON());
async function input(index: number, value: string) {
  await act(async () => root!.root.findAllByType("input")[index]!.props.onChange({ target: { value } }));
}
async function begin() {
  await render();
  await click("Review OAuth authorization");
  await click("Start reviewed authorization");
  await render(started);
}
beforeEach(() => {
  vi.resetAllMocks();
  __resetMcpServerMutationsForTests();
  __resetMcpOAuthFlowsForTests();
  api.fetchMcpServer.mockResolvedValue(initial);
  api.startReviewedMcpOAuth.mockImplementation(async () => {
    api.fetchMcpServer.mockResolvedValue(started);
    return flow();
  });
  api.completeReviewedMcpOAuth.mockImplementation(async () => {
    api.fetchMcpServer.mockResolvedValue(saved);
    return { version: 1, reviewed: review(started), state, server: saved };
  });
});
afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
});

it("reviews and cancels with zero writes; start binds the exact owner and never automatically opens a page", async () => {
  await render();
  expect(api.fetchMcpServer).not.toHaveBeenCalled();
  await click("Review OAuth authorization");
  expect(content()).toContain("closes the current MCP connection");
  await click("Cancel OAuth review");
  expect(api.startReviewedMcpOAuth).not.toHaveBeenCalled();
  await click("Review OAuth authorization");
  await click("Start reviewed authorization");
  expect(api.startReviewedMcpOAuth).toHaveBeenCalledExactlyOnceWith(initial.serverId, review(initial));
  await render(started);
  expect(root!.root.findByType("a").props.href).toBe(flow().authorizeUrl);
  expect(reload).toHaveBeenCalledOnce();
  expect(api.connectReviewedMcpServer).not.toHaveBeenCalled();
});
it("requires exact returned state, clears transient code at dispatch and confirms auth without connecting", async () => {
  await begin();
  await input(0, "transient-code");
  await input(1, "wrong-state");
  await click("Review authorization completion");
  expect(api.completeReviewedMcpOAuth).not.toHaveBeenCalled();
  await input(1, state);
  await click("Review authorization completion");
  expect(content()).not.toContain('"children":"transient-code"');
  await click("Complete reviewed authorization");
  expect(api.completeReviewedMcpOAuth).toHaveBeenCalledExactlyOnceWith(initial.serverId, {
    ...review(started),
    code: "transient-code",
    state,
  });
  expect(readMcpOAuthFlow(initial.serverId)).toBeUndefined();
  expect(content()).toContain("server remains disconnected");
  expect(content()).not.toContain("transient-code");
  expect(api.connectReviewedMcpServer).not.toHaveBeenCalled();
});
it.each(["revision", "connectionRevision", "url"] as const)(
  "withholds changed %s before final dispatch",
  async (field) => {
    await render();
    await click("Review OAuth authorization");
    api.fetchMcpServer.mockResolvedValue({
      ...initial,
      [field]: field === "url" ? "https://other.invalid" : "f".repeat(64),
    });
    await click("Start reviewed authorization");
    expect(api.startReviewedMcpOAuth).not.toHaveBeenCalled();
  },
);
it.each(["away-back", "unmount", "cancel"])("cancels final preflight on %s", async (timing) => {
  await render();
  await click("Review OAuth authorization");
  const pending = deferred<McpServerRecord>();
  api.fetchMcpServer.mockReturnValueOnce(pending.promise);
  await click("Start reviewed authorization");
  if (timing === "away-back") {
    await render(initial, "other");
    await render();
  }
  if (timing === "unmount") {
    await act(async () => root!.unmount());
    root = undefined;
  }
  if (timing === "cancel") await click("Cancel OAuth review");
  await act(async () => pending.resolve(initial));
  expect(api.startReviewedMcpOAuth).not.toHaveBeenCalled();
});
it("admits one duplicate start and acknowledges a late success without stale callbacks", async () => {
  await render();
  await click("Review OAuth authorization");
  const pending = deferred<McpReviewedOAuthStartResponse>();
  api.startReviewedMcpOAuth.mockReturnValueOnce(pending.promise);
  await act(async () => {
    button("Start reviewed authorization").props.onClick();
    button("Start reviewed authorization").props.onClick();
  });
  expect(api.startReviewedMcpOAuth).toHaveBeenCalledOnce();
  await render(initial, "other");
  api.fetchMcpServer.mockResolvedValue(started);
  await act(async () => pending.resolve(flow()));
  expect(reload).not.toHaveBeenCalled();
  await render(started, "other");
  expect(root!.root.findByType("a").props.href).toBe(flow().authorizeUrl);
});
it.each(["start", "complete"] as const)(
  "retains lost %s outcome across remount and other server actions",
  async (action) => {
    if (action === "complete") {
      await begin();
      await input(0, "secret-code");
      await input(1, state);
      await click("Review authorization completion");
      api.completeReviewedMcpOAuth.mockRejectedValueOnce(new Error("lost"));
    } else {
      await render();
      await click("Review OAuth authorization");
      api.startReviewedMcpOAuth.mockRejectedValueOnce(new Error("lost"));
    }
    await click(action === "start" ? "Start reviewed authorization" : "Complete reviewed authorization");
    await act(async () => root!.unmount());
    root = undefined;
    await render(action === "start" ? initial : started, "other");
    expect(button("Review OAuth authorization").props.disabled).toBe(true);
    expect(content()).not.toContain("secret-code");
    expect(JSON.stringify(readMcpServerAttempt(initial.serverId))).not.toContain("secret-code");
    expect((await commitMcpConnection({ reviewed: initial, action: "disconnect", isCurrent: () => true })).status).toBe(
      "locked",
    );
  },
);
it.each(["url", "state", "nonce", "readback"])("locks invalid %s start evidence", async (mismatch) => {
  const receipt = flow();
  if (mismatch === "url") receipt.authorizeUrl = receipt.authorizeUrl.replace("example.invalid", "foreign.invalid");
  if (mismatch === "state") receipt.state = "22222222-2222-4222-8222-222222222222";
  if (mismatch === "nonce") receipt.review.server.connectionRevision = initial.connectionRevision;
  api.startReviewedMcpOAuth.mockImplementation(async () => {
    api.fetchMcpServer.mockResolvedValue(
      mismatch === "readback" ? { ...started, label: "Peer" } : receipt.review.server,
    );
    return receipt;
  });
  expect(
    (await commitMcpOAuth({ reviewed: initial, action: "start", isCurrent: () => true, onDispatch: () => undefined }))
      .status,
  ).toBe("uncertain");
  expect(readMcpOAuthFlow(initial.serverId)).toBeUndefined();
});
it("drops transient input across view changes and changing completion input cancels its preflight", async () => {
  await begin();
  await input(0, "secret-code");
  await input(1, state);
  await render(started, "other");
  await render(started);
  expect(root!.root.findAllByType("input").map((node) => node.props.value)).toEqual(["", ""]);
  await input(0, "secret-code");
  await input(1, state);
  await click("Review authorization completion");
  const queuedInput = root!.root.findAllByType("input")[0]!.props.onChange;
  const pending = deferred<McpServerRecord>();
  api.fetchMcpServer.mockReturnValueOnce(pending.promise);
  await click("Complete reviewed authorization");
  await act(async () => queuedInput({ target: { value: "newer-code" } }));
  await act(async () => pending.resolve(started));
  expect(api.completeReviewedMcpOAuth).not.toHaveBeenCalled();
});
it.each([
  "state",
  "review",
  "nonce",
  "configuration",
  "readback",
  "auth",
  "unchanged-binding",
  "invalid-binding",
  "unchanged-revision",
])(
  "retains uncertainty for mismatched completion %s",
  async (mismatch) => {
    await begin();
    const receipt = { version: 1 as const, reviewed: review(started), state, server: structuredClone(saved) };
    if (mismatch === "state") receipt.state = "22222222-2222-4222-8222-222222222222";
    if (mismatch === "review") receipt.reviewed.expectedRevision = "f".repeat(64);
    if (mismatch === "nonce") receipt.server.connectionRevision = "f".repeat(64);
    if (mismatch === "configuration") receipt.server.url = "https://other.invalid/mcp";
    if (mismatch === "auth") receipt.server.authState = { authType: "oauth2", readiness: "needs_auth" };
    if (mismatch === "unchanged-binding") receipt.server.configurationBindingId = started.configurationBindingId;
    if (mismatch === "invalid-binding") receipt.server.configurationBindingId = "invalid";
    if (mismatch === "unchanged-revision") receipt.server.revision = started.revision;
    api.completeReviewedMcpOAuth.mockImplementation(async () => {
      api.fetchMcpServer.mockResolvedValue(mismatch === "readback" ? { ...saved, label: "Peer" } : receipt.server);
      return receipt;
    });
    expect(
      (
        await commitMcpOAuth({
          reviewed: started,
          action: "complete",
          code: "secret-code",
          state,
          isCurrent: () => true,
          onDispatch: () => undefined,
        })
      ).status,
    ).toBe("uncertain");
    expect(readMcpServerAttempt(initial.serverId).phase).toBe("uncertain");
  },
);
it.each(["stale", "committed", "old-gateway"])(
  "releases only a source-owned noncommitted rejection (%s)",
  async (kind) => {
    api.startReviewedMcpOAuth.mockRejectedValueOnce(
      new ApiRequestError("request failed", {
        kind: "http",
        status: kind === "old-gateway" ? 404 : 409,
        method: "POST",
        path: "/api/v1/mcp/servers/fixture/oauth/start-reviewed",
        body:
          kind === "old-gateway"
            ? { message: "Route not found" }
            : {
                code: "WRITE_CONFLICT",
                details: { reason: "MCP_SERVER_REVIEW_REQUIRED" },
                ...(kind === "committed" ? { mutationCommitted: true } : {}),
              },
      }),
    );
    expect(
      (await commitMcpOAuth({ reviewed: initial, action: "start", isCurrent: () => true, onDispatch: () => undefined }))
        .status,
    ).toBe(kind === "stale" ? "conflict" : "uncertain");
    expect(api.connectReviewedMcpServer).not.toHaveBeenCalled();
    expect(api.completeReviewedMcpOAuth).not.toHaveBeenCalled();
  },
);
