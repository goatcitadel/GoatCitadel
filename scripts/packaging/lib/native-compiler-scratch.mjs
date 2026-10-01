import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const PREFIX = "gc-cl-";
const MAX_SCRATCH_PATH_LENGTH = 160;

/** MSVC's linker response-file path does not support deeply nested TEMP roots. */
export function withNativeCompilerScratch(operation, temporaryRoots = [
  os.tmpdir(),
  process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "Temp"),
]) {
  let scratch;
  let parent;
  for (const candidate of temporaryRoots) {
    if (typeof candidate !== "string" || !path.isAbsolute(candidate)) continue;
    let canonical;
    try {
      canonical = fs.realpathSync.native(candidate);
      if (!fs.statSync(canonical).isDirectory()) continue;
    } catch {
      continue;
    }
    if (path.join(canonical, `${PREFIX}XXXXXX`).length > MAX_SCRATCH_PATH_LENGTH) continue;
    parent = canonical;
    scratch = fs.mkdtempSync(path.join(parent, PREFIX));
    break;
  }
  if (!scratch) throw new Error("Native compilation needs an existing short absolute temporary directory.");
  const created = fs.lstatSync(scratch);
  try {
    return operation(scratch);
  } finally {
    removeOwnedScratch(scratch, parent, created);
  }
}

function removeOwnedScratch(scratch, parent, created) {
  // Delete only the fresh directory created by this invocation. A replaced
  // directory or junction is retained for review rather than followed.
  const current = fs.lstatSync(scratch);
  if (
    path.dirname(scratch) !== parent ||
    !path.basename(scratch).startsWith(PREFIX) ||
    current.isSymbolicLink() ||
    !current.isDirectory() ||
    current.dev !== created.dev ||
    current.ino !== created.ino ||
    fs.realpathSync.native(scratch).toLowerCase() !== scratch.toLowerCase()
  ) throw new Error("Native compiler scratch ownership changed; cleanup was withheld.");
  fs.rmSync(scratch, { recursive: true });
}
