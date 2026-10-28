// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChannelSetupDefinition, ChannelSetupDraft } from "@goatcitadel/contracts";
// This dynamic boundary loads current Gateway definitions for tests without expanding the production app graph.
const runtimeDefinitions = import.meta.glob<{ listChannelSetupDefinitions: () => ChannelSetupDefinition[] }>(
  "../../../../../../gateway/src/services/channel-setup-definitions.ts",
);
import { __resetSessionViewStateForTests } from "../../../../hooks/use-session-view-state";
import { ChannelSetupWizard } from "./ChannelSetupWizard";
import { findMissingFieldLabels, type ChannelSetupWizardFeedback } from "./channel-wizard-model";

// The hosts check on the test step reads the outbound allowlist; nothing here may reach a real Gateway for it.
vi.mock("@goatcitadel/mission-control-shared/api/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@goatcitadel/mission-control-shared/api/client")>()),
  fetchSettings: vi.fn(async () => ({ revision: 1, networkAllowlist: [] })),
}));

const definitions = (await Object.values(runtimeDefinitions)[0]!()).listChannelSetupDefinitions();
const slack = definitions.find((item) => item.catalog.catalogId === "channel.slack")!;
const confirmStep = slack.wizard.steps.find((step) => step.kind === "confirm")!;

const makeDraft = (definition: ChannelSetupDefinition): ChannelSetupDraft => ({
  draftId: "fixture-draft",
  revision: 1,
  catalogId: definition.catalog.catalogId,
  lifecycleMode: "create",
  label: "Sandbox",
  enabled: true,
  draft: {},
  secretState: {},
  contentVersion: definition.wizard.contentVersion,
  adapterVersion: definition.adapter.adapterVersion,
  validationVersion: definition.validation.validationVersion,
  testVersion: definition.testing.testVersion,
  createdAt: "2026-10-08T10:00:00.000Z",
  updatedAt: "2026-10-08T10:00:00.000Z",
});

const propsFor = (
  definition: ChannelSetupDefinition,
  extra: { dirty?: boolean; feedback?: ChannelSetupWizardFeedback } = {},
) => ({
  definition,
  draft: makeDraft(definition),
  values: {},
  label: "Sandbox",
  enabled: true,
  dirty: false,
  onValuesChange: vi.fn(),
  onLabelChange: vi.fn(),
  onEnabledChange: vi.fn(),
  onDirty: vi.fn(),
  onSave: vi.fn(async () => true),
  onValidate: vi.fn(async () => undefined),
  onTest: vi.fn(async () => undefined),
  onFinalize: vi.fn(async () => undefined),
  ...extra,
});

const withSteps = (steps: ChannelSetupDefinition["wizard"]["steps"]): ChannelSetupDefinition => ({
  ...slack,
  wizard: { ...slack.wizard, steps },
});

let root: Root;
let container: HTMLDivElement;
let client: QueryClient;

async function show(props: ReturnType<typeof propsFor>) {
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <ChannelSetupWizard {...props} />
      </QueryClientProvider>,
    );
  });
}

const stepButtons = () => [...container.querySelectorAll<HTMLButtonElement>('nav[aria-label="Setup steps"] button')];
const buttonNamed = (label: string) =>
  [...container.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent?.trim() === label);

async function openStep(title: string) {
  const target = stepButtons().filter((item) => item.textContent?.includes(title));
  expect(target).toHaveLength(1);
  await act(async () => target[0]!.click());
}

beforeEach(() => {
  __resetSessionViewStateForTests();
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  client.clear();
});

