import type { TargetInfo } from "../gateway-target/detect-target";

export type CheckTier = "read" | "mutate" | "host" | "external";
export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
/** Spelled exactly as the Gateway route-access manifest spells it, including `:params`. */
export type RouteKey = `${HttpMethod} /${string}`;
export type CheckKind = "auto" | "probe" | "journey";
export type CheckOutcomeStatus = "pass" | "fail" | "blocked";

export interface CheckResult {
  readonly status: CheckOutcomeStatus;
  readonly summary: string;
  readonly evidence?: unknown;
}

export interface CheckContext {
  readonly target: TargetInfo;
  /** The per-run seeded workspace; present only in the verified sandbox. */
  readonly workspaceId: string | undefined;
  readonly signal: AbortSignal;
  log(message: string, data?: unknown): void;
  step<T>(title: string, run: () => Promise<T>): Promise<T>;
}

export interface CheckDef {
  readonly id: string;
  readonly kind: CheckKind;
  readonly domain: string;
  readonly title: string;
  readonly tier: CheckTier;
  readonly routes: readonly RouteKey[];
  readonly description?: string;
  /** Allowlisted to run on the real gateway once confirmed. Only valid on `external` checks. */
  readonly realSafe?: true;
  /** Needs the per-run seeded workspace, which exists only in the verified sandbox. */
  readonly needsWorkspace?: true;
  /** Declared journey step titles; the drawer shows unreached ones as "not run". */
  readonly steps?: readonly string[];
  readonly timeoutMs?: number;
  run(ctx: CheckContext): Promise<CheckResult>;
}

export interface RunOptions {
  readonly allowHost: boolean;
  readonly confirmedExternalIds: ReadonlySet<string>;
}

export const DEFAULT_CHECK_TIMEOUT_MS = 60_000;
