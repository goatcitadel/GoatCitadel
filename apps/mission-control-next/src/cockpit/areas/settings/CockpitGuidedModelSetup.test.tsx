// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OnboardingState } from "@goatcitadel/contracts";
import { onboardingFixture } from "../../../features/native-routes/settings/onboarding.test-support";
import { __resetSessionDraftsForTests, hasSessionDraft } from "../../../features/native-routes/library/session-drafts";
import { CockpitGuidedModelSetup } from "./CockpitGuidedModelSetup";

const mocks = vi.hoisted(() => ({
  catalog: vi.fn(),
  models: vi.fn(),
  reload: vi.fn(),
  plans: vi.fn(),
  create: vi.fn(),
  prefs: { showTechnicalDetails: false },
}));
vi.mock("@goatcitadel/mission-control-shared/hooks/useProviderModelCatalog", () => ({
  useProviderModelCatalog: mocks.catalog,
}));
vi.mock("@goatcitadel/mission-control-shared/api/client", () => ({
  fetchChangePlans: mocks.plans,
  createChangePlan: mocks.create,
  cancelChangePlan: vi.fn(),
  completeChangePlanProviderOAuth: vi.fn(),
  confirmChangePlan: vi.fn(),
  pollChangePlanProviderOAuth: vi.fn(),
  respondToChangePlan: vi.fn(),
  startChangePlanProviderOAuth: vi.fn(),
  submitChangePlanProviderSecret: vi.fn(),
}));
vi.mock("@goatcitadel/mission-control-shared/components/chat/ChatChangePlanActionDialog", () => ({
  ChatChangePlanActionDialog: () => null,
}));
vi.mock("@goatcitadel/mission-control-shared/components/chat/ChatChangePlanCard", () => ({
  ChatChangePlanCard: (props: { plan: { status: string } }) => <p>Plan card: {props.plan.status}</p>,
}));
vi.mock("@goatcitadel/mission-control-shared/state/ui-preferences", () => ({
  useUiPreferences: () => ({ activeWorkspaceId: undefined, showTechnicalDetails: mocks.prefs.showTechnicalDetails }),
}));
vi.mock("../../app/use-cockpit-route", () => ({ useCockpitRoute: () => ({ navigate: vi.fn() }) }));

let root: Root, container: HTMLDivElement, onboarding: OnboardingState;
const button = (label: string) =>
  [...container.querySelectorAll("button")].find((item) => item.textContent?.trim() === label);
const catalog = (status: string, provider: Record<string, unknown> = {}) =>
  mocks.catalog.mockReturnValue({
    providers: [
      {
        providerId: "test",
        label: "Test provider",
        hasApiKey: status === "ready",
        authReadiness: { status },
        defaultModel: "test-model",
        ...provider,
      },
    ],
    config: { defaultThinkingLevel: "standard" },
    loadModelsForProvider: mocks.models,
    reload: mocks.reload,
    loading: false,
  });
const mount = (props: Partial<Parameters<typeof CockpitGuidedModelSetup>[0]> = {}) =>
  act(async () => {
    root.render(
      <CockpitGuidedModelSetup
        onboarding={onboarding}
        reloadOnboarding={async () => {}}
        onEnterChat={() => {}}
        {...props}
      />,
    );
  });
