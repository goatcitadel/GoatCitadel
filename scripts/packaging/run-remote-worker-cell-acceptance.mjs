import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { stageWorkerCellAcceptance, verifyWorkerCellAcceptance } from "./lib/remote-worker-cell-acceptance-files.mjs";

export function parseWorkerCellAcceptanceArguments(args) {
  let expectedManifestSha256, mode = "boundary";
  const seen = new Set();
  for (let index = 0; index < args.length; index++) {
    const option = args[index];
    if (seen.has(option)) throw new Error("Repeated cell acceptance option.");
    seen.add(option);
    if (option === "--manifest-sha256") expectedManifestSha256 = args[++index];
    else if (option === "--attachment" || option === "--preflight") {
      if (mode !== "boundary") throw new Error("Choose either preflight or attachment acceptance.");
      mode = option.slice(2);
    } else throw new Error("Usage: --manifest-sha256 <independent hash> [--preflight|--attachment]");
  }
  if (!/^[a-f0-9]{64}$/u.test(expectedManifestSha256 ?? "")) throw new Error("An independent manifest hash is required.");
  return { expectedManifestSha256, mode };
}

export function runWorkerCellAcceptance(args) {
  const { expectedManifestSha256, mode } = parseWorkerCellAcceptanceArguments(args);
  if (process.platform !== "win32" || process.arch !== "x64") throw new Error("Native cell acceptance requires Windows x64.");
  const root = path.resolve(import.meta.dirname, "../../..");
  const reference = { root, expectedManifestSha256 };
  verifyWorkerCellAcceptance(reference);
  const node = path.join(root, "app/runtime/node.exe");
  if (fs.realpathSync.native(process.execPath).toLowerCase() !== fs.realpathSync.native(node).toLowerCase())
    throw new Error("Run acceptance with the package's own app/runtime/node.exe.");
  // Never inherit Node hooks, provider credentials, admission configuration or
  // a caller's volume-attachment flag. The explicit CLI mode owns that choice.
  const env = { SystemRoot: process.env.SystemRoot, TEMP: os.tmpdir(), TMP: os.tmpdir() };
  let result;
  if (mode === "preflight") {
    const output = fs.mkdtempSync(path.join(os.tmpdir(), "Goat Cell Preflight "));
    const staged = stageWorkerCellAcceptance(reference, output);
    result = spawnSync(staged.controller, ["--volume-preflight"], { env, cwd: output, windowsHide: true,
      encoding: "utf8", timeout: 15000, maxBuffer: 65536 });
    fs.writeFileSync(path.join(output, "preflight.log"), `${result.stdout ?? ""}${result.stderr ?? ""}`, { flag: "wx" });
    console.log(`Retained cell privilege preflight: ${output}`);
    if (result.status === 0 && JSON.parse(result.stdout).volumePrivilegeAvailable !== true)
      throw new Error("Native privilege preflight did not confirm its outcome.");
    if (result.stderr) process.stderr.write(result.stderr);
  } else {
    env.GOATCITADEL_NATIVE_CELL_PACKAGE_ROOT = root;
    env.GOATCITADEL_NATIVE_CELL_PACKAGE_SHA256 = expectedManifestSha256;
    if (mode === "attachment") env.GOATCITADEL_NATIVE_VHD_ATTACHMENT_PROOF = "1";
    result = spawnSync(node, ["--test", path.join(root, "app/scripts/packaging/remote-worker-windows-cell.test.mjs")], {
      env, cwd: root, windowsHide: true, stdio: "inherit", timeout: 200000,
    });
  }
  verifyWorkerCellAcceptance(reference);
  if (result.error) throw result.error;
  return result.status ?? 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = runWorkerCellAcceptance(process.argv.slice(2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
