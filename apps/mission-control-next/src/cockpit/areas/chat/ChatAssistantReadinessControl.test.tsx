// @vitest-environment happy-dom
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vitest";
import type { AssistantReadinessResponse, ChangePlanRecord } from "@goatcitadel/contracts";
const api = vi.hoisted(() => ({ read: vi.fn(), create: vi.fn(), confirm: vi.fn(), fetch: vi.fn(), navigate: vi.fn() }));
vi.mock("@goatcitadel/mission-control-shared/api/assistant-readiness", () => ({
  fetchAssistantReadiness: api.read,
  prepareAssistantSetup: api.create,
}));
vi.mock("@goatcitadel/mission-control-shared/api/chat", () => ({
  createChangePlan: api.create,
  confirmChangePlan: api.confirm,
  fetchChangePlan: api.fetch,
}));
vi.mock("@goatcitadel/mission-control-shared/state/ui-preferences", () => ({
  useUiPreferences: () => ({ activeCitadelId: "local", activeWorkspaceId: "A" }),
}));
vi.mock("../../app/use-cockpit-route", () => ({ useCockpitRoute: () => ({ navigate: api.navigate }) }));
vi.mock("../settings/SettingsApprovalDialog", () => ({ SettingsApprovalDialog: () => null }));
vi.mock("../../../features/native-routes/settings/use-settings-approval-continuation", () => ({
  useSettingsApprovalContinuation: () => ({ continueApproved: async () => false, visible: false, disabled: true }),
}));
vi.mock("@goatcitadel/mission-control-shared/components/chat/ChatChangePlanActionDialog", () => ({
  ChatChangePlanActionDialog: (props: Record<string, unknown>) => <div data-review-dialog {...props} />,
}));
import { ChatAssistantReadinessControl } from "./ChatAssistantReadinessControl";
import { ApiRequestError } from "@goatcitadel/mission-control-shared/api/client";
const action = {
  kind: "review_change_plan",
  href: "/settings/advanced",
  label: "Review memory setup",
  request: {
    kind: "runtime_configuration",
    change: { operation: "feature_flag", flag: "memoryLifecycleAdminV1Enabled", enabled: true },
  },
} as const;
const response = {
  version: 1,
  sessionId: "s",
  workspaceId: "A",
  configRevision: 4,
  sourceHash: "source",
  items: [
    {
      id: "memory",
      label: "Reviewed memory",
      state: "disabled",
      scope: "installation",
      reasons: ["memory_administration_disabled"],
      nextAction: action,
    },
  ],
  learning: { canExtractMemory: false, canDraftSkill: false, provider: { state: "ready" }, budget: { state: "ready" } },
  indexedRecall: { state: "disabled" },
} as AssistantReadinessResponse;
let tree: ReactTestRenderer, client: QueryClient;
afterEach(async () => {
  if (tree) await act(async () => tree.unmount());
  client?.clear();
  vi.resetAllMocks();
});
async function mount(sessionId = "s") {
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  await act(async () => {
    tree = create(
      <QueryClientProvider client={client}>
        <ChatAssistantReadinessControl sessionId={sessionId} workspaceId="A" onMemoryPreference={async () => {}} />
      </QueryClientProvider>,
    );
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}
it("views without mutation, reviews exact setup and sends the current revision and nonce", async () => {
  api.read.mockResolvedValue(response);
  const plan = {
    planId: "p",
    revision: 2,
    intentHash: "intent",
    status: "awaiting_confirmation",
    origin: { workspaceId: "A", sessionId: "s" },
    requiredAction: { kind: "confirmation", actionNonce: "nonce", actionId: "a" },
    request: action.request,
  } as ChangePlanRecord;
  api.create.mockResolvedValue(plan);
  api.fetch.mockResolvedValue(plan);
  api.confirm.mockResolvedValue({
    ...plan,
    revision: 3,
    status: "applied",
    requiredAction: undefined,
    result: { summary: "Applied" },
  });
  await mount();
  expect(api.create).not.toHaveBeenCalled();
  await act(async () => tree.root.findByProps({ "data-readiness-action": "memory" }).props.onClick());
  expect(api.create).toHaveBeenCalledWith(
    expect.objectContaining({
      sessionId: "s",
      workspaceId: "A",
      itemId: "memory",
      expectedSourceHash: response.sourceHash,
    }),
  );
  const dialog = tree.root.findByProps({ "data-review-dialog": true });
  await act(async () => dialog.props.onConfirm(dialog.props.plan));
  expect(api.confirm).toHaveBeenCalledWith(
    "p",
    { sessionId: "s", workspaceId: "A" },
    { expectedRevision: 2, actionNonce: "nonce" },
  );
});
it("rejects a setup response from another workspace instead of offering its review", async () => {
  api.read.mockResolvedValue(response);
  api.create.mockResolvedValue({ planId: "foreign", origin: { workspaceId: "B", sessionId: "s" } });
  await mount();
  await act(async () => tree.root.findByProps({ "data-readiness-action": "memory" }).props.onClick());
  expect(tree.root.findByProps({ "data-review-dialog": true }).props.plan).toBeNull();
  expect(JSON.stringify(tree.toJSON())).toContain("scope changed");
  expect(api.confirm).not.toHaveBeenCalled();
});
it("makes a prepared review actionable while its read-only readiness refresh is still pending",async()=>{
  let release!:(value:AssistantReadinessResponse)=>void;
  const refresh=new Promise<AssistantReadinessResponse>(resolve=>{release=resolve;});
  api.read.mockResolvedValueOnce(response).mockReturnValue(refresh);
  const plan={planId:"p",revision:1,intentHash:"intent",status:"awaiting_confirmation",origin:{workspaceId:"A",sessionId:"s"},request:action.request,requiredAction:{kind:"confirmation",actionNonce:"nonce"}} as ChangePlanRecord;
  api.create.mockResolvedValue(plan);api.fetch.mockResolvedValue(plan);await mount();
  let operation:Promise<void>|undefined;
  await act(async()=>{operation=tree.root.findByProps({"data-readiness-action":"memory"}).props.onClick();await new Promise(resolve=>setTimeout(resolve,20));});
  try{const dialog=tree.root.findByProps({"data-review-dialog":true});expect(dialog.props.plan?.planId).toBe("p");expect(dialog.props.pending).toBe(false);}
  finally{release(response);await act(async()=>{await operation;});}
});
it("stops presenting cached readiness as current after a refresh fails",async()=>{
  const ready={...response,items:response.items.map(item=>({...item,state:"ready" as const,reasons:[],nextAction:undefined}))};
  api.read.mockResolvedValueOnce(ready).mockRejectedValue(new ApiRequestError("The readiness owner is temporarily unavailable",{kind:"http",status:503,method:"GET",path:"/api/v1/chat/sessions/s/assistant-readiness"}));
  await mount();expect(JSON.stringify(tree.toJSON())).toContain("Reviewed memory");
  await act(async()=>{await tree.root.findByProps({"data-readiness-retry":true}).props.onClick();await new Promise(resolve=>setTimeout(resolve,20));});
  await vi.waitFor(()=>expect(tree.root.findAllByProps({role:"alert"}).length).toBeGreaterThan(0));
  expect(JSON.stringify(tree.toJSON())).toContain("Reviewed memory");
  expect(JSON.stringify(tree.toJSON())).toContain('"Unavailable"');
  expect(JSON.stringify(tree.toJSON())).not.toContain('"Ready"');
  expect(tree.root.findByProps({"data-readiness-retry":true}).props.disabled).not.toBe(true);
  api.read.mockResolvedValue(ready);await act(async()=>{tree.root.findByProps({"data-readiness-retry":true}).props.onClick();});
  await vi.waitFor(()=>expect(tree.root.findAllByProps({role:"alert"})).toHaveLength(0));
  expect(JSON.stringify(tree.toJSON())).toContain("Reviewed memory");expect(api.create).not.toHaveBeenCalled();
});
const occupied = () =>
  new ApiRequestError("An active setup already exists", {
    kind: "http",
    status: 409,
    method: "POST",
    path: "/api/v1/change-plans",
    body: { code: "WRITE_CONFLICT", details: { resourceKind: "change_plan", resourceId: "existing" } },
  });
it("reopens the matching scoped setup review after runtime changes without creating or applying another plan", async () => {
  api.read.mockResolvedValue(response);
  const existing = {
    planId: "existing",
    revision: 4,
    intentHash: "same-intent",
    status: "awaiting_confirmation",
    origin: { workspaceId: "A", sessionId: "s" },
    request: action.request,
    requiredAction: { kind: "confirmation", actionNonce: "current-nonce" },
  } as ChangePlanRecord;
  api.fetch.mockResolvedValue(existing);
  api.create.mockResolvedValue(existing);
  await mount();
  await act(async () => tree.root.findByProps({ "data-readiness-action": "memory" }).props.onClick());
  expect(tree.root.findByProps({ "data-review-dialog": true }).props.plan).toEqual(existing);
  expect(api.create).toHaveBeenCalledTimes(1);
  expect(api.confirm).not.toHaveBeenCalled();
});
it.each(["foreign_scope", "different_intent"])("does not substitute an occupied setup with %s", async (kind) => {
  api.read.mockResolvedValue(response);
  api.create.mockResolvedValue({
    planId: "existing",
    origin: { workspaceId: kind === "foreign_scope" ? "B" : "A", sessionId: "s" },
    request: {
      kind: "runtime_configuration",
      change: { operation: "feature_flag", flag: "backgroundSkillDraftsV1Enabled", enabled: true },
    },
  });
  await mount();
  await act(async () => tree.root.findByProps({ "data-readiness-action": "memory" }).props.onClick());
  expect(tree.root.findByProps({ "data-review-dialog": true }).props.plan).toBeNull();
  expect(api.confirm).not.toHaveBeenCalled();
});
it("two immediate setup clicks prepare one review", async () => {
  api.read.mockResolvedValue(response);
  let settle!: (value: unknown) => void;
  api.create.mockReturnValue(
    new Promise((resolve) => {
      settle = resolve;
    }),
  );
  await mount();
  const actionButton = tree.root.findByProps({ "data-readiness-action": "memory" });
  let first: Promise<void>, second: Promise<void>;
  await act(async () => {
    first = actionButton.props.onClick();
    second = actionButton.props.onClick();
    await Promise.resolve();
  });
  expect(api.create).toHaveBeenCalledTimes(1);
  await act(async () => {
    settle({ planId: "p", origin: { workspaceId: "A", sessionId: "s" } });
    await Promise.all([first, second]);
  });
});
it("a known ended review permits a fresh explicit review while an unconfirmed creation keeps the same identity", async () => {
  api.read.mockResolvedValue(response);
  api.create.mockRejectedValueOnce(new Error("reply lost"));
  await mount();
  const click = () => tree.root.findByProps({ "data-readiness-action": "memory" }).props.onClick();
  await act(async () => {
    await click();
  });
  const uncertain = api.create.mock.calls[0]![0];
  api.create.mockResolvedValue({
    planId: "old",
    revision: 2,
    status: "failed",
    origin: { workspaceId: "A", sessionId: "s" },
    request: action.request,
  });
  await act(async () => {
    await click();
  });
  expect(api.create.mock.calls[1]![0].operationId).toBe(uncertain.operationId);
  api.create.mockResolvedValue({
    planId: "fresh",
    revision: 1,
    status: "awaiting_confirmation",
    origin: { workspaceId: "A", sessionId: "s" },
    request: action.request,
  });
  await act(async () => {
    await click();
  });
  expect(api.create.mock.calls[2]![0].operationId).not.toBe(uncertain.operationId);
  expect(api.confirm).not.toHaveBeenCalled();
});
