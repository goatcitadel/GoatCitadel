import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export type TuiAuthMode = "none" | "token" | "basic";

export interface TuiProfile {
  gatewayBaseUrl: string;
  authMode: TuiAuthMode;
  username?: string;
  tokenQueryParam?: string;
  defaultScope?: "operator" | "personal";
  pollIntervalsMs?: {
    dashboard?: number;
    activity?: number;
    approvals?: number;
  };
  ui?: {
    denseMode?: boolean;
    confirmRiskyWrites?: boolean;
    colorLevel?: "auto" | "off";
  };
}

export interface TuiResolvedAuth {
  mode: TuiAuthMode;
  token?: string;
  username?: string;
  password?: string;
}

export interface TuiResolvedProfile {
  profileName: string;
  filePath: string;
  profile: TuiProfile;
  auth: TuiResolvedAuth;
}

const DEFAULT_PROFILE: TuiProfile = {
  gatewayBaseUrl: "http://127.0.0.1:8787",
  authMode: "none",
  tokenQueryParam: "access_token",
  defaultScope: "operator",
  pollIntervalsMs: {
    dashboard: 5000,
    activity: 2500,
    approvals: 5000,
  },
  ui: {
    denseMode: false,
    confirmRiskyWrites: true,
    colorLevel: "auto",
  },
};

export async function loadResolvedProfile(options: {
  profileName?: string;
  gatewayOverride?: string;
}): Promise<TuiResolvedProfile> {
  const profileName = (options.profileName?.trim() || "default").replace(/[^a-zA-Z0-9._-]/g, "_");
  const dir = path.join(os.homedir(), ".GoatCitadel");
  const filePath = path.join(dir, profileName === "default" ? "tui-profile.json" : `tui-profile-${profileName}.json`);
  const profile = withDefaults(await readProfileFile(filePath));

  if (options.gatewayOverride?.trim()) {
    profile.gatewayBaseUrl = options.gatewayOverride.trim();
  }
  if (process.env.GOATCITADEL_GATEWAY_URL?.trim()) {
    profile.gatewayBaseUrl = process.env.GOATCITADEL_GATEWAY_URL.trim();
  }
  const envMode = process.env.GOATCITADEL_TUI_AUTH_MODE;
  if (envMode === "none" || envMode === "token" || envMode === "basic") {
    profile.authMode = envMode;
  }
  const resolvedProfile = sanitizeProfile(profile);

  const auth: TuiResolvedAuth = {
    mode: resolvedProfile.authMode,
    token: process.env.GOATCITADEL_AUTH_TOKEN?.trim() || undefined,
    username: process.env.GOATCITADEL_AUTH_BASIC_USERNAME?.trim() || resolvedProfile.username,
    password: process.env.GOATCITADEL_AUTH_BASIC_PASSWORD || undefined,
  };

  return {
    profileName,
    filePath,
    profile: resolvedProfile,
    auth,
  };
}

export async function saveProfile(filePath: string, profile: TuiProfile): Promise<void> {
  const safe = sanitizeProfile(profile);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(safe, null, 2)}\n`, "utf8");
}

function withDefaults(input: Partial<TuiProfile> | undefined): TuiProfile {
  const merged: TuiProfile = {
    ...DEFAULT_PROFILE,
    ...(input ?? {}),
    pollIntervalsMs: {
      ...DEFAULT_PROFILE.pollIntervalsMs,
      ...(input?.pollIntervalsMs ?? {}),
    },
    ui: {
      ...DEFAULT_PROFILE.ui,
      ...(input?.ui ?? {}),
    },
  };
  return sanitizeProfile(merged);
}

function sanitizeProfile(profile: TuiProfile): TuiProfile {
  const base = profile.gatewayBaseUrl?.trim() || DEFAULT_PROFILE.gatewayBaseUrl;
  const normalized = base.replace(/\/+$/, "");
  return {
    gatewayBaseUrl: normalized,
    authMode: profile.authMode === "token" || profile.authMode === "basic" ? profile.authMode : "none",
    username: profile.username?.trim() || undefined,
    tokenQueryParam: profile.tokenQueryParam?.trim() || "access_token",
    defaultScope: profile.defaultScope === "personal" ? "personal" : "operator",
    pollIntervalsMs: {
      dashboard: clampMs(profile.pollIntervalsMs?.dashboard, 5000),
      activity: clampMs(profile.pollIntervalsMs?.activity, 2500),
      approvals: clampMs(profile.pollIntervalsMs?.approvals, 5000),
    },
    ui: {
      denseMode: Boolean(profile.ui?.denseMode),
      confirmRiskyWrites: profile.ui?.confirmRiskyWrites !== false,
      colorLevel: profile.ui?.colorLevel === "off" ? "off" : "auto",
    },
  };
}

async function readProfileFile(filePath: string): Promise<Partial<TuiProfile> | undefined> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return undefined;
    }
    return parsed as Partial<TuiProfile>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    return undefined;
  }
}

function clampMs(value: number | undefined, fallback: number): number {
  if (typeof value !== "number" || Number.isNaN(value) || value <= 100) {
    return fallback;
  }
  return Math.min(60_000, Math.max(500, Math.floor(value)));
}
