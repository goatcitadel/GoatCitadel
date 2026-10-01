import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SECRET_REDACTION_MARKER, type HookRecord } from "@goatcitadel/contracts";
import { HooksSettings } from "./HooksSettings";
import { Dialog } from "../../ui/Dialog";
import { __resetSessionDraftsForTests } from "../../../features/native-routes/library/session-drafts";
import { __resetIntegrationConnectionMutationsForTests } from "../../../features/native-routes/settings/integration-connection-mutation";
const api = vi.hoisted(() => ({
  createWorkspaceHook: vi.fn(),
  deleteWorkspaceHook: vi.fn(),
  fetchWorkspaceHookRuns: vi.fn(),
  fetchWorkspaceHooks: vi.fn(),
  redriveWorkspaceHookRun: vi.fn(),
  testWorkspaceHook: vi.fn(),
}));
vi.mock("../../../features/native-routes/settings/sections/hooks-api", () => api);
vi.mock("@goatcitadel/mission-control-shared/api/client-core", () => ({
  getGatewayApiBaseUrl: () => "http://fixture",
}));
let root: ReactTestRenderer;
const text = (node: ReactTestInstance): string =>
  node.children.map((child) => (typeof child === "string" ? child : text(child))).join(" ");
const button = (name: string) => {
  const found = root.root.findAllByType("button").find((item) => text(item).replace(/\s+/g, " ").trim() === name);
  if (!found) throw new Error(`Missing ${name}`);
  return found;
};
const hook: HookRecord = {
  hookId: "hook",
  workspaceId: "fixture",
  label: "Observer",
  trigger: "tool.call.after",
  phase: "after",
  mode: "observe",
  enabled: true,
  priority: 100,
  timeoutMs: 5000,
  failPolicy: "open",
  dataScope: "metadata",
  action: { type: "webhook", webhook: { url: SECRET_REDACTION_MARKER, secretRef: "hidden-keychain-reference" } },
  createdAt: "2026-09-30T12:00:00Z",
  updatedAt: "2026-09-30T12:00:00Z",
};
beforeEach(() => {
  vi.resetAllMocks();
  __resetSessionDraftsForTests();
  __resetIntegrationConnectionMutationsForTests();
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw new Error("No real hook transport");
    }),
  );
  api.fetchWorkspaceHooks.mockResolvedValue({ items: [hook] });
  api.fetchWorkspaceHookRuns.mockResolvedValue({ items: [] });
});
afterEach(async () => {
  await act(async () => root?.unmount());
  vi.unstubAllGlobals();
});
it("shows structured owner evidence and requires explicit review for a real test", async () => {
  await act(async () => {
    root = create(<HooksSettings workspaceId="fixture" />);
  });
  await act(async () => button("Observer · tool.call.after · Enabled").props.onClick());
  expect(text(root.root)).toContain("Keychain reference recorded");
  expect(text(root.root)).not.toContain("hidden-keychain-reference");
  expect(root.root.findAllByType("pre")).toHaveLength(0);
  await act(async () => button("Review real test delivery").props.onClick());
  const review = root.root.findAllByType(Dialog).find((item) => item.props.title === "Send a real hook test?");
  expect(review?.props.open).toBe(true);
  expect(review?.props.description).toContain("can affect the destination");
  expect(api.testWorkspaceHook).not.toHaveBeenCalled();
  await act(async () => review?.props.onOpenChange(false));
  expect(api.testWorkspaceHook).not.toHaveBeenCalled();
});
it("keeps new signing input out of review copy and out of a remounted native editor", async () => {
  await act(async () => {
    root = create(<HooksSettings workspaceId="fixture" />);
  });
  await act(async () => button("Register hook").props.onClick());
  for (const [name, value] of [
    ["Hook label", "Native observer"],
    ["HTTPS endpoint", "https://fixture.invalid/private"],
    ["Signing secret", "synthetic-private-input"],
  ])
    await act(async () => root.root.findByProps({ "aria-label": name }).props.onChange({ target: { value } }));
  await act(async () => button("Review hook registration").props.onClick());
  const review = root.root.findAllByType(Dialog).find((item) => item.props.title === "Register this hook?");
  expect(review?.props.description).not.toContain("synthetic-private-input");
  expect(api.createWorkspaceHook).not.toHaveBeenCalled();
  await act(async () => root.unmount());
  await act(async () => {
    root = create(<HooksSettings workspaceId="fixture" />);
  });
  await act(async () => button("Register hook").props.onClick());
  expect(root.root.findByProps({ "aria-label": "Hook label" }).props.value).toBe("Native observer");
  expect(root.root.findByProps({ "aria-label": "Signing secret" }).props.value).toBe("");
  expect(root.root.findByProps({ "aria-label": "HTTPS endpoint" }).props.value).toBe("");
});
