/**
 * Constants extracted from OfficePage.tsx as part of Step 10
 * (page decomposition).
 */

import type { OfficeMotionMode, OperatorPreset } from "../../components/OfficeCanvas";

export const HOT_AGENT_WINDOW_MS = 2 * 60 * 1000;
export const WARM_AGENT_WINDOW_MS = 10 * 60 * 1000;

export const INITIAL_EVENT_LIMIT = 100;
export const MAX_EVENTS = 200;
export const SNAPSHOT_INTERVAL_MS = 20_000;

export const EVENTS_PER_MINUTE_WINDOW_MS = 5 * 60 * 1000;
export const PLAYBACK_WINDOW_MS = 5 * 60 * 1000;
export const PLAYBACK_STEP_MS = 12_000;
export const ACTIVITY_TRANSITION_WINDOW_MS = 18_000;
export const MAX_VISIBLE_COLLAB_EDGES = 8;
export const MAX_VISIBLE_ZONE_LANES = 6;

export const OPERATOR_NAME_OPTIONS = ["GoatHerder", "Lead Herder", "Herd Captain", "Trail Commander"].map((value) => ({
  value,
  label: value,
}));

export type OfficePageVariant = "stable" | "lab";
export type OfficeDockTab = "inspector" | "operators" | "approvals" | "rail";

export interface OperatorPreferences {
  name: string;
  preset: OperatorPreset;
  layoutMode: "immersive";
  motionMode: OfficeMotionMode;
  showCollabOverlay: boolean;
  showInspectorDock: boolean;
  showRailDock: boolean;
  idleMillingEnabled: boolean;
  focusMode: boolean;
  quietMode: boolean;
  followSelection: boolean;
}

export const DEFAULT_OPERATOR_PREFS: OperatorPreferences = {
  name: "GoatHerder",
  preset: "trailblazer",
  layoutMode: "immersive",
  motionMode: "cinematic",
  showCollabOverlay: true,
  showInspectorDock: true,
  showRailDock: true,
  idleMillingEnabled: true,
  focusMode: false,
  quietMode: false,
  followSelection: false,
};

export const LAB_OPERATOR_PREFS: OperatorPreferences = {
  name: "Citadel Marshal",
  preset: "nightwatch",
  layoutMode: "immersive",
  motionMode: "balanced",
  showCollabOverlay: true,
  showInspectorDock: false,
  showRailDock: true,
  idleMillingEnabled: true,
  focusMode: true,
  quietMode: true,
  followSelection: true,
};

export const OFFICE_PAGE_VARIANTS: Record<
  OfficePageVariant,
  {
    pageId: "office" | "officeLab";
    storageKey: string;
    eyebrow: string;
    headerHint: string;
    defaultPrefs: OperatorPreferences;
    initialDockTab: OfficeDockTab;
  }
> = {
  stable: {
    pageId: "office",
    storageKey: "goatcitadel.office.operator",
    eyebrow: "Office",
    headerHint:
      "Herd HQ stays immersive. Use the dock and inspector to move between visual awareness and operational detail.",
    defaultPrefs: DEFAULT_OPERATOR_PREFS,
    initialDockTab: "inspector",
  },
  lab: {
    pageId: "officeLab",
    storageKey: "goatcitadel.office.lab.operator",
    eyebrow: "Office Lab",
    headerHint:
      "Citadel Lab keeps the same live office runtime but starts from a separate citadel-first profile so both offices can be compared safely.",
    defaultPrefs: LAB_OPERATOR_PREFS,
    initialDockTab: "rail",
  },
};

export const MOTION_MODE_OPTIONS: Array<{ value: OfficeMotionMode; label: string }> = [
  { value: "cinematic", label: "Cinematic" },
  { value: "balanced", label: "Balanced" },
  { value: "subtle", label: "Subtle" },
  { value: "reduced", label: "Reduced" },
];

export const PLAYBACK_SPEED_OPTIONS: Array<{ value: string; label: string }> = [
  { value: "1", label: "1x" },
  { value: "2", label: "2x" },
  { value: "4", label: "4x" },
];

export const PRESET_OPTIONS: Array<{ value: OperatorPreset; label: string }> = [
  { value: "trailblazer", label: "Trailblazer" },
  { value: "strategist", label: "Strategist" },
  { value: "nightwatch", label: "Nightwatch" },
];

export const PRESET_DETAILS: Record<
  OperatorPreset,
  {
    title: string;
    description: string;
    bestFor: string;
    swatchClass: string;
  }
> = {
  trailblazer: {
    title: "Trailblazer",
    description: "Warm palette with assertive leadership presence.",
    bestFor: "Best for high-tempo build and delivery sessions.",
    swatchClass: "preset-trailblazer",
  },
  strategist: {
    title: "Strategist",
    description: "Balanced palette with measured planning posture.",
    bestFor: "Best for architecture, sequencing, and roadmap sessions.",
    swatchClass: "preset-strategist",
  },
  nightwatch: {
    title: "Nightwatch",
    description: "Cool palette with observant command-center vibe.",
    bestFor: "Best for monitoring, triage, and long-running operations.",
    swatchClass: "preset-nightwatch",
  },
};
