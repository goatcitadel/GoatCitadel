import React from "react";
import { act, create } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";

import { OfficeStageControlBar, type OfficeOperatorPrefsLike, type OfficePlaybackState } from "./OfficeStageControlBar";

vi.mock("../../components/FieldHelp", () => ({
  FieldHelp: ({ children }: { children?: React.ReactNode }) => <p>{children}</p>,
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

function renderControlBar(
  overrides: Partial<React.ComponentProps<typeof OfficeStageControlBar<OfficeOperatorPrefsLike>>> = {},
) {
  const setPlayback = vi.fn();
  const setOperatorPrefs = vi.fn();
  const props: React.ComponentProps<typeof OfficeStageControlBar<OfficeOperatorPrefsLike>> = {
    playback: { mode: "replay", playing: false, speed: 1, cursorTime: undefined },
    setPlayback,
    replayWindow: { startTime: 100, endTime: 300, replayableEvents: [{ id: "event-1" }] },
    playbackCursorTime: 200,
    onPlaybackModeChange: vi.fn(),
    playbackSpeedOptions: [
      { value: "1", label: "1x" },
      { value: "2", label: "2x" },
      { value: "4", label: "4x" },
    ],
    operatorPrefs: prefs,
    setOperatorPrefs,
    effectiveMotionMode: "balanced",
    prefersReducedMotion: false,
    motionModeOptions: [
      { value: "balanced", label: "Balanced" },
      { value: "reduced", label: "Reduced" },
    ],
    ...overrides,
  };

  const renderer = create(<OfficeStageControlBar {...props} />);
  return { renderer, props, setPlayback, setOperatorPrefs };
}

describe("OfficeStageControlBar", () => {
  it("routes playback mode, play toggles, cursor, and speed controls", () => {
    const { renderer, props, setPlayback } = renderControlBar();
    const buttons = renderer.root.findAllByType("button");

    act(() => {
      buttons[0]!.props.onClick();
      buttons[1]!.props.onClick();
      buttons[2]!.props.onClick();
      renderer.root.findByProps({ id: "officePlaybackCursor" }).props.onChange({ target: { value: "25" } });
      renderer.root.findByProps({ id: "officePlaybackSpeed" }).props.onChange("4");
    });

    expect(props.onPlaybackModeChange).toHaveBeenCalledWith("live");
    expect(props.onPlaybackModeChange).toHaveBeenCalledWith("replay");

    const playUpdater = setPlayback.mock.calls[0]![0] as (state: OfficePlaybackState) => OfficePlaybackState;
    expect(playUpdater({ mode: "replay", playing: false, speed: 1 })).toMatchObject({
      playing: true,
      cursorTime: 100,
    });
    expect(playUpdater({ mode: "live", playing: true, speed: 1, cursorTime: 250 })).toMatchObject({
      playing: false,
      cursorTime: 250,
    });

    const cursorUpdater = setPlayback.mock.calls[1]![0] as (state: OfficePlaybackState) => OfficePlaybackState;
    expect(cursorUpdater({ mode: "replay", playing: true, speed: 1 })).toMatchObject({
      cursorTime: 150,
      playing: false,
    });

    const speedUpdater = setPlayback.mock.calls[2]![0] as (state: OfficePlaybackState) => OfficePlaybackState;
    expect(speedUpdater({ mode: "replay", playing: false, speed: 1 })).toMatchObject({ speed: 4 });
  });

  it("routes motion and each operator preference toggle", () => {
    const { renderer, setOperatorPrefs } = renderControlBar();

    act(() => {
      renderer.root.findByProps({ id: "officeMotionMode" }).props.onChange("reduced");
      for (const input of renderer.root.findAllByType("input").filter((node) => node.props.type === "checkbox")) {
        input.props.onChange({ target: { checked: !input.props.checked } });
      }
    });

    const motionUpdater = setOperatorPrefs.mock.calls[0]![0] as (
      state: OfficeOperatorPrefsLike,
    ) => OfficeOperatorPrefsLike;
    expect(motionUpdater(prefs).motionMode).toBe("reduced");

    const updatedKeys = setOperatorPrefs.mock.calls.slice(1).map(([updater]) => {
      const next = (updater as (state: OfficeOperatorPrefsLike) => OfficeOperatorPrefsLike)(prefs);
      return Object.entries(next).find(([key, value]) => prefs[key as keyof OfficeOperatorPrefsLike] !== value)?.[0];
    });

    expect(updatedKeys).toEqual([
      "showCollabOverlay",
      "idleMillingEnabled",
      "showInspectorDock",
      "showRailDock",
      "focusMode",
      "quietMode",
      "followSelection",
    ]);
  });

  it("disables replay-only controls when no replay events are available or reduced motion is forced", () => {
    const { renderer } = renderControlBar({
      playback: { mode: "live", playing: false, speed: 1 },
      replayWindow: { startTime: 100, endTime: 100, replayableEvents: [] },
      playbackCursorTime: null,
      prefersReducedMotion: true,
    });

    expect(renderer.root.findAllByType("button")[1]!.props.disabled).toBe(true);
    expect(renderer.root.findAllByType("button")[2]!.props.disabled).toBe(true);
    expect(renderer.root.findByProps({ id: "officePlaybackCursor" }).props.value).toBe(100);
    expect(renderer.root.findByProps({ id: "officePlaybackSpeed" }).props.disabled).toBe(true);
    expect(renderer.root.findByProps({ id: "officeMotionMode" }).props.disabled).toBe(true);
  });
});
