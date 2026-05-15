import React from "react";
import { act, create, type ReactTestRenderer, type ReactTestRendererJSON } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";
import { OfficeStagePanel } from "./OfficeStagePanel";
import type { OfficeOperatorPrefsLike, OfficePlaybackState } from "./OfficeStageControlBar";

vi.mock("../../components/Panel", () => ({
  Panel: ({
    title,
    subtitle,
    actions,
    children,
    className,
  }: {
    title?: React.ReactNode;
    subtitle?: React.ReactNode;
    actions?: React.ReactNode;
    children?: React.ReactNode;
    className?: string;
  }) => (
    <section className={className}>
      <h2>{title}</h2>
      <p>{subtitle}</p>
      {actions}
      {children}
    </section>
  ),
}));

vi.mock("../../components/StatusChip", () => ({
  StatusChip: ({ children, tone }: { children?: React.ReactNode; tone?: string }) => (
    <span data-tone={tone}>{children}</span>
  ),
}));

vi.mock("../../components/FieldHelp", () => ({
  FieldHelp: ({ children, className }: { children?: React.ReactNode; className?: string }) => (
    <p className={className}>{children}</p>
  ),
}));

vi.mock("../../components/ui", () => ({
  GCSelect: ({
    id,
    value,
    options,
    onChange,
    disabled,
  }: {
    id?: string;
    value: string;
    options: Array<{ value: string; label: string }>;
    onChange: (value: string) => void;
    disabled?: boolean;
  }) => (
    <select id={id} disabled={disabled} value={value} onChange={(event) => onChange(event.target.value)}>
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  ),
}));

function collectText(node: ReactTestRendererJSON | ReactTestRendererJSON[] | string | null): string {
  if (node == null) {
    return "";
  }
  if (typeof node === "string") {
    return node;
  }
  if (Array.isArray(node)) {
    return node.map((child) => collectText(child)).join(" ");
  }
  return (node.children ?? []).map((child) => collectText(child as ReactTestRendererJSON | string | null)).join(" ");
}

function rendererText(renderer: ReactTestRenderer): string {
  return collectText(renderer.toJSON()).replace(/\s+/g, " ").trim();
}

const prefs: OfficeOperatorPrefsLike = {
  motionMode: "balanced",
  showCollabOverlay: true,
  idleMillingEnabled: true,
  showInspectorDock: true,
  showRailDock: true,
  focusMode: false,
  quietMode: false,
  followSelection: true,
};

function renderPanel(overrides: Partial<React.ComponentProps<typeof OfficeStagePanel<OfficeOperatorPrefsLike>>> = {}) {
  const setPlayback = vi.fn();
  const setOperatorPrefs = vi.fn();
  const onSelectEntity = vi.fn();
  const playback: OfficePlaybackState = { mode: "live", playing: false, speed: 1 };
  const props: React.ComponentProps<typeof OfficeStagePanel<OfficeOperatorPrefsLike>> = {
    sceneReady: true,
    blockedAgents: 0,
    priorityAgents: 1,
    watchAgents: 0,
    playbackMode: "live",
    goatAssetStatus: {
      tone: "success",
      chipLabel: "Goat ready",
      helpLabel: "ready",
      helpCopy: " Sprites loaded.",
    },
    focusSummary: null,
    stageControlProps: {
      playback,
      setPlayback,
      replayWindow: { startTime: 100, endTime: 200, replayableEvents: [{ id: "event-1" }] },
      playbackCursorTime: null,
      onPlaybackModeChange: vi.fn(),
      playbackSpeedOptions: [
        { value: "1", label: "1x" },
        { value: "2", label: "2x" },
      ],
      operatorPrefs: prefs,
      setOperatorPrefs,
      effectiveMotionMode: "balanced",
      prefersReducedMotion: false,
      motionModeOptions: [
        { value: "balanced", label: "Balanced" },
        { value: "reduced", label: "Reduced" },
      ],
    },
    zoneActivityLanes: [
      {
        fromZoneId: "command",
        toZoneId: "delivery",
        fromLabel: "Command",
        toLabel: "Delivery",
        count: 2,
        label: "Reviews flowing",
        risk: false,
      },
    ] as never,
    stageZoneTelemetry: [
      {
        zoneId: "command",
        label: "Command",
        attentionLevel: "priority",
        totalAgents: 2,
        activeAgents: 1,
        linkedAgents: 1,
        workloadScore: 0.6,
        focus: "Planning",
        landmark: "Goatherder desk",
        architectureNote: "Main control zone",
      },
    ] as never,
    selectedEntityId: "operator",
    selectedAgentZoneId: null,
    officeAgents: [{ roleId: "coder", name: "Coder", zoneId: "delivery" }] as never,
    operatorName: "Goatherder",
    onSelectEntity,
    renderScene: () => <div>3D stage placeholder</div>,
    ...overrides,
  };
  const renderer = create(<OfficeStagePanel {...props} />);
  return { renderer, props, setPlayback, setOperatorPrefs, onSelectEntity };
}

describe("OfficeStagePanel", () => {
  it("renders stage status, zone telemetry, lanes, scene, and desk selectors", () => {
    const { renderer } = renderPanel({
      focusSummary: {
        title: "Command focus",
        summary: "Priority desks active.",
        detail: "Track approvals first.",
      },
    });

    const text = rendererText(renderer);
    expect(text).toContain("Immersive Command Stage");
    expect(text).toContain("Command focus");
    expect(text).toContain("Command -> Delivery");
    expect(text).toContain("2 linked handoffs");
    expect(text).toContain("Goatherder desk");
    expect(text).toContain("3D stage placeholder");
    expect(text).toContain("Goat asset pipeline: ready");
  });

  it("routes playback, preference, and desk interactions", () => {
    const { renderer, props, setPlayback, setOperatorPrefs, onSelectEntity } = renderPanel();

    const liveButton = renderer.root
      .findAllByType("button")
      .find((button) => collectText(button.children as never) === "Live")!;
    const playButton = renderer.root
      .findAllByType("button")
      .find((button) => collectText(button.children as never) === "Play")!;
    const coderButton = renderer.root
      .findAllByType("button")
      .find((button) => collectText(button.children as never) === "Coder")!;

    act(() => {
      liveButton.props.onClick();
      playButton.props.onClick();
      renderer.root.findByProps({ id: "officePlaybackCursor" }).props.onChange({ target: { value: "50" } });
      renderer.root.findByProps({ id: "officePlaybackSpeed" }).props.onChange({ target: { value: "2" } });
      renderer.root.findByProps({ id: "officeMotionMode" }).props.onChange({ target: { value: "reduced" } });
      renderer.root
        .findAllByType("input")
        .find((input) => input.props.checked === true)
        ?.props.onChange({
          target: { checked: false },
        });
      coderButton.props.onClick();
    });

    expect(props.stageControlProps.onPlaybackModeChange).toHaveBeenCalledWith("live");
    expect(setPlayback).toHaveBeenCalled();
    expect(setOperatorPrefs).toHaveBeenCalled();
    expect(onSelectEntity).toHaveBeenCalledWith("coder");
  });

  it("shows empty activity and agent states without hiding the stage", () => {
    const { renderer } = renderPanel({
      zoneActivityLanes: [],
      officeAgents: [],
      stageControlProps: {
        ...renderPanel().props.stageControlProps,
        operatorPrefs: { ...prefs, focusMode: true, showCollabOverlay: false },
      },
    });

    const text = rendererText(renderer);
    expect(text).toContain("No cross-zone traffic");
    expect(text).toContain("No agent roles are available yet.");
    expect(text).toContain("Flow hidden");
  });
});
