import type { CodeModeSandboxConfig } from "../../config.js";
import {
  buildCommonProbeChecks,
  buildSandboxMetadata,
  type CodeModeHostSandboxAdapter,
  type CodeModeSandboxLaunchInput,
  type CodeModeSandboxLaunchSpec,
  type CodeModeSandboxPlatform,
} from "./types.js";

export class UnavailableSandboxAdapter implements CodeModeHostSandboxAdapter {
  public readonly adapterId = "unavailable";

  public constructor(public readonly platform: CodeModeSandboxPlatform) {}

  public probe(config: CodeModeSandboxConfig) {
    const checks = buildCommonProbeChecks(config);
    checks.checksFailed.push(`${this.platform}_adapter_unavailable`);
    return buildSandboxMetadata({
      platform: this.platform,
      config,
      checksPassed: checks.checksPassed,
      checksFailed: checks.checksFailed,
    });
  }

  public async prepareLaunch(_input: CodeModeSandboxLaunchInput): Promise<CodeModeSandboxLaunchSpec> {
    throw new Error(`Code Mode sandbox failed closed on ${this.platform}: ${this.platform}_adapter_unavailable.`);
  }
}
