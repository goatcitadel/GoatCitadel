// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OnboardingBootstrapInput } from "@goatcitadel/contracts";
import { FirstRunAdvanced } from "./FirstRunAdvanced";
import { onboardingFixture } from "../../../features/native-routes/settings/onboarding.test-support";
import { gatewayAuthSettingsFixture } from "../../../features/native-routes/settings/gateway-auth.test-support";
import { demoFixture } from "../../../features/native-routes/settings/demo-bootstrap.test-support";
import { __resetSessionDraftsForTests } from "../../../features/native-routes/library/session-drafts";
import { __resetOnboardingAttemptsForTests } from "../../../features/native-routes/settings/onboarding-completion-state";
import { __resetDemoReceiptsForTests } from "../../../features/native-routes/settings/demo-bootstrap-state";
const api = vi.hoisted(() => ({
  fetchSettings: vi.fn(),
  fetchOnboardingState: vi.fn(),
  bootstrapOnboarding: vi.fn(),
  fetchDemoState: vi.fn(),
  bootstrapDemo: vi.fn(),
  fetchAgenticRuns: vi.fn(),
  fetchEvidenceEnvelopes: vi.fn(),
  navigate: vi.fn(),
}));
vi.mock("@goatcitadel/mission-control-shared/api/client", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  ...api,
}));
vi.mock("@goatcitadel/mission-control-shared/state/ui-preferences", () => ({
  useUiPreferences: () => ({ setActiveWorkspaceId: vi.fn(), setActiveCitadelId: vi.fn() }),
}));
vi.mock("../../app/use-cockpit-route", () => ({ useCockpitRoute: () => ({ navigate: api.navigate }) }));
let root: Root, container: HTMLDivElement, client: QueryClient, state: ReturnType<typeof onboardingFixture>;
const button = (name: string) =>
  [...document.querySelectorAll("button")].find((item) => item.textContent?.trim() === name)!;
async function click(name: string) {
  await act(async () => button(name).click());
}
async function render() {
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <FirstRunAdvanced workspaceId="workspace-a" />
      </QueryClientProvider>,
    ),
  );
}
async function open() {
  await click("Advanced setup and evidence");
  await vi.waitFor(() => expect(button("Review defaults").disabled).toBe(false));
}
beforeEach(() => {
  vi.resetAllMocks();
  state = onboardingFixture();
  api.fetchOnboardingState.mockImplementation(async () => structuredClone(state));
  api.fetchSettings.mockImplementation(async () => ({ ...gatewayAuthSettingsFixture(), ...state.settings }));
  api.fetchDemoState.mockResolvedValue(demoFixture().empty);
  api.fetchAgenticRuns.mockResolvedValue({ items: [] });
  api.fetchEvidenceEnvelopes.mockResolvedValue({ items: [] });
  api.bootstrapOnboarding.mockImplementation(async (input: OnboardingBootstrapInput) => {
    state = {
      ...state,
      settings: {
        ...state.settings,
        revision: input.expectedRevision + 1,
        toolApprovalMode: input.toolApprovalMode!,
        budgetMode: input.budgetMode!,
        networkAllowlist: input.networkAllowlist!,
        auth: { ...state.settings.auth, allowLoopbackBypass: false },
      },
    };
    return { state: structuredClone(state), appliedAt: "2026-09-30T12:00:00.000Z" };
  });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  client.clear();
  __resetSessionDraftsForTests();
  __resetOnboardingAttemptsForTests();
  __resetDemoReceiptsForTests();
});
describe("native advanced first-run disclosure", () => {
  it("keeps advanced owners and reads out of the primary initial flow", async () => {
    await render();
    expect(button("Advanced setup and evidence").getAttribute("aria-expanded")).toBe("false");
    expect(api.fetchSettings).not.toHaveBeenCalled();
    expect(api.fetchDemoState).not.toHaveBeenCalled();
    await open();
    expect(container.textContent).toContain("not bound to this workspace");
    expect(container.textContent).toContain("not observed");
  });
  it("shows exact revision and auth consequence, cancels with zero writes, then confirms through the owner", async () => {
    await render();
    await open();
    await click("Review defaults");
    const dialog = document.querySelector('[role="dialog"]')!;
    expect(dialog.textContent).toContain("Loopback auth bypass: off");
    expect(dialog.textContent).toContain("Revision: 41");
    await click("Cancel");
    expect(api.bootstrapOnboarding).not.toHaveBeenCalled();
    await click("Review defaults");
    await click("Confirm defaults");
    expect(api.bootstrapOnboarding).toHaveBeenCalledTimes(1);
    expect(state.completed).toBe(false);
    expect(api.navigate).not.toHaveBeenCalled();
  });
  it("reviews demo side effects without executing on cancel and keeps evidence failures unavailable", async () => {
    api.fetchAgenticRuns.mockRejectedValue(new Error("unavailable"));
    api.fetchEvidenceEnvelopes.mockRejectedValue(new Error("unavailable"));
    await render();
    await open();
    await click("Review demo preparation");
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain("durable memory example");
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain("no revision guard");
    await click("Cancel");
    expect(api.bootstrapDemo).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Recent run evidence is unavailable");
    expect(container.textContent).toContain("Evidence envelopes are unavailable");
  });
});
