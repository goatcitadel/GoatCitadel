import fs from "node:fs";
import path from "node:path";
import type { CodeModeSandboxPlatform, CommandResolver } from "./types.js";

export const defaultCommandResolver: CommandResolver = (command, platform) => {
  if (path.isAbsolute(command)) {
    return fs.existsSync(command) ? command : undefined;
  }

  for (const candidate of buildCandidates(command, platform)) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return undefined;
};

function buildCandidates(command: string, platform: CodeModeSandboxPlatform): string[] {
  const pathValue = process.env.PATH ?? "";
  const segments = pathValue.split(path.delimiter).filter(Boolean);
  if (platform !== "win32") {
    return segments.map((segment) => path.join(segment, command));
  }

  const extensions = command.includes(".") ? [""] : buildWindowsExtensions();
  return segments.flatMap((segment) => extensions.map((extension) => path.join(segment, `${command}${extension}`)));
}

function buildWindowsExtensions(): string[] {
  const pathExt = process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD";
  return pathExt
    .split(";")
    .map((extension) => extension.trim())
    .filter(Boolean);
}
