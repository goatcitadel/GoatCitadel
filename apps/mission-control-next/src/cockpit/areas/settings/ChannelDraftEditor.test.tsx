// @vitest-environment happy-dom
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { beforeEach, expect, it, vi } from "vitest";
import type { ChannelSetupDefinition, ChannelSetupDraft } from "@goatcitadel/contracts";
// This dynamic boundary loads current Gateway definitions for tests without expanding the production app graph.
const runtimeDefinitions = import.meta.glob<{ listChannelSetupDefinitions: () => ChannelSetupDefinition[] }>(
  "../../../../../gateway/src/services/channel-setup-definitions.ts",
);
import { __resetSessionViewStateForTests } from "../../../hooks/use-session-view-state";
import { ChannelDraftEditor } from "./ChannelDraftEditor";

vi.mock("../../ui/Dialog", () => ({
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
const text = (node: ReactTestInstance): string =>
  node.children
    .map((child) => (typeof child === "string" ? child : text(child)))
    .join(" ")
    .replace(/\s+/g, " ");

it("renders a channel draft without author guidance", async () => {
  // A Gateway that has not been updated yet can still send the retired author-guidance field. The editor ignores it.
  const definition = {
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
  } as ChannelSetupDefinition;
  const draft: ChannelSetupDraft = {
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
  };
  const onValuesChange = vi.fn();
  const onSave = vi.fn(async () => true);
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(
      <ChannelDraftEditor
        definition={definition}
        draft={draft}
        values={{}}
        label="Saved label"
        enabled
        dirty={false}
        onValuesChange={onValuesChange}
        onLabelChange={vi.fn()}
        onEnabledChange={vi.fn()}
        onDirty={vi.fn()}
        onSave={onSave}
        onValidate={vi.fn(async () => undefined)}
        onTest={vi.fn(async () => undefined)}
        onFinalize={vi.fn(async () => undefined)}
      />,
    );
  });
  const rendered = text(renderer.root);
  expect(rendered).not.toContain("Extension setup guidance");
  expect(rendered).not.toContain("Review this account first");
  expect(rendered).not.toContain("Propose a read-only check");
  expect(rendered).not.toContain("not-a-saved-value");
  expect(renderer.root.findAllByType("input").some((item) => item.props.value === "Saved label")).toBe(true);
  expect(onValuesChange).not.toHaveBeenCalled();
  expect(onSave).not.toHaveBeenCalled();
  await act(async () => renderer.unmount());
});