beforeEach(() => {
  vi.resetAllMocks();
  mocks.prefs.showTechnicalDetails = false;
  __resetSessionDraftsForTests();
  onboarding = onboardingFixture();
  onboarding.settings.llm.activeProviderId = "test";
  onboarding.settings.llm.activeModel = "test-model";
  mocks.models.mockResolvedValue(["test-model", "other-model"]);
  mocks.plans.mockResolvedValue({ items: [] });
  mocks.create.mockImplementation(async (input: { request: object }) => ({
    planId: "plan-1",
    status: "completed",
    revision: 1,
    origin: { workspaceId: "default", surface: "settings" },
    request: input.request,
    result: { summary: "Change applied and verified." },
  }));
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("shared guided model setup", () => {
  it("says on first run that a local runtime did not answer after Check connection", async () => {
    catalog("ready", {
      providerId: "test",
      label: "LM Studio",
      baseUrl: "http://127.0.0.1:1234/v1",
      localCostPosture: "zero_cost_local_runtime",
      modelProbeState: "fallback",
      modelProbeWarning: "fetch failed",
      modelRefreshStatus: "fresh",
    });
    await mount({ showSteps: false });
    expect(container.querySelector('[role="status"]')?.textContent).toBe(
      "LM Studio has not answered at http://127.0.0.1:1234/v1. Start it, then check the connection again.",
    );
  });
  it("keeps one always-mounted status line, so a result added later is announced", async () => {
    catalog("ready", {
      label: "LM Studio",
      baseUrl: "http://127.0.0.1:1234/v1",
      localCostPosture: "zero_cost_local_runtime",
      modelProbeState: "not_checked",
    });
    await mount({ showSteps: false });
    const line = container.querySelector('[role="status"]');
    expect(container.querySelectorAll('[role="status"]')).toHaveLength(1);
    catalog("ready", {
      label: "LM Studio",
      baseUrl: "http://127.0.0.1:1234/v1",
      localCostPosture: "zero_cost_local_runtime",
      modelProbeState: "fallback",
    });
    await mount({ showSteps: false });
    expect(container.querySelector('[role="status"]')).toBe(line);
    expect(line?.textContent).toContain("has not answered");
  });
  it("does not repeat the result under the button where the step list already shows it", async () => {
    catalog("ready", {
      label: "LM Studio",
      baseUrl: "http://127.0.0.1:1234/v1",
      localCostPosture: "zero_cost_local_runtime",
      modelProbeState: "fallback",
    });
    await mount();
    const sentence =
      "LM Studio has not answered at http://127.0.0.1:1234/v1. Start it, then check the connection again.";
    expect(container.textContent?.split(sentence)).toHaveLength(2);
    expect(container.querySelector('[role="status"]')?.textContent).toBe("");
  });
  it("keeps the raw reason out of the sentence and inside Technical details", async () => {
    catalog("ready", {
      label: "LM Studio",
      baseUrl: "http://127.0.0.1:1234/v1",
      localCostPosture: "zero_cost_local_runtime",
      modelProbeState: "fallback",
      modelProbeWarning: "fetch failed",
    });
    await mount({ showSteps: false });
    expect(container.textContent).not.toContain("fetch failed");
    mocks.prefs.showTechnicalDetails = true;
    await mount({ showSteps: false });
    expect([...container.querySelectorAll("details")].map((item) => item.textContent).join(" ")).toContain(
      "fetch failed",
    );
    expect(container.querySelector('[role="status"]')?.textContent).not.toContain("fetch failed");
  });
  it("keeps a ready result Ready after its list has gone stale", async () => {
    catalog("ready", {
      label: "LM Studio",
      baseUrl: "http://127.0.0.1:1234/v1",
      localCostPosture: "zero_cost_local_runtime",
      modelProbeState: "ready",
      modelProbeSource: "live",
      modelRefreshStatus: "stale",
    });
    await mount({ showSteps: false });
    expect(container.textContent).toContain("Ready");
    expect(container.textContent).not.toContain("stale");
    expect(container.querySelector('[role="status"]')?.textContent).toBe("");
  });
  it("says a refresh that failed after the runtime had answered did not answer, not that the list is stale", async () => {
    catalog("ready", {
      label: "LM Studio",
      baseUrl: "http://127.0.0.1:1234/v1",
      localCostPosture: "zero_cost_local_runtime",
      modelProbeState: "fallback",
      modelProbeSource: "live",
      modelRefreshStatus: "stale",
      modelRefreshFailed: true,
      modelProbeWarning: "fetch failed",
    });
    await mount({ showSteps: false });
    expect(container.querySelector('[role="status"]')?.textContent).toBe(
      "LM Studio has not answered at http://127.0.0.1:1234/v1. Start it, then check the connection again.",
    );
    expect(container.textContent).not.toContain("stale");
  });
  it("says a check that could not be completed is not a server that is down", async () => {
    catalog("ready", {
      label: "LM Studio",
      baseUrl: "http://127.0.0.1:1234/v1",
      localCostPosture: "zero_cost_local_runtime",
      modelProbeState: "error",
      modelProbeSource: "error_fallback",
    });
    await mount({ showSteps: false });
    expect(container.querySelector('[role="status"]')?.textContent).toBe(
      "The connection check could not be completed. Check the address, then check the connection again.",
    );
  });
  it("shows the result and the notice together on first run", async () => {
    catalog("missing");
    await mount({ showSteps: false });
    await act(async () => button("Connect provider")!.click());
    const text = container.querySelector('[role="status"]')?.textContent;
    expect(text).toContain("Test provider needs a credential.");
    expect(text).toContain("Change applied and verified.");
    expect(container.querySelectorAll('[role="status"]')).toHaveLength(1);
  });
  it("never says a runtime is not running before any check has run", async () => {
    catalog("ready", {
      label: "LM Studio",
      baseUrl: "http://127.0.0.1:1234/v1",
      localCostPosture: "zero_cost_local_runtime",
      modelProbeState: "not_checked",
    });
    await mount();
    expect(container.textContent).not.toMatch(/not running|has not answered|stale/u);
  });
  it("shows no check result while a check has not run, and none once the runtime answered", async () => {
    catalog("ready", {
      label: "LM Studio",
      baseUrl: "http://127.0.0.1:1234/v1",
      localCostPosture: "zero_cost_local_runtime",
      modelProbeState: "not_checked",
    });
    await mount({ showSteps: false });
    expect(container.querySelector('[role="status"]')?.textContent).toBe("");
    catalog("ready", {
      label: "LM Studio",
      baseUrl: "http://127.0.0.1:1234/v1",
      localCostPosture: "zero_cost_local_runtime",
      modelProbeState: "ready",
      modelProbeSource: "live",
    });
    await mount({ showSteps: false });
    expect(container.querySelector('[role="status"]')?.textContent).toBe("");
  });
  it("numbers every step, marks the current one and states each step in words", async () => {
    onboarding.settings.llm.activeModel = "";
    catalog("ready");
    await mount();
    const steps = [...container.querySelectorAll('ol[aria-label="Model setup steps"] > li')];
    expect(steps.map((step) => step.textContent)).toEqual([
      expect.stringMatching(/^Step 1Done.*Connect a provider/u),
      expect.stringMatching(/^Step 2Current.*Confirm your model/u),
      expect.stringMatching(/^Step 3Not started.*Start the first Chat/u),
    ]);
    expect(steps.map((step) => step.getAttribute("aria-current"))).toEqual([null, "step", null]);
  });
  it("is built from cockpit fields: each select is labelled and described, with no Classic classes", async () => {
    catalog("ready");
    await mount();
    const provider = container.querySelector<HTMLSelectElement>("select")!;
    expect(container.querySelector(`label[for="${provider.id}"]`)?.textContent).toBe("Provider or local runtime");
    expect(document.getElementById(provider.getAttribute("aria-describedby")!)?.textContent).toContain(
      "GoatCitadel checks this connection",
    );
    expect(container.querySelector('[class*="mc-next"]')).toBeNull();
  });
  it("connects a provider that is not ready through a provider connection plan", async () => {
    catalog("missing");
    await mount();
    await act(async () => button("Connect provider")!.click());
    expect(mocks.create).toHaveBeenCalledExactlyOnceWith({
      workspaceId: "default",
      surface: "settings",
      request: { kind: "provider_connection", providerId: "test" },
    });
  });
  it("tells Claude Code users to paste a setup-token and names the Claude Code connect action", async () => {
    catalog("missing", { label: "Claude Code (Claude subscription)", authMode: "claude-code-oauth" });
    await mount();
    const provider = container.querySelector<HTMLSelectElement>("select")!;
    const help = document.getElementById(provider.getAttribute("aria-describedby")!)?.textContent;
    expect(help).toContain("claude setup-token");
    expect(help).toContain("may reject");
    expect(button("Connect Claude Code")).toBeDefined();
  });
  it("drops the Claude Code connection hint once the provider is ready", async () => {
    catalog("ready", { label: "Claude Code (Claude subscription)", authMode: "claude-code-oauth" });
    await mount();
    const provider = container.querySelector<HTMLSelectElement>("select")!;
    const help = document.getElementById(provider.getAttribute("aria-describedby")!)?.textContent;
    expect(help).not.toContain("claude setup-token");
    expect(button("Connect Claude Code")).toBeUndefined();
  });
  it("checks the local Claude Code login through a provider connection plan instead of asking for a token", async () => {
    catalog("missing", {
      providerId: "claude-code-cli",
      label: "Claude Code CLI (local login)",
      authMode: "claude-code-cli-login",
      authReadiness: { status: "missing", reasonCode: "claude_cli_logged_out" },
    });
    onboarding.settings.llm.activeProviderId = "claude-code-cli";
    await mount();
    const provider = container.querySelector<HTMLSelectElement>("select")!;
    const help = document.getElementById(provider.getAttribute("aria-describedby")!)?.textContent;
    expect(help).toContain("stores no token");
    expect(container.textContent).toContain("sign in with /login");
    await act(async () => button("Check Claude Code login")!.click());
    expect(mocks.create).toHaveBeenCalledExactlyOnceWith({
      workspaceId: "default",
      surface: "settings",
      request: { kind: "provider_connection", providerId: "claude-code-cli" },
    });
  });
  it("adds the Claude Code CLI provider for a saved config that predates it", async () => {
    catalog("ready");
    await mount();
    const provider = container.querySelector<HTMLSelectElement>("select")!;
    expect([...provider.options].map((option) => option.textContent)).toContain(
      "Claude Code CLI (local login) · not added yet",
    );
    await act(async () => {
      provider.value = "claude-code-cli";
      provider.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(mocks.models).not.toHaveBeenCalledWith("claude-code-cli");
    await act(async () => button("Add Claude Code CLI")!.click());
    expect(mocks.create).toHaveBeenCalledExactlyOnceWith({
      workspaceId: "default",
      surface: "settings",
      request: {
        kind: "provider_connection",
        providerId: "claude-code-cli",
        profile: expect.objectContaining({ apiStyle: "claude-code-cli", authMode: "claude-code-cli-login" }),
      },
    });
  });
  it("starts a new plan instead of reopening a pending plan for a different provider", async () => {
    catalog("missing");
    mocks.plans.mockResolvedValue({
      items: [
        {
          planId: "plan-old",
          kind: "provider_connection",
          status: "awaiting_input",
          revision: 1,
          origin: { workspaceId: "default", surface: "settings" },
          request: { kind: "provider_connection", providerId: "anthropic" },
        },
      ],
    });
    await mount();
    await act(async () => button("Connect provider")!.click());
    expect(mocks.create).toHaveBeenCalledExactlyOnceWith({
      workspaceId: "default",
      surface: "settings",
      request: { kind: "provider_connection", providerId: "test" },
    });
  });
  it("does not offer to add the Claude Code CLI provider when the catalog failed to load", async () => {
    catalog("ready");
    mocks.catalog.mockReturnValue({ ...mocks.catalog(), error: "Gateway unavailable" });
    await mount();
    const provider = container.querySelector<HTMLSelectElement>("select")!;
    expect([...provider.options].map((option) => option.textContent)).not.toContain(
      "Claude Code CLI (local login) · not added yet",
    );
  });
  it("resumes an older active plan for the selected provider instead of creating a duplicate", async () => {
    catalog("missing");
    const plan = (planId: string, providerId: string) => ({
      planId,
      kind: "provider_connection",
      status: "awaiting_input",
      revision: 1,
      origin: { workspaceId: "default", surface: "settings" },
      request: { kind: "provider_connection", providerId },
    });
    mocks.plans.mockResolvedValue({ items: [plan("plan-new", "anthropic"), plan("plan-old", "test")] });
    await mount();
    await act(async () => button("Connect provider")!.click());
    expect(mocks.create).not.toHaveBeenCalled();
  });
  it("switches from the Claude Code token route to the CLI provider in one click", async () => {
    catalog("missing", {
      providerId: "claude-code",
      label: "Claude Code (Claude subscription)",
      authMode: "claude-code-oauth",
    });
    onboarding.settings.llm.activeProviderId = "claude-code";
    await mount();
    await act(async () => button("Use Claude Code CLI instead")!.click());
    const provider = container.querySelector<HTMLSelectElement>("select")!;
    expect(provider.value).toBe("claude-code-cli");
    expect(button("Add Claude Code CLI")).toBeDefined();
  });
  it("shows loading instead of an unavailable saved provider while the catalog loads", async () => {
    catalog("ready");
    mocks.catalog.mockReturnValue({ ...mocks.catalog(), providers: [], loading: true });
    await mount();
    const provider = container.querySelector<HTMLSelectElement>("select")!;
    expect(provider.textContent).toContain("Loading providers…");
    expect(provider.textContent).not.toContain("unavailable");
    expect(container.textContent).not.toContain("Not chosen");
  });
  it("groups the provider dropdown by how each provider is paid for", async () => {
    catalog("ready");
    await mount();
    const provider = container.querySelector<HTMLSelectElement>("select")!;
    const groups = [...provider.querySelectorAll("optgroup")].map((group) => [
      group.label,
      [...group.querySelectorAll("option")].map((option) => option.textContent),
    ]);
    expect(groups).toEqual([
      ["Ready to use", ["Test provider"]],
      ["Use a subscription", ["Claude Code CLI (local login) · not added yet"]],
    ]);
  });
  it("confirms a changed model through an installation default plan and shows the result", async () => {
    catalog("ready");
    await mount();
    const model = container.querySelectorAll("select")[1]!;
    await vi.waitFor(() => expect(model.querySelector('option[value="other-model"]')).not.toBeNull());
    await act(async () => {
      model.value = "other-model";
      model.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await act(async () => button("Confirm model")!.click());
    expect(mocks.create).toHaveBeenCalledExactlyOnceWith({
      workspaceId: "default",
      surface: "settings",
      request: {
        kind: "installation_default_model",
        providerId: "test",
        model: "other-model",
        thinkingLevel: "standard",
      },
    });
    expect(container.querySelector('[role="status"]')?.textContent).toBe("Change applied and verified.");
    expect(mocks.reload).toHaveBeenCalled();
  });
  it("creates the model plan on Confirm even while a connection plan for the provider is pending", async () => {
    catalog("ready");
    mocks.plans.mockResolvedValue({
      items: [
        {
          planId: "plan-connect",
          kind: "provider_connection",
          status: "awaiting_input",
          revision: 1,
          origin: { workspaceId: "default", surface: "settings" },
          request: { kind: "provider_connection", providerId: "test" },
        },
      ],
    });
    await mount();
    const model = container.querySelectorAll("select")[1]!;
    await vi.waitFor(() => expect(model.querySelector('option[value="other-model"]')).not.toBeNull());
    await act(async () => {
      model.value = "other-model";
      model.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await act(async () => button("Confirm model")!.click());
    expect(mocks.create).toHaveBeenCalledExactlyOnceWith({
      workspaceId: "default",
      surface: "settings",
      request: expect.objectContaining({ kind: "installation_default_model", providerId: "test" }),
    });
  });
  it("leaves no unsaved draft after saving the clamped effort of a provider without reasoning", async () => {
    catalog("ready", { capabilities: { reasoning: false } });
    await mount();
    const model = container.querySelectorAll("select")[1]!;
    await vi.waitFor(() => expect(model.querySelector('option[value="other-model"]')).not.toBeNull());
    await act(async () => {
      model.value = "other-model";
      model.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(hasSessionDraft("onboarding:default:model")).toBe(true);
    await act(async () => button("Confirm model")!.click());
    expect(mocks.create.mock.calls[0]![0].request).toMatchObject({ model: "other-model", thinkingLevel: "off" });
    expect(hasSessionDraft("onboarding:default:model")).toBe(false);
  });
  it("moves on with the host's own label once the default is confirmed", async () => {
    catalog("ready");
    const onEnterChat = vi.fn();
    await mount({ onEnterChat, enterChatLabel: "Continue to safety" });
    await act(async () => button("Continue to safety")!.click());
    expect(onEnterChat).toHaveBeenCalledTimes(1);
  });
  it("hides its step list for first run, which shows one flat stepper of its own", async () => {
    catalog("ready");
    await mount({ showSteps: false });
    expect(container.querySelector('ol[aria-label="Model setup steps"]')).toBeNull();
    expect(button("Enter Chat")).toBeDefined();
  });
  it("hands the notice to a host that keeps it and shows no second copy", async () => {
    onboarding.settings.llm.activeModel = "";
    catalog("ready");
    const onNoticeChange = vi.fn();
    await mount({ onNoticeChange });
    await act(async () => button("Confirm model")!.click());
    expect(onNoticeChange).toHaveBeenCalledWith("Change applied and verified.");
    expect(container.querySelector('[role="status"]')?.textContent).toBe("");
  });
});