describe("the missing-values message", () => {
  it("names no config key when Slack's Continue is blocked", async () => {
    await show(propsFor(slack));
    await openStep("Connect the account");

    await act(async () => buttonNamed("Continue")!.click());

    const message = container.querySelector('[role="alert"]')?.textContent ?? "";
    expect(message).toContain("Complete the required setup values before continuing:");
    expect(message).not.toMatch(/[a-z]Env\b/);
    expect(message).toContain("Bot token or Incoming webhook URL (send-only) or Connected Slack install (OAuth only)");
  });

  it("leaves out an alternative that has no field, and says each label once", () => {
    const step = {
      id: "values",
      kind: "field-collection" as const,
      title: "Values",
      fields: [
        { key: "botToken", label: "Bot token", type: "secret" as const, required: false, explanation: "Secret" },
        { key: "tokenAlias", label: "Bot token", type: "text" as const, required: false, explanation: "Alias" },
        { key: "botTokenEnv", label: "Token environment", type: "text" as const, required: false, explanation: "Env" },
      ],
      requiredAnyOf: [["botToken", "tokenAlias", "botTokenEnv", "webhookUrlEnv"]],
    };
    const definition = withSteps([step]);

    expect(findMissingFieldLabels(definition, makeDraft(definition), step, {})).toEqual(["Bot token"]);
  });

  it("names a paste-or-variable pair by the pasted field's plain label only", () => {
    const whatsapp = definitions.find((item) => item.catalog.catalogId === "channel.whatsapp")!;
    const step = whatsapp.wizard.steps.find((item) => item.requiredAnyOf?.length)!;

    const missing = findMissingFieldLabels(whatsapp, makeDraft(whatsapp), step, {});

    expect(missing).toContain("Access token");
    expect(missing.join(" ")).not.toMatch(/environment variable/i);
  });

  it("names only the alternatives that are visible", () => {
    const step = {
      id: "values",
      kind: "field-collection" as const,
      title: "Values",
      fields: [
        { key: "mode", label: "Mode", type: "select" as const, required: false, defaultValue: "bot", explanation: "M" },
        {
          key: "botToken",
          label: "Bot token",
          type: "secret" as const,
          required: false,
          explanation: "Secret",
          visibleWhenFieldEquals: { fieldKey: "mode", value: "bot" },
        },
        {
          key: "webhookUrl",
          label: "Webhook URL",
          type: "url" as const,
          required: false,
          explanation: "Hook",
          visibleWhenFieldEquals: { fieldKey: "mode", value: "webhook" },
        },
      ],
      requiredAnyOf: [["botToken", "webhookUrl"]],
    };
    const definition = withSteps([step]);
    const draft = makeDraft(definition);

    expect(findMissingFieldLabels(definition, draft, step, {})).toEqual(["Bot token"]);
    expect(findMissingFieldLabels(definition, draft, step, { mode: "webhook" })).toEqual(["Webhook URL"]);
  });

  it("names the variable field when it is the only visible way in", () => {
    const step = {
      id: "values",
      kind: "field-collection" as const,
      title: "Values",
      fields: [
        { key: "mode", label: "Mode", type: "select" as const, required: false, defaultValue: "env", explanation: "M" },
        {
          key: "botToken",
          label: "Bot token",
          type: "secret" as const,
          required: false,
          explanation: "Secret",
          visibleWhenFieldEquals: { fieldKey: "mode", value: "paste" },
        },
        {
          key: "botTokenEnv",
          label: "Bot token from a variable",
          type: "text" as const,
          required: false,
          explanation: "E",
        },
      ],
      requiredAnyOf: [["botToken", "botTokenEnv"]],
    };
    const definition = withSteps([step]);

    expect(findMissingFieldLabels(definition, makeDraft(definition), step, {})).toEqual(["Bot token from a variable"]);
  });

  it("does not block on a group none of whose alternatives is a field", () => {
    const step = {
      id: "values",
      kind: "field-collection" as const,
      title: "Values",
      requiredAnyOf: [["webhookUrlEnv", "slackInstallId"]],
    };
    const definition = withSteps([step]);

    expect(findMissingFieldLabels(definition, makeDraft(definition), step, {})).toEqual([]);
  });
});

describe("the Classic guide", () => {
  it("labels each step in the list by its stage, not its internal kind", async () => {
    await show(propsFor(slack));

    const labels = stepButtons().map((item) => item.querySelector("small")?.textContent);

    expect(labels).toContain("Connect account");
    expect(labels).toContain("Check connection");
    expect(labels.join(" ")).not.toMatch(/field collection|instruction|confirm/);
  });

  it("prints why Finalize is off, as text beside the button", async () => {
    await show(propsFor(slack));
    await openStep(confirmStep.title);

    const finalize = buttonNamed("Finalize connection")!;
    const reason = [...container.querySelectorAll("p")].find((item) =>
      item.textContent?.includes("Run the live test before finalizing this connection."),
    )!;

    expect(finalize.disabled).toBe(true);
    expect(finalize.hasAttribute("title")).toBe(false);
    expect(reason).toBeDefined();
    expect(reason.closest("[aria-live], [role]")).toBeNull();
  });

  it("changes the reason with the state, and prints none when Finalize is allowed", async () => {
    const passed: ChannelSetupWizardFeedback = {
      kind: "test",
      status: "ok",
      issues: [],
      finalizationEligibility: { allowed: true, blockingReasons: [] },
    };
    await show(propsFor(slack, { dirty: true, feedback: passed }));
    await openStep(confirmStep.title);
    expect(container.textContent).toContain("Save these changes and run the live test again before finalizing.");

    await show(propsFor(slack, { feedback: passed }));

    expect(buttonNamed("Finalize connection")!.disabled).toBe(false);
    expect(container.textContent).not.toContain("before finalizing");
  });

  it("prints the same reason under the advanced JSON editor", async () => {
    await show(propsFor(slack));
    await act(async () => buttonNamed("Advanced JSON")!.click());

    expect(buttonNamed("Finalize connection")!.hasAttribute("title")).toBe(false);
    expect(container.textContent).toContain("Run the live test before finalizing this connection.");
  });
});
