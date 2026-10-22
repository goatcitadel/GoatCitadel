// @vitest-environment happy-dom
import { act, type ComponentProps, type ReactNode } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConfirmModal } from "@goatcitadel/mission-control-shared/components/ConfirmModal";
import { __resetSessionDraftsForTests } from "../../../features/native-routes/library/session-drafts";
import { __resetAuthAttemptsForTests } from "../../../features/native-routes/settings/gateway-auth-state";
import { __resetSettingsChangesForTests } from "../../../features/native-routes/settings/use-settings-change";
import { GatewayAuthSettings } from "./GatewayAuthSettings";
import type { ChangePlanRecord } from "@goatcitadel/contracts";
import {
  awaitingLlamaApproval,
  llamaPlanFixture,
} from "../../../features/native-routes/settings/llama-setup.test-support";
const api = vi.hoisted(() => ({
  fetchSettings: vi.fn(),
  fetchChangePlan: vi.fn(),
  patchGatewayAuthSettings: vi.fn(),
  navigate: vi.fn(),
}));
vi.mock("@goatcitadel/mission-control-shared/api/client", () => ({ ...api, isApiRequestError: () => false }));
// Each owner write reports the attempt it dispatched, as the real capture would for its Gateway route.
const attempts = vi.hoisted(() => ({ paths: [] as string[], read: vi.fn(), signOut: vi.fn() }));
vi.mock("@goatcitadel/mission-control-shared/api/client-core", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  clearGatewayAuthState: attempts.signOut,
  captureMutationAttempt: (dispatch: () => Promise<unknown>, onAttempt: (attempt: unknown) => void) => {
    const path = attempts.paths.shift();
    if (path) onAttempt({ attemptKey: "6f1c2b3a-4d5e-4f60-8a7b-9c0d1e2f3a4b", method: "PATCH", path });
    return dispatch();
  },
}));
vi.mock("@goatcitadel/mission-control-shared/api/mutation-attempts", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  fetchMutationAttempt: attempts.read,
}));
vi.mock("../../app/use-cockpit-route", () => ({ useCockpitRoute: () => ({ navigate: api.navigate }) }));
const modals = new Map<string, ComponentProps<typeof ConfirmModal>>();
vi.mock("@goatcitadel/mission-control-shared/components/ConfirmModal", () => ({
  ConfirmModal: (props: ComponentProps<typeof ConfirmModal>) => {
    modals.set(props.title, props);
    return null;
  },
}));
let renderer: ReactTestRenderer, client: QueryClient;
let owner = {
  revision: 41,
  auth: { mode: "token", allowLoopbackBypass: false, tokenConfigured: true, basicConfigured: false },
};
const button = (name: string) => renderer.root.findAllByType("button").find((node) => node.children.join("") === name)!;
async function render(show = true) {
  await act(async () => {
    const tree = <QueryClientProvider client={client}>{show ? <GatewayAuthSettings /> : null}</QueryClientProvider>;
    if (renderer) renderer.update(tree);
    else renderer = create(tree);
  });
}
async function click(name: string) {
  await act(async () => button(name).props.onClick());
}
beforeEach(async () => {
  vi.resetAllMocks();
  owner = {
    revision: 41,
    auth: { mode: "token", allowLoopbackBypass: false, tokenConfigured: true, basicConfigured: false },
  };
  api.fetchSettings.mockImplementation(async () => structuredClone(owner));
  api.patchGatewayAuthSettings.mockImplementation(async (input: { allowLoopbackBypass: boolean }) => {
    owner = { revision: 42, auth: { ...owner.auth, allowLoopbackBypass: input.allowLoopbackBypass } };
    return { revision: 42, ...owner.auth };
  });
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await render();
  await vi.waitFor(() => expect(button("Configure access").props.disabled).toBe(false));
});
afterEach(async () => {
  await act(async () => renderer.unmount());
  renderer = undefined as unknown as ReactTestRenderer;
  client.clear();
  modals.clear();
  __resetSessionDraftsForTests();
  __resetAuthAttemptsForTests();
  __resetSettingsChangesForTests();
});
describe("native Gateway authentication", () => {
  it("warns that open access lets anyone change settings, with a way to set up sign-in (ST-N08)", async () => {
    const warning = "Anyone who can reach this app can change settings. Set up sign-in.";
    expect(JSON.stringify(renderer.toJSON())).not.toContain(warning);
    owner = { ...owner, auth: { ...owner.auth, mode: "none" } };
    await act(async () => client.invalidateQueries());
    await vi.waitFor(() => expect(JSON.stringify(renderer.toJSON())).toContain(warning));
    // The warning names the control that fixes it, which sits right below it in this section.
    expect(JSON.stringify(renderer.toJSON())).toContain("Use Configure access below.");
    expect(button("Configure access")).toBeDefined();
  });
  it("renders installation scope, requires explicit review, and saves through the shared owner", async () => {
    expect(JSON.stringify(renderer.toJSON())).toContain("every workspace");
    await click("Configure access");
    expect(
      renderer.root.findAllByType("button").every((node) => !String(node.props.className).includes("mc-next-button")),
    ).toBe(true);
    await act(async () =>
      renderer.root.findByProps({ type: "checkbox" }).props.onChange({ target: { checked: true } }),
    );
    await click("Save access settings");
    const review = modals.get("Apply Gateway authentication changes?")!;
    expect(review.open).toBe(true);
    expect(review.message).toContain("revision 41");
    expect(review.message).toContain("disabled → enabled");
    expect(api.patchGatewayAuthSettings).not.toHaveBeenCalled();
    await act(async () => review.onCancel());
    expect(api.patchGatewayAuthSettings).not.toHaveBeenCalled();
    await click("Save access settings");
    await act(async () => modals.get("Apply Gateway authentication changes?")!.onConfirm());
    await vi.waitFor(() => expect(JSON.stringify(renderer.toJSON())).toContain("saved and confirmed"));
    expect(api.patchGatewayAuthSettings).toHaveBeenCalledExactlyOnceWith({
      expectedRevision: 41,
      mode: "token",
      allowLoopbackBypass: true,
    });
  });
  it("retains an unknown save lock after native panel navigation", async () => {
    api.patchGatewayAuthSettings.mockRejectedValue(new Error("lost response"));
    await click("Configure access");
    await act(async () =>
      renderer.root.findByProps({ type: "checkbox" }).props.onChange({ target: { checked: true } }),
    );
    await click("Save access settings");
    await act(async () => modals.get("Apply Gateway authentication changes?")!.onConfirm());
    await render(false);
    await render();
    await click("Configure access · Unsaved");
    expect(button("Save access settings").props.disabled).toBe(true);
    expect(JSON.stringify(renderer.toJSON())).toContain("outcome is uncertain");
    expect(api.patchGatewayAuthSettings).toHaveBeenCalledOnce();
  });
  it("checks a lost save's outcome from the Gateway's record and releases the lock after readback", async () => {
    attempts.paths.length = 0;
    attempts.paths.push("/api/v1/auth/settings");
    api.patchGatewayAuthSettings.mockRejectedValue(new Error("lost response"));
    await click("Configure access");
    await act(async () =>
      renderer.root.findByProps({ type: "checkbox" }).props.onChange({ target: { checked: true } }),
    );
    await click("Save access settings");
    await act(async () => modals.get("Apply Gateway authentication changes?")!.onConfirm());
    expect(JSON.stringify(renderer.toJSON())).toContain("outcome is uncertain");
    attempts.read.mockResolvedValue({ status: "completed", claimExpired: false });
    await click("Check outcome");
    expect(JSON.stringify(renderer.toJSON())).not.toContain("outcome is uncertain");
    expect(JSON.stringify(renderer.toJSON())).toContain("recorded this authentication change as processed");
    expect(api.patchGatewayAuthSettings).toHaveBeenCalledOnce();
  });
});

