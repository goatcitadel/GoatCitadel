import path from "node:path";
import { spawnSync } from "node:child_process";

if (process.platform !== "win32" || process.arch !== "x64") {
  throw new Error("Native volume attachment acceptance requires Windows x64.");
}
// Explicit operator-run lane. The native preflight checks an existing privilege
// in a temporary token; this script never elevates or grants a user right.
const result = spawnSync(process.execPath, ["--test", path.join(import.meta.dirname, "remote-worker-windows-cell.test.mjs")], {
  cwd: path.resolve(import.meta.dirname, "../.."),
  env: { ...process.env, GOATCITADEL_NATIVE_VHD_ATTACHMENT_PROOF: "1" },
  windowsHide: true,
  stdio: "inherit",
  timeout: 200000,
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
