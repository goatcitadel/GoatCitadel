// @vitest-environment happy-dom
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChannelSetupDefinition, ChannelSetupDraft, ChannelSetupFieldDefinition } from "@goatcitadel/contracts";
// This dynamic boundary loads current Gateway definitions for tests without expanding the production app graph.
const runtimeDefinitions = import.meta.glob<{ listChannelSetupDefinitions: () => ChannelSetupDefinition[] }>(
  "../../../../../../gateway/src/services/channel-setup-definitions.ts",
);
import { __resetSessionViewStateForTests } from "../../../../hooks/use-session-view-state";
import { ChannelSetupWizard } from "./ChannelSetupWizard";
import { ChannelDraftEditor } from "../../../../cockpit/areas/settings/ChannelDraftEditor";
import { ChannelWizardFields } from "./ChannelWizardFieldCollection";
import { ChannelStructuredField } from "./ChannelStructuredField";
import { ChannelCheckFeedback } from "./ChannelCheckFeedback";
import {
  findMissingFieldLabels,
  hasFieldValue,
  isStepComplete,
  finalizeDisabledReason,
  mergeDiscoveredChannelTargets,
  readChannelTargetRows,
} from "./channel-wizard-model";
vi.mock("../../../../cockpit/ui/Dialog", () => ({
  Dialog: ({ open, children, title }: { open: boolean; children: import("react").ReactNode; title: string }) =>
    open ? (
      <div role="dialog" aria-label={title}>
        {children}
      </div>
    ) : null,
}));
// The hosts check on a test step reads the outbound allowlist; no test here may reach a real Gateway for it.
vi.mock("@goatcitadel/mission-control-shared/api/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@goatcitadel/mission-control-shared/api/client")>()),
  fetchSettings: vi.fn(async () => ({ revision: 1, networkAllowlist: [] })),
}));
beforeEach(() => __resetSessionViewStateForTests());
const definitions = (await Object.values(runtimeDefinitions)[0]!()).listChannelSetupDefinitions();
const makeDraft = (definition = definitions[0]!): ChannelSetupDraft => ({
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
const text = (node: ReactTestInstance): string =>
  node.children
    .map((child) => (typeof child === "string" ? child : text(child)))
    .join(" ")
    .replace(/\s+/g, " ");
const button = (root: ReactTestInstance, label: string) =>
  root.findAllByType("button").find((item) => text(item).trim() === label)!;
async function render(element: import("react").ReactElement) {
  let r!: ReactTestRenderer;
  await act(async () => {
    r = create(element);
  });
  return r;
}
const targetField: ChannelSetupFieldDefinition = {
  key: "targets",
  label: "Destinations",
  type: "target-list",
  required: true,
  explanation: "Where messages are delivered",
  targetAddressKey: "chatId",
};
const definitionWith = (fields: ChannelSetupFieldDefinition[], overrides = {}): ChannelSetupDefinition => ({
  ...definitions[0]!,
  wizard: {
    ...definitions[0]!.wizard,
    steps: [{ id: "values", kind: "field-collection", title: "Values", fields, ...overrides }],
  },
});

describe("semantic channel step completion", () => {
  it("shows optional author guidance in both editors without changing saved inputs or adding configuration fields", async () => {
    const definition: ChannelSetupDefinition = {
      ...definitions[0]!,
      configurationGuidance: {
        pluginId: "fixture",
        pluginVersion: "1.0.0",
        supportedFieldKeys: [],
        form: {
          version: "goatcitadel.extension-configuration.v1",
          prerequisites: ["Review this account first"],
          fields: [
            { key: "unsupportedKey", kind: "text", label: "Author suggestion", defaultValue: "not-a-saved-value" },
          ],
          sampleTask: { prompt: "Propose a read-only check", expectedOutcome: "A reviewed check" },
        },
      },
    };
    for (const Component of [ChannelSetupWizard, ChannelDraftEditor]) {
      const onValuesChange = vi.fn(),
        onSave = vi.fn(async () => true);
      const props = {
        definition,
        draft: makeDraft(definition),
        values: {},
        label: "Saved label",
        enabled: true,
        dirty: false,
        onValuesChange,
        onLabelChange: vi.fn(),
        onEnabledChange: vi.fn(),
        onDirty: vi.fn(),
        onSave,
        onValidate: vi.fn(async () => undefined),
        onTest: vi.fn(async () => undefined),
        onFinalize: vi.fn(async () => undefined),
      };
      const r = await render(<Component {...props} />);
      const guidance = r.root
        .findAllByType("details")
        .find((item) => text(item).includes("Extension setup guidance · fixture"))!;
      expect(guidance).toBeDefined();
      expect(text(guidance)).toContain("Review this account first");
      expect(text(guidance)).toContain("Propose a read-only check");
      expect(text(guidance)).not.toContain("not-a-saved-value");
      expect(guidance.findAll((item) => ["input", "select", "textarea"].includes(String(item.type)))).toHaveLength(0);
      expect(r.root.findAllByType("input").some((item) => item.props.value === "Saved label")).toBe(true);
      expect(onValuesChange).not.toHaveBeenCalled();
      expect(onSave).not.toHaveBeenCalled();
      await act(async () => r.unmount());
    }
  });
  it("requires true confirmations, meaningful values, and both a checklist and fields", () => {
    const definition = definitionWith(
      [
        { key: "approved", label: "Confirm access", type: "boolean", required: true, explanation: "Approval" },
        targetField,
      ],
      { checklist: [{ id: "owner", label: "I own this destination" }] },
    );
    const draft = makeDraft(definition),
      step = definition.wizard.steps[0]!;
    expect(hasFieldValue(draft, { targets: [] }, "targets")).toBe(false);
    expect(hasFieldValue(draft, { targets: {} }, "targets")).toBe(false);
    expect(findMissingFieldLabels(definition, draft, step, { approved: false, targets: [] })).toEqual([
      "Confirm access",
      "Destinations",
    ]);
    const good = { approved: true, targets: [{ id: "home", chatId: "-1001234567890", default: true }] };
    expect(isStepComplete(step, definition, draft, good, {}, {})).toBe(false);
    expect(isStepComplete(step, definition, draft, good, {}, { "fixture-draft:values:owner": true })).toBe(true);
  });
  it("uses visibility defaults and alternatives without accepting a cleared configured secret", () => {
    const definition = definitionWith(
      [
        { key: "mode", label: "Mode", type: "select", required: false, defaultValue: "bot", explanation: "Mode" },
        {
          key: "botToken",
          label: "Token",
          type: "secret",
          required: false,
          explanation: "Secret",
          visibleWhenFieldEquals: { fieldKey: "mode", value: "bot" },
        },
        { key: "botTokenEnv", label: "Token environment", type: "text", required: false, explanation: "Reference" },
        {
          key: "webhookUrl",
          label: "Webhook",
          type: "url",
          explanation: "Destination",
          required: true,
          visibleWhenFieldEquals: { fieldKey: "mode", value: "webhook" },
        },
      ],
      { requiredAnyOf: [["botToken", "botTokenEnv"]] },
    );
    const draft = {
        ...makeDraft(definition),
        secretState: { botToken: { configured: true, custody: "temporary" as const } },
      },
      step = definition.wizard.steps[0]!;
    expect(findMissingFieldLabels(definition, draft, step, {})).toEqual([]);
    expect(findMissingFieldLabels(definition, draft, step, { botToken: "" })).toEqual(["Token"]);
    expect(findMissingFieldLabels(definition, draft, step, { botTokenEnv: "BOT_TOKEN" })).toEqual([]);
  });
  it("validates default and destination identity while preserving distinct threads", () => {
    const definition = definitionWith([targetField]),
      draft = makeDraft(definition),
      step = definition.wizard.steps[0]!;
    const rows = [
      { id: "a", chatId: "@ops", threadId: "1", default: true },
      { id: "b", chatId: "@ops", threadId: "2", default: false },
    ];
    expect(findMissingFieldLabels(definition, draft, step, { targets: rows })).toEqual([]);
    expect(findMissingFieldLabels(definition, draft, step, { targets: [...rows, { ...rows[1], id: "c" }] })).toContain(
      "Destinations: remove duplicate destinations",
    );
    expect(
      findMissingFieldLabels(definition, draft, step, { targets: rows.map((row) => ({ ...row, default: false })) }),
    ).toContain("Destinations: choose one default");
    expect(
      findMissingFieldLabels(definition, draft, step, { targets: [{ id: "a", chatId: "", default: true }] }),
    ).toContain("Destinations: add a destination to every row");
  });
  it("does not infer first-conversation success from visiting its instruction step", () => {
    const definition = definitions[0]!,
      draft = makeDraft(definition);
    const step = {
      id: "first-message",
      kind: "instruction" as const,
      stage: "first_message" as const,
      title: "Confirm delivery",
    };
    expect(isStepComplete(step, definition, draft, {}, { "first-message": true }, {})).toBe(false);
  });
  it("uses Gateway eligibility while unknown warnings, dirty inputs, and validation remain blocking", () => {
    const warning = { kind: "test" as const, status: "warn" as const, issues: [] };
    expect(finalizeDisabledReason(false, warning)).toBeDefined();
    expect(
      finalizeDisabledReason(false, {
        ...warning,
        finalizationEligibility: { allowed: false, blockingReasons: ["Credential check failed"] },
      }),
    ).toBe("Credential check failed");
    expect(
      finalizeDisabledReason(false, { ...warning, finalizationEligibility: { allowed: true, blockingReasons: [] } }),
    ).toBeUndefined();
    expect(
      finalizeDisabledReason(true, { ...warning, finalizationEligibility: { allowed: true, blockingReasons: [] } }),
    ).toBeDefined();
    expect(
      finalizeDisabledReason(false, {
        ...warning,
        kind: "validate",
        finalizationEligibility: { allowed: true, blockingReasons: [] },
      }),
    ).toBeDefined();
  });
});

describe("structured field interaction", () => {
  it("preserves long and negative IDs, aliases, thread metadata, and unknown saved keys", async () => {
    const onChange = vi.fn();
    const rows = [
      {
        id: "alias",
        label: "Home",
        chatId: "-100123456789012345678",
        default: true,
        threadId: "123",
        customRoute: "retain",
      },
    ];
    const r = await render(
      <ChannelStructuredField
        field={targetField}
        value={rows}
        id="targets"
        describedBy="help"
        disabled={false}
        inputClassName="fixture"
        onChange={onChange}
      />,
    );
    const address = r.root.findByProps({ id: "targets-address-0" });
    expect(address.props.inputMode).toBe("text");
    await act(async () => address.props.onChange({ target: { value: "@ops_channel" } }));
    expect(onChange.mock.lastCall?.[0]).toEqual([{ ...rows[0], chatId: "@ops_channel" }]);
    expect(text(r.root)).not.toContain("[object Object]");
    expect(r.root.findAllByType("button").every((item) => item.props.type === "button")).toBe(true);
    expect(r.root.findByProps({ "aria-label": "Remove destination Home" })).toBeDefined();
    r.unmount();
  });
  it("merges explicit discoveries without overwriting targets, defaults, IDs, or distinct threads", () => {
    const current = readChannelTargetRows(
      '[{"id":"manual","label":"Home","chatId":"@ops","threadId":"7","default":true,"extra":"keep"}]',
      "chatId",
    );
    const selected = [
      { id: "topic8", label: "Another topic", chatId: "@ops", threadId: "8" },
      { id: "duplicate", label: "Duplicate", chatId: "@ops", threadId: "7" },
      { id: "other", label: "Other", chatId: "-999" },
    ];
    expect(mergeDiscoveredChannelTargets(current, selected)).toEqual([
      current[0],
      { ...selected[0], default: false },
      { ...selected[2], default: false },
    ]);
  });
  it("keeps unmet required advanced fields and field errors visible with accessible descriptions", async () => {
    const fields: ChannelSetupFieldDefinition[] = [
      {
        key: "required",
        label: "Required value",
        type: "text",
        explanation: "Need it",
        required: true,
        advanced: true,
      },
      {
        key: "optional",
        label: "Optional value",
        type: "text",
        required: false,
        explanation: "Optional",
        advanced: true,
      },
      { key: "repair", label: "Repair value", type: "text", required: false, explanation: "Repair", advanced: true },
    ];
    const r = await render(
      <ChannelWizardFields
        draft={makeDraft()}
        fields={fields}
        values={{}}
        disabled={false}
        onChange={vi.fn()}
        issues={[{ key: "repair", fieldKey: "repair", level: "error", message: "Fix this value" }]}
      />,
    );
    const advanced = r.root
      .findAllByType("details")
      .find((node) => text(node).includes("Advanced connection options"))!;
    expect(advanced.findAllByType("input").map((input) => input.props.id)).toEqual(["channel-fixture-draft-optional"]);
    const repair = r.root.findByProps({ id: "channel-fixture-draft-repair" });
    expect(repair.props["aria-invalid"]).toBe(true);
    expect(repair.props["aria-describedby"]).toContain("channel-fixture-draft-repair-issue-0");
    r.unmount();
  });
  it("presents saved Slack install metadata as a readonly canonical receipt", async () => {
    const definition = definitions.find((item) => item.catalog.catalogId === "channel.slack")!;
    const draft = {
      ...makeDraft(definition),
      draft: {
        slackInstallId: "slack:TREAL:AREAL",
        slackTeamId: "TREAL",
        slackAppId: "AREAL",
        slackBotUserId: "BREAL",
        slackScopes: ["chat:write"],
      },
    };
    const field = definition.wizard.steps
      .flatMap((step) => step.fields ?? [])
      .find((item) => item.key === "slackInstallId")!;
    const onChange = vi.fn();
    const r = await render(
      <ChannelWizardFields
        draft={draft}
        fields={[field]}
        values={{ slackInstallId: "forged-local-value" }}
        disabled={false}
        onChange={onChange}
      />,
    );
    const input = r.root.findByProps({ id: "channel-fixture-draft-slackInstallId" });
    expect(input.props.readOnly).toBe(true);
    expect(input.props.value).toBe("slack:TREAL:AREAL");
    expect(input.props.onChange).toBeUndefined();
    expect(text(r.root)).toContain("AREAL");
    expect(text(r.root)).not.toContain("forged-local-value");
    r.unmount();
  });
  it("lists saved Slack scopes whether adopt recorded them as a list or a comma-joined string", async () => {
    const definition = definitions.find((item) => item.catalog.catalogId === "channel.slack")!;
    const field = definition.wizard.steps
      .flatMap((step) => step.fields ?? [])
      .find((item) => item.key === "slackInstallId")!;
    const receipt = {
      slackInstallId: "slack:TREAL:AREAL",
      slackTeamId: "TREAL",
      slackAppId: "AREAL",
      slackBotUserId: "BREAL",
    };
    for (const slackScopes of [["chat:write", "channels:read"], "chat:write, channels:read,, "]) {
      const draft = { ...makeDraft(definition), draft: { ...receipt, slackScopes } };
      const r = await render(
        <ChannelWizardFields draft={draft} fields={[field]} values={{}} disabled={false} onChange={vi.fn()} />,
      );
      expect(text(r.root)).toContain("chat:write, channels:read");
      expect(text(r.root)).not.toContain("Not recorded");
      r.unmount();
    }
  });
  it("invalidates reviewed live tests when local advanced JSON changes in the Classic wizard", async () => {
    // The cockpit editor is typed-fields-only so credentials always travel through secure inputs.
    for (const Component of [ChannelSetupWizard]) {
      const definition = definitions[0]!,
        draft = makeDraft(definition);
      const onTest = vi.fn(async () => undefined);
      const props = {
        definition,
        draft,
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
        onTest,
        onFinalize: vi.fn(async () => undefined),
      };
      const r = await render(<Component {...props} />);
      await act(async () => button(r.root, "Advanced JSON").props.onClick());
      const review = button(r.root, "Run live test");
      await act(async () => review.props.onClick());
      const textarea = r.root.findByType("textarea");
      await act(async () => textarea.props.onChange({ target: { value: '{"defaultChannel":"changed"}' } }));
      expect(button(r.root, "Run reviewed live test").props.disabled).toBe(true);
      expect(onTest).not.toHaveBeenCalled();
      r.unmount();
    }
  });
  it("offers no Advanced JSON in the cockpit editor", async () => {
    const definition = definitions[0]!,
      draft = makeDraft(definition);
    const props = {
      definition,
      draft,
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
    };
    const r = await render(<ChannelDraftEditor {...props} />);
    expect(r.root.findAllByType("button").some((item) => text(item).trim() === "Advanced JSON")).toBe(false);
    r.unmount();
  });
  it("keeps a warning visible and binds optional cleanup acknowledgement to exact evidence", async () => {
    const onAcknowledge = vi.fn(async () => undefined);
    const feedback = {
      kind: "test" as const,
      status: "warn" as const,
      issues: [],
      evidenceId: "receipt-one",
      finalizationEligibility: {
        allowed: false,
        blockingReasons: ["Cleanup acknowledgement required"],
        requiresAcknowledgement: true,
      },
      probe: {
        kind: "telegram" as const,
        mode: "bot",
        checkedAt: "2026-10-08T10:00:00Z",
        steps: [
          {
            key: "message_cleanup",
            label: "Cleanup",
            status: "warn" as const,
            disposition: "advisory" as const,
            providerMessageId: "provider-one",
            cleanupStatus: "manual_required" as const,
            message: "Remove the test message",
          },
        ],
      },
    };
    const r = await render(<ChannelCheckFeedback feedback={feedback} onAcknowledge={onAcknowledge} />);
    expect(text(r.root)).toContain("Connection test · Warning");
    await act(async () => button(r.root, "Review test message cleanup").props.onClick());
    await act(async () =>
      r.update(
        <ChannelCheckFeedback feedback={{ ...feedback, evidenceId: "receipt-two" }} onAcknowledge={onAcknowledge} />,
      ),
    );
    expect(button(r.root, "Acknowledge reviewed cleanup warning").props.disabled).toBe(true);
    expect(onAcknowledge).not.toHaveBeenCalled();
    r.unmount();
  });
});

describe("current all14 guided definitions in both shells", () => {
  it("shows immutable history, severity, deferred checks, cleanup, and acknowledgements for all14 without treating them as current proof", async () => {
    for (const definition of definitions)
      for (const Component of [ChannelSetupWizard, ChannelDraftEditor]) {
        const draft = makeDraft(definition),
          checkedAt = "2026-10-08T10:00:00Z";
        const props = {
          definition,
          draft,
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
          draftEvidence: {
            draftId: draft.draftId,
            draftRevision: draft.revision,
            items: [
              {
                evidenceId: "saved-all14",
                catalogId: draft.catalogId,
                draftId: draft.draftId,
                draftRevision: draft.revision,
                phase: "acknowledgement" as const,
                status: "warn" as const,
                checkedAt,
                createdAt: checkedAt,
                acknowledgement: "cleanup" as const,
                issues: [
                  {
                    key: "future",
                    level: "info" as const,
                    disposition: "deferred" as const,
                    message: "First conversation still awaits activation.",
                  },
                ],
                probe: {
                  kind: definition.catalog.key,
                  checkedAt,
                  steps: [
                    {
                      key: "cleanup",
                      label: "Test cleanup",
                      status: "warn" as const,
                      disposition: "advisory" as const,
                      message: "Clean up the test message.",
                      cleanupStatus: "manual_required" as const,
                      providerMessageId: "all14-provider-receipt",
                    },
                  ],
                },
                finalizationEligibility: { allowed: true, blockingReasons: [], evidenceId: "saved-all14" },
              },
            ],
          },
        };
        const r = await render(<Component {...props} />);
        const history = r.root.findByProps({ "aria-label": "Channel check history" });
        expect(text(history)).toContain("Saved check evidence");
        expect(text(history)).toContain("Acknowledgement · Warning");
        expect(text(history)).toContain("Information : · deferred First conversation still awaits activation.");
        expect(text(history)).toContain("Provider receipt: all14-provider-receipt");
        expect(text(history)).toContain("Test message cleanup: manual required");
        expect(text(history)).toContain("Reviewed cleanup warning acknowledged");
        expect(text(history)).toContain("No fresh test proof is available");
        expect(text(history)).not.toContain("The Gateway permits preparing");
        expect(r.root.findAllByProps({ "aria-label": "Channel check result" })).toHaveLength(0);
        r.unmount();
      }
  });
  it("renders every visible adapter step through shared fields with string destinations", async () => {
    expect(definitions).toHaveLength(14);
    expect(definitions.map((definition) => definition.catalog.catalogId)).toEqual(
      expect.arrayContaining(["channel.matrix", "channel.qqbot", "channel.wecom"]),
    );
    for (const definition of definitions) {
      const draft = makeDraft(definition);
      const values = {
        ...Object.fromEntries(
          definition.wizard.steps
            .flatMap((step) => step.fields ?? [])
            .filter((field) => field.defaultValue !== undefined)
            .map((field) => [field.key, field.defaultValue]),
        ),
        targets:
          definition.catalog.catalogId === "channel.slack"
            ? [{ id: "ops", label: "Ops", channel: "#ops", default: true }]
            : [{ id: "home", label: "Home", chatId: "-100123456789012345678", default: true }],
      };
      const props = {
        definition,
        draft,
        values,
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
      };
      for (const Component of [ChannelSetupWizard, ChannelDraftEditor]) {
        // The Cockpit has the query client the hosts check reads through; Classic brings its own.
        const r = await render(
          <QueryClientProvider client={new QueryClient()}>
            <Component {...props} />
          </QueryClientProvider>,
        );
        const nav = r.root.findByProps({ "aria-label": "Setup steps" });
        const count = nav.findAllByType("button").length;
        expect(count).toBeGreaterThanOrEqual(5);
        for (let index = 0; index < count; index++) {
          const selected = r.root.findByProps({ "aria-label": "Setup steps" }).findAllByType("button")[index]!;
          await act(async () => selected.props.onClick());
          expect(selected.props["aria-current"]).toBe("step");
          if (Component === ChannelDraftEditor) expect(text(selected)).toContain(" · Current");
          expect(text(r.root)).not.toContain("[object Object]");
          expect(r.root.findAllByType("input").every((input) => typeof input.props.value !== "object")).toBe(true);
        }
        r.unmount();
      }
    }
  });
});

describe("what a channel needs and the editing note, in both shells", () => {
  const slack = definitions.find((item) => item.catalog.catalogId === "channel.slack")!;
  const propsFor = (definition: ChannelSetupDefinition, draft: ChannelSetupDraft) => ({
    definition,
    draft,
    values: {},
    label: draft.label ?? "",
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
  });
  const stepButtons = (root: ReactTestInstance) =>
    root.findByProps({ "aria-label": "Setup steps" }).findAllByType("button");
  const editingNotes = (root: ReactTestInstance) =>
    root.findAll((node) => node.type === "p" && text(node).trim().startsWith("You're changing"));
  const slackTitle = (id: string) => slack.wizard.steps.find((step) => step.id === id)!.title;

  it("lists the prerequisites under 'What you need', one item each", async () => {
    expect(slack.wizard.prerequisites.length).toBeGreaterThan(0);
    for (const Component of [ChannelSetupWizard, ChannelDraftEditor]) {
      const r = await render(<Component {...propsFor(slack, makeDraft(slack))} />);
      const needs = r.root.findByProps({ "aria-label": "What you need" });
      expect(text(needs.findByType("h4")).trim()).toBe("What you need");
      expect(needs.findAllByType("li").map((item) => text(item).trim())).toEqual(slack.wizard.prerequisites);
      r.unmount();
    }
  });
  it("shows no 'What you need' list when the channel has no prerequisites", async () => {
    // A definition without the list at all must also render, because it comes from the Gateway.
    const noList = { ...slack.wizard, prerequisites: undefined } as unknown as ChannelSetupDefinition["wizard"];
    for (const bare of [
      { ...slack, wizard: { ...slack.wizard, prerequisites: [] } },
      { ...slack, wizard: noList },
    ] satisfies ChannelSetupDefinition[])
      for (const Component of [ChannelSetupWizard, ChannelDraftEditor]) {
        const r = await render(<Component {...propsFor(bare, makeDraft(bare))} />);
        expect(r.root.findAllByProps({ "aria-label": "What you need" })).toHaveLength(0);
        expect(text(r.root)).not.toContain("What you need");
        r.unmount();
      }
  });
  it("starts a new connection at its overview and says nothing about editing", async () => {
    for (const Component of [ChannelSetupWizard, ChannelDraftEditor]) {
      const r = await render(<Component {...propsFor(slack, makeDraft(slack))} />);
      const buttons = stepButtons(r.root);
      expect(buttons).toHaveLength(slack.wizard.steps.length);
      expect(text(buttons[0]!)).toContain(slackTitle("overview"));
      expect(buttons[0]!.props["aria-current"]).toBe("step");
      expect(text(buttons[1]!)).toContain(slackTitle("prerequisites"));
      expect(editingNotes(r.root)).toHaveLength(0);
      expect(text(r.root)).not.toContain("You're changing");
      r.unmount();
    }
  });
  it("hides the overview and prerequisites when a saved connection is changed, and says so", async () => {
    for (const lifecycleMode of ["edit", "repair", "rotate_secret", "retest"] as const)
      for (const Component of [ChannelSetupWizard, ChannelDraftEditor]) {
        const draft: ChannelSetupDraft = { ...makeDraft(slack), lifecycleMode, label: "" };
        const r = await render(<Component {...propsFor(slack, draft)} />);
        const titles = stepButtons(r.root).map((item) => text(item));
        // Slack's overview, prerequisites and "create your Slack app" steps are setup-only.
        expect(titles).toHaveLength(slack.wizard.steps.length - 3);
        expect(titles.some((title) => title.includes(slackTitle("overview")))).toBe(false);
        expect(titles.some((title) => title.includes(slackTitle("prerequisites")))).toBe(false);
        expect(titles.some((title) => title.includes(slackTitle("create-app")))).toBe(false);
        const notes = editingNotes(r.root);
        expect(notes).toHaveLength(1);
        expect(text(notes[0]!).trim()).toBe("You're changing Slack. The steps for setting it up are hidden.");
        r.unmount();
      }
  });
  it("says nothing about hidden steps when editing a channel that has none to hide", async () => {
    const telegram = definitions.find((item) => item.catalog.catalogId === "channel.telegram")!;
    expect(telegram.wizard.steps.some((step) => step.createOnly)).toBe(false);
    // When every step is setup-only the guide keeps them all, so nothing is hidden there either.
    const everyStepSetupOnly: ChannelSetupDefinition = {
      ...slack,
      wizard: { ...slack.wizard, steps: slack.wizard.steps.map((step) => ({ ...step, createOnly: true })) },
    };
    for (const definition of [telegram, everyStepSetupOnly])
      for (const Component of [ChannelSetupWizard, ChannelDraftEditor]) {
        const draft: ChannelSetupDraft = { ...makeDraft(definition), lifecycleMode: "edit", label: "" };
        const r = await render(<Component {...propsFor(definition, draft)} />);
        expect(stepButtons(r.root)).toHaveLength(definition.wizard.steps.length);
        expect(editingNotes(r.root)).toHaveLength(0);
        expect(text(r.root)).not.toContain("The steps for setting it up are hidden");
        r.unmount();
      }
  });
  it("names the connection by its label, and falls back to the channel when the label is blank", async () => {
    for (const [label, name] of [
      ["Ops workspace", "Ops workspace"],
      ["  Ops workspace  ", "Ops workspace"],
      ["   ", "Slack"],
      [undefined, "Slack"],
    ] as const)
      for (const Component of [ChannelSetupWizard, ChannelDraftEditor]) {
        const draft: ChannelSetupDraft = { ...makeDraft(slack), lifecycleMode: "edit", label };
        const r = await render(<Component {...propsFor(slack, draft)} />);
        expect(text(editingNotes(r.root)[0]!).trim()).toBe(
          `You're changing ${name}. The steps for setting it up are hidden.`,
        );
        r.unmount();
      }
  });
  it("adds no live region for the list or the editing note", async () => {
    for (const Component of [ChannelSetupWizard, ChannelDraftEditor]) {
      const draft: ChannelSetupDraft = { ...makeDraft(slack), lifecycleMode: "edit" };
      const r = await render(<Component {...propsFor(slack, draft)} />);
      const needs = r.root.findByProps({ "aria-label": "What you need" });
      const [note] = editingNotes(r.root);
      for (const node of [needs, note!, ...needs.findAll(() => true)]) {
        expect(node.props.role).toBeUndefined();
        expect(node.props["aria-live"]).toBeUndefined();
      }
      r.unmount();
    }
  });
});