it.each([false, true])(
  "offers the exact auth specialist only for the actual matching owner receipt (foreign=%s)",
  async (foreign) => {
    const base = awaitingLlamaApproval(llamaPlanFixture(undefined, "default"));
    const plan: ChangePlanRecord = {
      ...base,
      origin: { surface: "settings", workspaceId: foreign ? "foreign" : "default" },
      target: { ownerId: "runtime_settings", resourceId: "gateway_auth_configuration", expectedRevision: 41 },
      request: {
        kind: "runtime_configuration",
        change: { operation: "gateway_auth_configuration", mode: "token", allowLoopbackBypass: true },
      },
    };
    api.fetchChangePlan.mockResolvedValue(plan);
    api.patchGatewayAuthSettings.mockResolvedValue({
      ...owner.auth,
      revision: 41,
      changePlanReceipt: {
        planId: plan.planId,
        revision: plan.revision,
        status: plan.status,
        risk: plan.risk,
        requiredAction: plan.requiredAction,
        summary: "Approval required",
      },
    });
    await click("Configure access");
    await act(async () =>
      renderer.root.findByProps({ type: "checkbox" }).props.onChange({ target: { checked: true } }),
    );
    await click("Save access settings");
    await act(async () => modals.get("Apply Gateway authentication changes?")!.onConfirm());
    if (foreign) {
      await vi.waitFor(() => expect(JSON.stringify(renderer.toJSON())).toContain("outcome is uncertain"));
      expect(
        renderer.root.findAllByType("a").filter((node) => node.children.join("") === "Review required approval"),
      ).toHaveLength(0);
    } else {
      await vi.waitFor(() =>
        expect(
          renderer.root.findAllByType("a").some((node) => node.children.join("") === "Review required approval"),
        ).toBe(true),
      );
      const ownerLink = renderer.root
        .findAllByType("a")
        .find((node) => node.children.join("") === "Review required approval")!;
      const destination = new URL(ownerLink.props.href, "http://cockpit.invalid");
      expect(destination.pathname).toBe("/inbox");
      expect(destination.searchParams.get("workspaceId")).toBe("default");
      expect(destination.searchParams.get("shell")).toBe("cockpit");
      expect(destination.searchParams.getAll("approvalId")).toEqual(["approval-1"]);
      expect(destination.searchParams.has("shellScope")).toBe(false);
      expect(api.fetchChangePlan).toHaveBeenCalledWith(plan.planId, { workspaceId: "default" });
    }
    expect(api.navigate).not.toHaveBeenCalled();
    expect(api.patchGatewayAuthSettings).toHaveBeenCalledOnce();
  },
);

