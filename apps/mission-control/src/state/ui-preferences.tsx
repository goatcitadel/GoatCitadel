import { createContext, useContext, useMemo, useState, type ReactNode } from "react";
import type { UiEffectsMode } from "./effects-mode";
import type { ShellNavMode } from "../components/ShellNavRail";

export type UiExperienceMode = "simple" | "advanced";
export type UiDensity = "comfortable" | "default" | "compact";

interface UiPreferencesValue {
  mode: UiExperienceMode;
  setMode: (mode: UiExperienceMode) => void;
  density: UiDensity;
  setDensity: (density: UiDensity) => void;
  effectsMode: UiEffectsMode;
  setEffectsMode: (mode: UiEffectsMode) => void;
  navMode: ShellNavMode;
  setNavMode: (mode: ShellNavMode) => void;
  showTechnicalDetails: boolean;
  setShowTechnicalDetails: (enabled: boolean) => void;
  detailPanelPinned: boolean;
  setDetailPanelPinned: (enabled: boolean) => void;
  activeWorkspaceId: string;
  setActiveWorkspaceId: (workspaceId: string) => void;
}

const MODE_KEY = "goatcitadel.ui.mode.v1";
const DENSITY_KEY = "goatcitadel.ui.density.v1";
const EFFECTS_MODE_KEY = "goatcitadel.ui.effects_mode.v1";
const NAV_MODE_KEY = "goatcitadel.ui.nav_mode.v1";
const DETAILS_KEY = "goatcitadel.ui.technical_details.v1";
const DETAIL_PANEL_PINNED_KEY = "goatcitadel.ui.detail_panel_pinned.v1";
const WORKSPACE_KEY = "goatcitadel.ui.workspace_id.v1";

const UiPreferencesContext = createContext<UiPreferencesValue>({
  mode: "simple",
  setMode: () => {},
  density: "default",
  setDensity: () => {},
  effectsMode: "auto",
  setEffectsMode: () => {},
  navMode: "expanded",
  setNavMode: () => {},
  showTechnicalDetails: false,
  setShowTechnicalDetails: () => {},
  detailPanelPinned: false,
  setDetailPanelPinned: () => {},
  activeWorkspaceId: "default",
  setActiveWorkspaceId: () => {},
});

export function UiPreferencesProvider(props: { children: ReactNode }) {
  const [mode, setModeState] = useState<UiExperienceMode>(() => readModeFromStorage());
  const [density, setDensityState] = useState<UiDensity>(() => readDensityFromStorage());
  const [effectsMode, setEffectsModeState] = useState<UiEffectsMode>(() => readEffectsModeFromStorage());
  const [navMode, setNavModeState] = useState<ShellNavMode>(() => readNavModeFromStorage());
  const [showTechnicalDetails, setShowTechnicalDetailsState] = useState<boolean>(() => readDetailsFromStorage());
  const [detailPanelPinned, setDetailPanelPinnedState] = useState<boolean>(() => readDetailPanelPinnedFromStorage());
  const [activeWorkspaceId, setActiveWorkspaceIdState] = useState<string>(() => readWorkspaceIdFromStorage());

  const value = useMemo<UiPreferencesValue>(
    () => ({
      mode,
      setMode: (nextMode) => {
        setModeState(nextMode);
        writeStorage(MODE_KEY, nextMode);
        const nextShowDetails = nextMode === "advanced";
        setShowTechnicalDetailsState(nextShowDetails);
        writeStorage(DETAILS_KEY, String(nextShowDetails));
      },
      density,
      setDensity: (nextDensity) => {
        setDensityState(nextDensity);
        writeStorage(DENSITY_KEY, nextDensity);
      },
      effectsMode,
      setEffectsMode: (nextEffectsMode) => {
        setEffectsModeState(nextEffectsMode);
        writeStorage(EFFECTS_MODE_KEY, nextEffectsMode);
      },
      navMode,
      setNavMode: (nextNavMode) => {
        setNavModeState(nextNavMode);
        writeStorage(NAV_MODE_KEY, nextNavMode);
      },
      showTechnicalDetails,
      setShowTechnicalDetails: (enabled) => {
        setShowTechnicalDetailsState(enabled);
        writeStorage(DETAILS_KEY, String(enabled));
      },
      detailPanelPinned,
      setDetailPanelPinned: (enabled) => {
        setDetailPanelPinnedState(enabled);
        writeStorage(DETAIL_PANEL_PINNED_KEY, String(enabled));
      },
      activeWorkspaceId,
      setActiveWorkspaceId: (workspaceId) => {
        const normalized = normalizeWorkspaceId(workspaceId);
        setActiveWorkspaceIdState(normalized);
        writeStorage(WORKSPACE_KEY, normalized);
      },
    }),
    [mode, density, effectsMode, navMode, showTechnicalDetails, detailPanelPinned, activeWorkspaceId],
  );

  return <UiPreferencesContext.Provider value={value}>{props.children}</UiPreferencesContext.Provider>;
}

export function useUiPreferences(): UiPreferencesValue {
  return useContext(UiPreferencesContext);
}

function readModeFromStorage(): UiExperienceMode {
  if (typeof window === "undefined") {
    return "simple";
  }
  const raw = window.localStorage.getItem(MODE_KEY);
  return raw === "advanced" ? "advanced" : "simple";
}

function readDetailsFromStorage(): boolean {
  if (typeof window === "undefined") {
    return false;
  }
  const raw = window.localStorage.getItem(DETAILS_KEY);
  if (raw === "true") {
    return true;
  }
  if (raw === "false") {
    return false;
  }
  const mode = readModeFromStorage();
  return mode === "advanced";
}

function readDensityFromStorage(): UiDensity {
  if (typeof window === "undefined") {
    return "default";
  }
  const raw = window.localStorage.getItem(DENSITY_KEY);
  if (raw === "comfortable" || raw === "compact") {
    return raw;
  }
  return "default";
}

function readEffectsModeFromStorage(): UiEffectsMode {
  if (typeof window === "undefined") {
    return "auto";
  }
  const raw = window.localStorage.getItem(EFFECTS_MODE_KEY);
  if (raw === "full" || raw === "reduced") {
    return raw;
  }
  return "auto";
}

function readNavModeFromStorage(): ShellNavMode {
  if (typeof window === "undefined") {
    return "expanded";
  }
  const raw = window.localStorage.getItem(NAV_MODE_KEY);
  if (raw === "compact" || raw === "icon") {
    return raw;
  }
  return "expanded";
}

function readDetailPanelPinnedFromStorage(): boolean {
  if (typeof window === "undefined") {
    return false;
  }
  return window.localStorage.getItem(DETAIL_PANEL_PINNED_KEY) === "true";
}

function writeStorage(key: string, value: string): void {
  if (typeof window === "undefined") {
    return;
  }
  window.localStorage.setItem(key, value);
}

function readWorkspaceIdFromStorage(): string {
  if (typeof window === "undefined") {
    return "default";
  }
  return normalizeWorkspaceId(window.localStorage.getItem(WORKSPACE_KEY));
}

function normalizeWorkspaceId(value: string | null | undefined): string {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) {
    return "default";
  }
  return /^[a-zA-Z0-9._-]{1,80}$/.test(trimmed) ? trimmed : "default";
}
