import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const MANIFEST_GIT_PATH = "scripts/verification/baselines/storage-migrations.json";
const SAFE_GIT_REF = /^[0-9A-Za-z][0-9A-Za-z._/-]*$/u;

async function resolveCommit({ repoRoot, ref, required, validateRef }) {
  if (validateRef && (!SAFE_GIT_REF.test(ref) || ref.includes("..") || ref.endsWith("/"))) {
    throw new Error(`Storage migration base ref is invalid: ${JSON.stringify(ref)}.`);
  }

  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "--verify", `${ref}^{commit}`], {
      cwd: repoRoot,
      encoding: "utf8",
      windowsHide: true,
    });
    return stdout.trim();
  } catch (error) {
    if (!required) {
      return undefined;
    }
    throw new Error(`Storage migration base ref ${JSON.stringify(ref)} is unavailable.`, { cause: error });
  }
}

export async function loadStorageMigrationBaseManifest({ repoRoot, explicitRef, fallbackRef = "origin/main" }) {
  const requestedRef = explicitRef?.trim();
  let ref = requestedRef || fallbackRef;

  if (!ref) {
    const parentSha = await resolveCommit({ repoRoot, ref: "HEAD^", required: false, validateRef: false });
    if (parentSha) {
      ref = parentSha;
    } else {
      return undefined;
    }
  }

  const headSha = await resolveCommit({ repoRoot, ref: "HEAD", required: false, validateRef: false });
  let baseSha = await resolveCommit({
    repoRoot,
    ref,
    required: Boolean(requestedRef),
    validateRef: true,
  });
  const fallbackResolvedToHead = Boolean(baseSha && headSha && baseSha === headSha);
  if (!baseSha || fallbackResolvedToHead) {
    if (requestedRef) {
      throw new Error(
        `Storage migration base ref ${JSON.stringify(ref)} resolves to the candidate HEAD; provide an immutable base ref.`,
      );
    }
    const parentSha = await resolveCommit({ repoRoot, ref: "HEAD^", required: false, validateRef: false });
    if (!parentSha) {
      if (!fallbackResolvedToHead) {
        return undefined;
      }
      throw new Error(
        `Storage migration fallback ref ${JSON.stringify(ref)} is unavailable or resolves to HEAD; set GOATCITADEL_STORAGE_MIGRATION_BASE_REF to an immutable base commit.`,
      );
    }
    ref = parentSha;
    baseSha = parentSha;
  }

  let source;
  try {
    ({ stdout: source } = await execFileAsync("git", ["show", `${baseSha}:${MANIFEST_GIT_PATH}`], {
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
