import React from "react";
import { act, create } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatPresetPicker } from "./ChatPresetPicker";

let compact = false;

vi.mock("../../hooks/useMediaQuery", () => ({
  useMediaQuery: () => compact,
}));

vi.mock("../../components/ui", () => ({
  Popover: ({ children, open }: { children: React.ReactNode; open: boolean }) => <div data-open={open}>{children}</div>,
  PopoverTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  PopoverContent: ({ children }: { children: React.ReactNode }) => <div className="popover-content">{children}</div>,
  PopoverDescription: ({ children }: { children: React.ReactNode }) => <p>{children}</p>,
  PopoverHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  PopoverTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
  Sheet: ({ children, open }: { children: React.ReactNode; open: boolean }) => <div data-open={open}>{children}</div>,
  SheetContent: ({ children }: { children: React.ReactNode }) => <div className="sheet-content">{children}</div>,
  SheetDescription: ({ children }: { children: React.ReactNode }) => <p>{children}</p>,
  SheetHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SheetTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
}));

const presets = [
  {
    value: "quick",
    label: "Quick Chat",
    summary: "Fast response.",
    routeHint: "chat" as const,
    toolsPosture: "safe_auto" as const,
  },
  {
    value: "manual-code",
    label: "Manual Code",
    routeHint: "code" as const,
    toolsPosture: "manual" as const,
  },
];

afterEach(() => {
  compact = false;
});

describe("ChatPresetPicker", () => {
  it("renders nothing without preset options", () => {
    const renderer = create(
      <ChatPresetPicker presets={[]} selectedPresetId="" onPresetChange={vi.fn()} onApplyPreset={vi.fn()} />,
    );

    expect(renderer.toJSON()).toBeNull();
  });

  it("renders desktop preset metadata and applies the selected preset without auto-send", async () => {
    const onPresetChange = vi.fn();
    const onApplyPreset = vi.fn();
    const renderer = create(
      <ChatPresetPicker
        presets={presets}
        selectedPresetId="quick"
        onPresetChange={onPresetChange}
        onApplyPreset={onApplyPreset}
      />,
    );

    const text = JSON.stringify(renderer.toJSON());
    expect(text).toContain("Quick Chat");
    expect(text).toContain("Fast response.");
    expect(text).toContain("Chat");
    expect(text).toContain("Safe auto");
    expect(text).toContain("Manual tools");
    expect(text).toContain("Apply this preset as a starting posture.");

    const optionButtons = renderer.root.findAllByProps({ role: "option" });
    await act(async () => {
      optionButtons[1]?.props.onClick?.();
    });
    const applyButton = renderer.root
      .findAllByType("button")
      .find((button) => button.props.children === "Apply preset");
    await act(async () => {
      applyButton?.props.onClick?.();
    });

    expect(onPresetChange).toHaveBeenCalledWith("manual-code");
    expect(onApplyPreset).toHaveBeenCalledTimes(1);
  });

  it("uses the compact sheet trigger and fallback selected label on narrow viewports", async () => {
    compact = true;
    const renderer = create(
      <ChatPresetPicker
        presets={presets}
        selectedPresetId="missing"
        onPresetChange={vi.fn()}
        onApplyPreset={vi.fn()}
      />,
    );

    expect(JSON.stringify(renderer.toJSON())).toContain("Preset templates");
    const trigger = renderer.root
      .findAllByType("button")
      .find((button) => button.props.className?.includes("chat-preset-picker-trigger"));

    await act(async () => {
      trigger?.props.onClick?.();
    });

    expect(JSON.stringify(renderer.toJSON())).toContain("Agent-backed templates for Chat, Cowork, and Code.");
  });
});
