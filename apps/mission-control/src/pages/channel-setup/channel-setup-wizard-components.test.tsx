import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChannelSetupFieldDefinition } from "@goatcitadel/contracts";

vi.mock("../../components/FieldHelp", () => ({
  FieldHelp: ({ children, className }: { children?: React.ReactNode; className?: string }) => (
    <div className={className}>{children}</div>
  ),
}));

vi.mock("../../components/Panel", () => ({
  Panel: ({ title, tone, children }: { title?: React.ReactNode; tone?: string; children?: React.ReactNode }) => (
    <section data-tone={tone}>
      <h2>{title}</h2>
      {children}
    </section>
  ),
}));

vi.mock("../../components/StatusChip", () => ({
  StatusChip: ({ children, tone }: { children?: React.ReactNode; tone?: string }) => (
    <span data-tone={tone}>{children}</span>
  ),
}));

import { FieldCard, ResultPanel, renderRichBlocks } from "./channel-setup-wizard-components";

function rendererText(renderer: ReactTestRenderer): string {
  return JSON.stringify(renderer.toJSON());
}

function baseField(overrides: Partial<ChannelSetupFieldDefinition> = {}): ChannelSetupFieldDefinition {
  return {
    key: "token",
    label: "Bot token",
    type: "secret",
    required: true,
    sensitive: true,
    explanation: "Paste the workspace token.",
    whyNeeded: "GoatCitadel sends channel updates with it.",
    whereToFind: [{ kind: "paragraph", text: "Open the integration settings." }],
    looksLike: "xoxb-...",
    commonMistakes: ["Using a user token"],
    canChangeLater: true,
    ...overrides,
  } as ChannelSetupFieldDefinition;
}

describe("channel setup wizard component behavior", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders rich field guidance and forwards text field changes", () => {
    const onChange = vi.fn();
    let renderer = create(<div />);
    try {
      act(() => {
        renderer = create(<FieldCard field={baseField()} value="" hydrationState="configured" onChange={onChange} />);
      });

      const text = rendererText(renderer);
      expect(text).toContain("Bot token");
      expect(text).toContain("Sensitive");
      expect(text).toContain("Configured already");
      expect(text).toContain("Where to find it");
      expect(text).toContain("Using a user token");

      const input = renderer.root.findByProps({ id: "channel-setup-token" });
      act(() => {
        input.props.onChange({ target: { value: "xoxb-new" } });
      });

      expect(onChange).toHaveBeenCalledWith("xoxb-new");
    } finally {
      renderer.unmount();
    }
  });

  it("supports select, boolean, textarea, and rendered rich block variants", () => {
    const onChange = vi.fn();
    let renderer = create(<div />);
    try {
      act(() => {
        renderer = create(
          <div>
            <FieldCard
              field={baseField({
                key: "mode",
                label: "Mode",
                type: "select",
                required: false,
                sensitive: false,
                options: [{ value: "guided", label: "Guided" }],
                defaultValue: "guided",
              })}
              value=""
              onChange={onChange}
            />
            <FieldCard
              field={baseField({ key: "enabled", label: "Enabled", type: "boolean", sensitive: false })}
              value="false"
              onChange={onChange}
            />
            <FieldCard
              field={baseField({ key: "notes", label: "Notes", type: "textarea", sensitive: false })}
              value="draft"
              onChange={onChange}
            />
            {renderRichBlocks([
              { kind: "list", ordered: true, items: ["one", "two"] },
              { kind: "note", tone: "warning", title: "Careful", text: "Check scopes." },
              { kind: "link", href: "https://example.test", label: "Docs", external: true },
              { kind: "code", code: "TOKEN=value" },
            ] as any)}
          </div>,
        );
      });

      act(() => {
        renderer.root.findByProps({ id: "channel-setup-mode" }).props.onChange({ target: { value: "guided" } });
        renderer.root.findByProps({ id: "channel-setup-enabled" }).props.onChange({ target: { checked: true } });
        renderer.root.findByProps({ id: "channel-setup-notes" }).props.onChange({ target: { value: "updated" } });
      });

      expect(onChange).toHaveBeenNthCalledWith(1, "guided");
      expect(onChange).toHaveBeenNthCalledWith(2, true);
      expect(onChange).toHaveBeenNthCalledWith(3, "updated");
      expect(rendererText(renderer)).toContain("TOKEN=value");
      expect(renderer.root.findByType("a").props).toMatchObject({
        href: "https://example.test",
        target: "_blank",
        rel: "noreferrer",
      });
    } finally {
      renderer.unmount();
    }
  });

  it("edits target rows while preserving a single default target", () => {
    const onChange = vi.fn();
    let renderer = create(<div />);
    try {
      act(() => {
        renderer = create(
          <FieldCard
            field={baseField({
              key: "targets",
              label: "Telegram targets",
              type: "textarea",
              sensitive: false,
              explanation: "Select chat destinations.",
            })}
            value={JSON.stringify([
              { id: "ops", label: "Ops", chatId: "100", default: false },
              { id: "alerts", label: "Alerts", chatId: "200", default: true },
            ])}
            onChange={onChange}
          />,
        );
      });

      const labelInputs = renderer.root.findAllByProps({ "aria-label": "Target label" });
      const chatInputs = renderer.root.findAllByProps({ "aria-label": "Chat ID or @channel" });
      const radios = renderer.root.findAllByProps({ type: "radio" });
      const buttons = renderer.root.findAllByType("button");

      expect(radios.map((radio) => radio.props.checked)).toEqual([true, false]);

      act(() => {
        labelInputs[0]!.props.onChange({ target: { value: "Operations" } });
        chatInputs[0]!.props.onChange({ target: { value: "@ops" } });
        radios[0]!.props.onChange();
        buttons.find((button) => button.props.children === "Add target")?.props.onClick();
      });

      expect(onChange).toHaveBeenNthCalledWith(
        1,
        expect.arrayContaining([expect.objectContaining({ id: "ops", label: "Operations" })]),
      );
      expect(onChange).toHaveBeenNthCalledWith(
        2,
        expect.arrayContaining([expect.objectContaining({ id: "ops", chatId: "@ops" })]),
      );
      expect(onChange).toHaveBeenNthCalledWith(3, [
        expect.objectContaining({ id: "ops", default: true }),
        expect.objectContaining({ id: "alerts", default: false }),
      ]);
      expect(onChange).toHaveBeenNthCalledWith(
        4,
        expect.arrayContaining([expect.objectContaining({ id: "target-3", chatId: "", default: false })]),
      );
    } finally {
      renderer.unmount();
    }
  });

  it("renders validation and probe results with recommended next action", () => {
    let renderer = create(<div />);
    try {
      act(() => {
        renderer = create(
          <ResultPanel
            title="Live test"
            result={
              {
                status: "warn",
                checkedAt: "2026-05-14T12:00:00.000Z",
                issues: [
                  {
                    key: "scope",
                    message: "Missing scope",
                    detail: "chat:write.public is absent.",
                    nextSteps: ["Reconnect Slack"],
                  },
                ],
                recommendedNextAction: "Reconnect, then test again.",
                probe: {
                  steps: [{ key: "auth", label: "Auth", status: "warn", message: "Token missing scope." }],
                },
              } as any
            }
          />,
        );
      });

      const text = rendererText(renderer);
      expect(text).toContain("Live test");
      expect(text).toContain("Missing scope");
      expect(text).toContain("Reconnect, then test again.");
      expect(text).toContain("Probe truth");
      expect(text).toContain("Token missing scope.");
    } finally {
      renderer.unmount();
    }
  });
});
