// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OnboardingBootstrapInput } from "@goatcitadel/contracts";
import { FirstRunAdvanced } from "./FirstRunAdvanced";
import { FirstRunDemo } from "./FirstRunDemo";
import { FirstRunVerification } from "./FirstRunVerification";
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
  fetchLlmModels: vi.fn(),
}));
vi.mock("@goatcitadel/mission-control-shared/api/client", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  ...api,
}));
// Model catalog reads stay mocked; the verification panel must not start one for the active model.
vi.mock("@goatcitadel/mission-control-shared/api/platform", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  fetchLlmConfig: async () => ({ providerConfigs: [] }),
  fetchLlmModels: api.fetchLlmModels,
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
  await click("Change installation defaults");
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
    expect(button("Change installation defaults").getAttribute("aria-expanded")).toBe("false");
    // The demo moved to step 1's "Try the demo" choice.
    expect(button("Explore sample records")).toBeUndefined();
    expect(api.fetchSettings).not.toHaveBeenCalled();
    expect(api.fetchDemoState).not.toHaveBeenCalled();
    await open();
    expect(api.fetchDemoState).not.toHaveBeenCalled();
    expect(api.fetchAgenticRuns).not.toHaveBeenCalled();
    expect(api.fetchEvidenceEnvelopes).not.toHaveBeenCalled();
    expect(container.textContent).not.toContain("Verification evidence");
  });
  it("shows exact revision and auth consequence, cancels with zero writes, then confirms through the owner", async () => {
    await render();
    await open();
    await click("Review defaults");
    const dialog = document.querySelector('[role="dialog"]')!;
    expect(dialog.textContent).toContain("Loopback auth bypass: off");
    expect(dialog.textContent).toContain("Version: 41");
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
    await act(async () =>
      root.render(
        <QueryClientProvider client={client}>
          <FirstRunDemo workspaceId="workspace-a" />
        </QueryClientProvider>,
      ),
    );
    await vi.waitFor(() => expect(button("Review demo preparation").disabled).toBe(false));
    await click("Review demo preparation");
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain("durable memory example");
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain("no revision guard");
    await click("Cancel");
    expect(api.bootstrapDemo).not.toHaveBeenCalled();
    expect(api.bootstrapOnboarding).not.toHaveBeenCalled();
    expect(api.fetchAgenticRuns).not.toHaveBeenCalled();
    await act(async () =>
      root.render(
        <QueryClientProvider client={client}>
          <FirstRunVerification />
        </QueryClientProvider>,
      ),
    );
    await vi.waitFor(() => expect(container.textContent).toContain("Recent runs could not load"));
    expect(container.textContent).toContain("Recent runs could not load");
    expect(container.textContent).toContain("Installation records could not load");
  });
});
describe("first-run verification values", () => {
  it("presents readiness values and proof references without raw Gateway codes", async () => {
    state.setupReadiness!.items.push(
      {
        id: "remote_posture",
        label: "Remote posture",
        status: "ready",
        value: "local_trusted",
        detail: "Loopback/local trusted posture is active.",
      },
      { id: "tailnet", label: "Tailnet", status: "ready", value: "not_required", detail: "Tailnet is not required." },
    );
    state.firstRunChecklist = [
      {
        id: "first_chat",
        label: "First Chat",
        status: "complete",
        detail: "A Chat reply was recorded.",
        proofRefs: [
          { kind: "route", label: "Chat", ref: "/chat" },
          { kind: "runtime_evidence", label: "Chat turn trace", ref: "chat.turn_trace" },
        ],
      },
    ];
    await act(async () =>
      root.render(
        <QueryClientProvider client={client}>
          <FirstRunVerification />
        </QueryClientProvider>,
      ),
    );
    await vi.waitFor(() => expect(container.textContent).toContain("Trusted local. Loopback/local trusted posture"));
    expect(container.textContent).toContain("Not needed. Tailnet is not required.");
    expect(container.textContent).toContain("Checked through: Chat, Chat turn trace");
    expect(api.fetchLlmModels).not.toHaveBeenCalled();
    for (const raw of ["local_trusted:", "not_required", "chat.turn_trace", "Provider A: Connection verified"]) {
      expect(container.textContent).not.toContain(raw);
    }
  });
});

it("offers only the safe approval rules in installation defaults (ST-R04)", async () => {
  await render();
  await open();
  const values = [...document.querySelectorAll<HTMLOptionElement>("option")].map((option) => option.value);
  expect(values).not.toContain("bypass");
});

it("shows a saved prompt bypass as the current rule instead of a safe one it is not (ST-R04)", async () => {
  state = { ...state, settings: { ...state.settings, toolApprovalMode: "bypass" } };
  await render();
  await open();
  const select = document.querySelector<HTMLSelectElement>("select")!;
  const selected = select.options[select.selectedIndex]!;
  expect(selected.value).toBe("bypass");
  expect(selected.disabled).toBe(true);
  expect(selected.textContent).toContain("current");
});
