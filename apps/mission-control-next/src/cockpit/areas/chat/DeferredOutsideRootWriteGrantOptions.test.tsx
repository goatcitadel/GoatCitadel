// @vitest-environment happy-dom
import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ApprovalRequest } from "@goatcitadel/contracts";
import { refuseNetwork } from "../../../test/refuse-network";

const identity = vi.hoisted(() => ({ gateway: "http://gateway-a", caller: 1, access: 1, workspace: "workspace-a" }));
const loading = vi.hoisted(() => ({ wait: vi.fn<() => Promise<void>>() }));
const grantRendered = vi.hoisted(() => vi.fn());
const decide = vi.hoisted(() => vi.fn());
vi.mock("@goatcitadel/mission-control-shared/api/client-core", () => ({ getGatewayApiBaseUrl: () => identity.gateway }));
vi.mock("@goatcitadel/mission-control-shared/api/access-scope", () => ({
  getGatewayCallerScope: () => `caller-${identity.caller}`,
  getGatewayCallerScopeRevision: () => identity.caller,
  getGatewayAccessRevision: () => identity.access,
  subscribeGatewayCallerScope: () => () => {},
  subscribeGatewayAccessChange: () => () => {},
}));
vi.mock("@goatcitadel/mission-control-shared/state/ui-preferences", () => ({ useUiPreferences: () => ({ activeWorkspaceId: identity.workspace }) }));
vi.mock("@goatcitadel/mission-control-shared/api/client", () => ({ approveChatTool: decide }));
vi.mock("@goatcitadel/mission-control-shared/api/workspaces", () => ({ fetchWorkspaces: vi.fn(async () => ({ items: [] })) }));
refuseNetwork();
let Deferred: typeof import("./DeferredOutsideRootWriteGrantOptions").DeferredOutsideRootWriteGrantOptions;
let root: Root, host: HTMLDivElement, client: QueryClient;
let props: ComponentProps<typeof Deferred>;
function gate() {
  let resolve!: () => void;
  let reject!: (cause: Error) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  loading.wait.mockReturnValueOnce(promise);
  return { resolve, reject };
}
async function render() {
  await act(async () => root.render(<QueryClientProvider client={client}><Deferred {...props} /></QueryClientProvider>));
}
beforeEach(async () => {
  vi.resetModules();
  Object.assign(identity, { gateway: "http://gateway-a", caller: 1, access: 1, workspace: "workspace-a" });
  loading.wait.mockReset().mockResolvedValue(undefined);
  grantRendered.mockReset();
  decide.mockReset();
  vi.doMock("./OutsideRootWriteGrantOptions", async (importOriginal) => {
    await loading.wait();
    const actual = await importOriginal<typeof import("./OutsideRootWriteGrantOptions")>();
    return { ...actual, OutsideRootWriteGrantOptions: (current: ComponentProps<typeof actual.OutsideRootWriteGrantOptions>) => {
      grantRendered(current);
      return <actual.OutsideRootWriteGrantOptions {...current} />;
    } };
  });
  Deferred = (await import("./DeferredOutsideRootWriteGrantOptions")).DeferredOutsideRootWriteGrantOptions;
  const approval: ApprovalRequest = {
    approvalId: "approval-a", kind: "tool_invoke", status: "pending", riskLevel: "safe", payload: {},
    preview: { targets: ["C:/Scratch/report/out.txt"], outsideRootWrite: {
      kind: "outside_root_write", targets: ["C:/Scratch/report/out.txt"],
      candidates: [{ rootId: "owr_0123456789abcdef", path: "C:/Scratch/report" }],
      durations: ["15m", "1h", "8h"], defaultDuration: "1h",
    } },
    linkage: { workspaceId: "workspace-a", sessionId: "session-a" },
    createdAt: "2026-10-01T00:00:00Z", explanationStatus: "not_requested",
  };
  props = { approval, workspaceId: "workspace-a", sessionId: "session-a", onResolved: vi.fn() };
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  await vi.dynamicImportSettled();
  expect(decide).not.toHaveBeenCalled();
  client.clear(); host.remove(); vi.doUnmock("./OutsideRootWriteGrantOptions");
});
it("keeps a rejected grant load local, sends no decision, and permits retry", async () => {
  const pending = gate(); await render();
  expect(host.textContent).toContain("Loading folder options");
  await act(async () => pending.reject(new Error("chunk unavailable")));
  expect(host.textContent).toContain("You can still approve this write once or deny it");
  expect(host.querySelectorAll("button")).toHaveLength(1);
  const retry = host.querySelector<HTMLButtonElement>("button");
  expect(retry?.textContent).toBe("Try folder options again");
  await act(async () => retry?.click());
  // Rejection happened before importOriginal; this is the first real owner graph load.
  // Settle that import rather than treating its cold transform as a UI polling failure.
  await vi.dynamicImportSettled();
  await vi.waitFor(() => expect(host.textContent).toContain("Or approve and open a folder"));
  expect(props.onResolved).not.toHaveBeenCalled();
});
it.each(["record", "workspace", "session", "caller", "access", "gateway", "active workspace"] as const)(
  "loads only the current eligible owner after %s replacement", async (change) => {
    const pending = gate(); await render();
    if (change === "record") props = { ...props, approval: { ...props.approval, createdAt: "2026-10-02T00:00:00Z" } };
    if (change === "workspace") props = { ...props, workspaceId: "workspace-b" };
    if (change === "session") props = { ...props, sessionId: "session-b" };
    if (change === "caller") identity.caller += 1;
    if (change === "access") identity.access += 1;
    if (change === "gateway") identity.gateway = "http://gateway-b";
    if (change === "active workspace") identity.workspace = "workspace-b";
    props = { ...props, onResolved: vi.fn() };
    await render();
    expect(host.textContent).toContain("Loading folder options");
    expect(grantRendered).not.toHaveBeenCalled();
    await act(async () => pending.resolve());
    await vi.waitFor(() => expect(grantRendered).toHaveBeenCalled());
    for (const [rendered] of grantRendered.mock.calls) expect(rendered).toEqual(props);
    expect(host.textContent).not.toContain("Folder options could not load");
    expect(props.onResolved).not.toHaveBeenCalled();
  },
);
it("does not revive an earlier record through A to B to A while loading", async () => {
  const pending = gate(); const original = props; await render();
  props = { ...props, approval: { ...props.approval, createdAt: "2026-10-02T00:00:00Z" } }; await render();
  props = { ...original, onResolved: vi.fn() }; await render();
  await act(async () => pending.resolve());
  await vi.waitFor(() => expect(host.textContent).toContain("Or approve and open a folder"));
  expect(loading.wait).toHaveBeenCalledTimes(1);
  for (const [rendered] of grantRendered.mock.calls) expect(rendered).toEqual(props);
  expect(props.onResolved).not.toHaveBeenCalled();
});
it("does not mount late grant code for an ineligible replacement", async () => {
  const pending = gate(); await render();
  props = { ...props, approval: { ...props.approval, preview: {} } };
  await render(); await act(async () => pending.resolve());
  expect(host.innerHTML).toBe("");
  expect(grantRendered).not.toHaveBeenCalled();
  expect(props.onResolved).not.toHaveBeenCalled();
});
it.each(["caller", "access", "gateway"] as const)("ignores delayed failure after %s changes before a render", async (change) => {
  const pending = gate(); await render();
  if (change === "caller") identity.caller += 1;
  if (change === "access") identity.access += 1;
  if (change === "gateway") identity.gateway = "http://gateway-b";
  await act(async () => pending.reject(new Error("old scope chunk unavailable")));
  expect(host.textContent).toContain("Loading folder options");
  expect(host.textContent).not.toContain("Try folder options again");
  expect(grantRendered).not.toHaveBeenCalled();
  expect(props.onResolved).not.toHaveBeenCalled();
  await render();
  await vi.waitFor(() => expect(host.textContent).toContain("Or approve and open a folder"));
  expect(props.onResolved).not.toHaveBeenCalled();
});
it("does not publish a delayed grant after unmount", async () => {
  const pending = gate(); await render();
  await act(async () => root.render(null));
  await act(async () => pending.resolve());
  expect(host.innerHTML).toBe(""); expect(props.onResolved).not.toHaveBeenCalled();
  expect(grantRendered).not.toHaveBeenCalled();
});
