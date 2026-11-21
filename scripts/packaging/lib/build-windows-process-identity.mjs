import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const WINDOWS_PROCESS_IDENTITY_NAME = "GoatCitadel-Process-Identity.exe";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const source = path.join(root, "apps", "mission-control-windows", "Native", "process_identity.rs");

export function buildWindowsProcessIdentity(outputDirectory, target) {
  const options = { cwd: root, windowsHide: true, encoding: "utf8", timeout: 60_000 };
  const toolchain = spawnSync("rustc", ["--print", "target-libdir", "--target", target], options);
  if (toolchain.error?.code === "ENOENT") return undefined;
  requireCompilerSuccess(toolchain);
  if (!fs.existsSync(toolchain.stdout.trim())) return undefined;

  const executable = path.join(outputDirectory, WINDOWS_PROCESS_IDENTITY_NAME);
  requireCompilerSuccess(spawnSync("rustc", [
    "--crate-name", "goatcitadel_process_identity", "--edition=2024", "--target", target,
    "-C", "opt-level=s", "-C", "panic=abort", "-C", "strip=symbols", "-C", "target-feature=+crt-static",
    "--remap-path-prefix", `${root}=.`, "-o", executable, source,
  ], options));
  return executable;
}

function requireCompilerSuccess(result) {
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Process identity helper compilation failed\n${result.stderr.trim()}`);
}
