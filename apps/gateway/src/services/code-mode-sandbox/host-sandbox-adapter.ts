import os from "node:os";
import { defaultCommandResolver } from "./command-resolution.js";
import { DarwinSeatbeltSandboxAdapter } from "./darwin-seatbelt-adapter.js";
import { LinuxFirejailSandboxAdapter } from "./linux-firejail-adapter.js";
import type { CodeModeHostSandboxAdapter, CommandResolver, CodeModeSandboxPlatform } from "./types.js";
import { normalizeSandboxPlatform } from "./types.js";
import { UnavailableSandboxAdapter } from "./unavailable-adapter.js";
import { WindowsAppContainerSandboxAdapter } from "./windows-appcontainer-adapter.js";

export interface HostSandboxAdapterSelectionOptions {
  platform?: NodeJS.Platform | string;
  resolveCommand?: CommandResolver;
  osRelease?: string;
}

export function selectCodeModeHostSandboxAdapter(
  options: HostSandboxAdapterSelectionOptions = {},
): CodeModeHostSandboxAdapter {
  const platform = normalizeSandboxPlatform(options.platform ?? process.platform);
  const dependencies = {
    platform,
    resolveCommand: options.resolveCommand ?? defaultCommandResolver,
    osRelease: options.osRelease ?? os.release(),
  };

  switch (platform satisfies CodeModeSandboxPlatform) {
    case "linux":
      return new LinuxFirejailSandboxAdapter(dependencies);
    case "darwin":
      return new DarwinSeatbeltSandboxAdapter(dependencies);
    case "win32":
      return new WindowsAppContainerSandboxAdapter(dependencies);
    case "unknown":
      return new UnavailableSandboxAdapter(platform);
  }
}
