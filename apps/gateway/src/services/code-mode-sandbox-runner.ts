import fs from "node:fs/promises";
import process from "node:process";
import type { CodeModeSandboxMetadata } from "@goatcitadel/contracts";
import type { CodeModeSandboxConfig } from "../config.js";
import {
  selectCodeModeHostSandboxAdapter,
  type HostSandboxAdapterSelectionOptions,
} from "./code-mode-sandbox/host-sandbox-adapter.js";
import {
  buildAdvisoryUnsandboxedLaunchSpec,
  type CodeModeSandboxLaunchInput,
  type CodeModeSandboxLaunchSpec,
} from "./code-mode-sandbox/types.js";

export type { CodeModeSandboxLaunchInput, CodeModeSandboxLaunchSpec } from "./code-mode-sandbox/types.js";
export type { HostSandboxAdapterSelectionOptions } from "./code-mode-sandbox/host-sandbox-adapter.js";

export interface PrepareCodeModeSandboxLaunchOptions extends HostSandboxAdapterSelectionOptions {
  metadata?: CodeModeSandboxMetadata;
}

export interface PreparedCodeModeSandboxLaunch {
  metadata: CodeModeSandboxMetadata;
  launch: CodeModeSandboxLaunchSpec;
}

export function resolveCodeModeSandboxMetadata(
  config: CodeModeSandboxConfig,
  options: HostSandboxAdapterSelectionOptions = {},
): CodeModeSandboxMetadata {
  return selectCodeModeHostSandboxAdapter(options).probe(config);
}

export function assertCodeModeSandboxAvailable(metadata: CodeModeSandboxMetadata): void {
  if (metadata.required && !metadata.available) {
    throw new Error(metadata.failClosedReason ?? "Code Mode sandbox is unavailable.");
  }
}

export async function prepareCodeModeSandboxLaunch(
  config: CodeModeSandboxConfig,
  input: CodeModeSandboxLaunchInput,
  options: PrepareCodeModeSandboxLaunchOptions = {},
): Promise<PreparedCodeModeSandboxLaunch> {
  await fs.mkdir(input.runTempRoot, { recursive: true });
  const adapter = selectCodeModeHostSandboxAdapter(options);
  const currentMetadata = adapter.probe(config);
  if (options.metadata) {
    const mismatchedField = findSandboxMetadataMismatch(options.metadata, currentMetadata);
    if (mismatchedField) {
      throw new Error(
        `Code Mode sandbox posture changed before launch at ${mismatchedField}; refusing to execute run.`,
      );
    }
  }
  const metadata = options.metadata ?? currentMetadata;
  if (!metadata.available) {
    assertCodeModeSandboxAvailable(metadata);
    return {
      metadata,
      launch: buildAdvisoryUnsandboxedLaunchSpec(input),
    };
  }

  return {
    metadata,
    launch: await adapter.prepareLaunch(input),
  };
}

export function resolveCurrentCodeModeSandboxMetadata(config: CodeModeSandboxConfig): CodeModeSandboxMetadata {
  return resolveCodeModeSandboxMetadata(config, { platform: process.platform });
}

function findSandboxMetadataMismatch(
  expected: CodeModeSandboxMetadata,
  current: CodeModeSandboxMetadata,
): string | undefined {
  const scalarMismatch = (
    [
      "runnerId",
      "runnerVersion",
      "platform",
      "isolationProfile",
      "required",
      "available",
      "failClosedReason",
      "advisoryUnsandboxedReason",
    ] as const
  ).find((field) => expected[field] !== current[field]);
  return (
    scalarMismatch ??
    (["checksPassed", "checksFailed"] as const).find((field) => !sameSandboxCheckList(expected[field], current[field]))
  );
}

function sameSandboxCheckList(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) {
    return false;
  }
  return left.every((value, index) => value === right[index]);
}
