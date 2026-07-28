import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const MANIFEST_GIT_PATH = "scripts/verification/baselines/storage-migrations.json";
const SAFE_GIT_REF = /^[0-9A-Za-z][0-9A-Za-z._/-]*$/u;

export async function loadStorageMigrationBaseManifest({ repoRoot, explicitRef, fallbackRef = "origin/main" }) {
  const requestedRef = explicitRef?.trim();
  const ref = requestedRef || fallbackRef;
  if (!ref) {
    return undefined;
  }
  if (!SAFE_GIT_REF.test(ref) || ref.includes("..") || ref.endsWith("/")) {
    throw new Error(`Storage migration base ref is invalid: ${JSON.stringify(ref)}.`);
  }

  try {
    await execFileAsync("git", ["rev-parse", "--verify", `${ref}^{commit}`], {
      cwd: repoRoot,
      encoding: "utf8",
      windowsHide: true,
    });
  } catch (error) {
    if (!requestedRef) {
      return undefined;
    }
    throw new Error(`Storage migration base ref ${JSON.stringify(ref)} is unavailable.`, { cause: error });
  }

  let source;
  try {
    ({ stdout: source } = await execFileAsync("git", ["show", `${ref}:${MANIFEST_GIT_PATH}`], {
      cwd: repoRoot,
      encoding: "utf8",
      windowsHide: true,
      maxBuffer: 10 * 1024 * 1024,
    }));
  } catch (error) {
    throw new Error(`Could not read the storage migration manifest from base ref ${JSON.stringify(ref)}.`, {
      cause: error,
    });
  }

  try {
    return { ref, manifest: JSON.parse(source) };
  } catch (error) {
    throw new Error(`Storage migration manifest at base ref ${JSON.stringify(ref)} is not valid JSON.`, {
      cause: error,
    });
  }
}
