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
  const metadata = options.metadata ?? adapter.probe(config);
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
