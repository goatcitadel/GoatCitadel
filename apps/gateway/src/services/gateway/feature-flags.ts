import { createHash } from "node:crypto";
import {
  CHANGE_PLAN_RUNTIME_FEATURE_FLAGS,
  LEGACY_FALSE_FEATURE_FLAGS,
  SHIPPED_FEATURE_CONTROLS,
  SHIPPED_FEATURE_FLAGS,
  ValidationError,
  isShippedFeatureFlag,
  type FeaturePreferenceMetadata,
  type FeaturePreferenceReview,
  type ShippedFeatureFlag,
} from "@goatcitadel/contracts";
import type { RuntimeSettings } from "./runtime-settings.js";

export type GatewayFeatureFlags = RuntimeSettings["features"];
export type StoredFeatureFlags = Partial<GatewayFeatureFlags> & { reviewed?: ShippedFeatureFlag[] };

/** Read earlier row formats without promoting removed fields into a config generation. */
export function readStoredFeatureFlags(raw: StoredFeatureFlags | undefined): StoredFeatureFlags {
  const flags: StoredFeatureFlags = {};
  for (const flag of CHANGE_PLAN_RUNTIME_FEATURE_FLAGS) {
    const value = raw?.[flag];
    if (typeof value === "boolean") flags[flag] = value;
  }
  if (Array.isArray(raw?.reviewed)) {
    const reviewed = raw.reviewed.filter((flag) => typeof flag === "string" && isShippedFeatureFlag(flag));
    if (reviewed.length) flags.reviewed = [...new Set(reviewed)];
  }
  return flags;
}

/** Policy and profile inputs used to resolve preferences against an explicit stored snapshot. */
interface FeaturePreferenceSources {
  profile: Partial<GatewayFeatureFlags>;
  environment: Partial<GatewayFeatureFlags>;
  capabilities?: Record<string, unknown> & {
    codeModeSandbox?: { bestEffortHostEnabled?: boolean; required?: boolean };
  };
  sandboxRequired?: boolean;
  previousOperatorChoices?: Partial<Record<ShippedFeatureFlag, boolean>>;
}

/** Separately retains the configured canonical snapshot for Gateway startup and recovery. */
export interface FeatureConfigSources extends FeaturePreferenceSources {
  canonicalStore?: StoredFeatureFlags;
}

export function resolveGatewayFeatureFlags(
  stored: Partial<GatewayFeatureFlags> | undefined,
  fromConfig: Partial<GatewayFeatureFlags>,
): GatewayFeatureFlags {
  return Object.fromEntries(
    CHANGE_PLAN_RUNTIME_FEATURE_FLAGS.map((flag) => [
      flag,
      flag === "durableKernelV1Enabled" || (stored?.[flag] ?? fromConfig[flag] ?? isShippedFeatureFlag(flag)),
    ]),
  ) as unknown as GatewayFeatureFlags;
}

export function buildUpdatedFeatureFlags(
  current: GatewayFeatureFlags,
  patch: Partial<GatewayFeatureFlags>,
): GatewayFeatureFlags {
  return resolveGatewayFeatureFlags(patch, current);
}

export function configurationFeatureFlags(sources: FeaturePreferenceSources): GatewayFeatureFlags {
  return resolveGatewayFeatureFlags(sources.environment, {
    // An inherited availability default must never opt an advisory-only host into executing code.
    codeModeV1Enabled: sources.sandboxRequired === false ? false : undefined,
    codeModeHostSandboxEnabled: sources.capabilities?.codeModeSandbox?.bestEffortHostEnabled,
    ...sources.profile,
  });
}

export function featurePreferenceMetadata(
  sources: FeaturePreferenceSources,
  stored: StoredFeatureFlags,
): FeaturePreferenceMetadata {
  const result: FeaturePreferenceMetadata = { sources: {}, upgradeReview: [], upgradeFingerprint: "" };
  const held = [];
  for (const flag of SHIPPED_FEATURE_FLAGS) {
    const fileValue =
      sources.profile[flag] ??
      (flag === "codeModeHostSandboxEnabled"
        ? sources.capabilities?.codeModeSandbox?.bestEffortHostEnabled
        : undefined);
    const env = sources.environment[flag];
    const runtime = stored[flag];
    const value = runtime ?? env ?? fileValue;
    const source =
      runtime !== undefined
        ? "operator"
        : env !== undefined
          ? "environment"
          : fileValue !== undefined
            ? "profile"
            : "default";
    if (
      value === false &&
      source !== "environment" &&
      LEGACY_FALSE_FEATURE_FLAGS.has(flag) &&
      !stored.reviewed?.includes(flag) &&
      sources.previousOperatorChoices?.[flag] !== false
    ) {
      result.sources[flag] = "legacy";
      result.upgradeReview.push(flag);
      held.push([
        flag,
        runtime,
        env,
        fileValue,
        flag === "codeModeHostSandboxEnabled" && sources.capabilities?.codeModeSandbox?.bestEffortHostEnabled,
      ]);
    } else {
      result.sources[flag] = source;
    }
  }
  result.upgradeFingerprint = createHash("sha256").update(JSON.stringify(held)).digest("hex");
  return result;
}

export function updateFeaturePreferences(
  sources: FeaturePreferenceSources,
  stored: StoredFeatureFlags,
  patch: Partial<GatewayFeatureFlags> = {},
  review?: FeaturePreferenceReview,
): StoredFeatureFlags {
  const next: StoredFeatureFlags = { ...stored, ...patch };
  const reviewed = new Set(stored.reviewed);
  for (const flag of Object.keys(patch)) if (isShippedFeatureFlag(flag)) reviewed.add(flag);
  if (review) {
    const metadata = featurePreferenceMetadata(sources, stored);
    if (
      metadata.upgradeFingerprint !== review.fingerprint ||
      !review.flags.length ||
      review.flags.some((flag) => !metadata.upgradeReview.includes(flag) || !SHIPPED_FEATURE_CONTROLS[flag].switchable)
    ) {
      throw new ValidationError({
        message: "Feature settings changed. Reload Settings and review the remaining features.",
      });
    }
    for (const flag of review.flags) {
      if (review.decision === "off") {
        next[flag] = false;
        reviewed.add(flag);
      } else {
        delete next[flag];
        delete sources.profile[flag];
        if (flag === "codeModeHostSandboxEnabled" && sources.capabilities?.codeModeSandbox) {
          delete sources.capabilities.codeModeSandbox.bestEffortHostEnabled;
        }
        reviewed.delete(flag);
      }
    }
  }
  if (reviewed.size) next.reviewed = [...reviewed].sort();
  else delete next.reviewed;
  return next;
}

export function didDisengageAutonomyKillSwitch(current: GatewayFeatureFlags, next: GatewayFeatureFlags): boolean {
  return current.autonomyV1Disabled === true && next.autonomyV1Disabled !== true;
}