const access = vi.hoisted(() => ({ actorId: null as string | null }));
vi.mock("../../../app/use-current-access", () => ({
  useCurrentAccess: () => ({
    isSuccess: true,
    data: { actorId: access.actorId, actorSource: "none", operatorAccess: true },
    refetch: vi.fn(),
  }),
}));
vi.mock("../../ui/Dialog", () => ({
  Dialog: ({ open, title, children }: { open: boolean; title: string; children: ReactNode }) =>
    open ? <section aria-label={title}>{children}</section> : null,
}));

describe("native Gateway sign-out", () => {
  afterEach(() => {
    access.actorId = null;
  });
  it("puts a danger sign-out first and keeping access last", async () => {
    access.actorId = "operator-1";
    await render();
    await click("Sign out of this browser");
    const dialog = renderer.root.findByProps({ "aria-label": "Sign out of this browser?" });
    const actions = dialog.findAllByType("button");
    expect(actions.map((node) => node.children.join(""))).toEqual(["Sign out", "Keep access"]);
    expect(String(actions[0]!.props.className)).toContain("border-status-failed");
    expect(String(actions[1]!.props.className)).not.toContain("border-status-failed");
    await click("Keep access");
    expect(attempts.signOut).not.toHaveBeenCalled();
    await click("Sign out of this browser");
    await click("Sign out");
    expect(attempts.signOut).toHaveBeenCalledOnce();
  });
});
