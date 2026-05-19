import { ValidationError, type TaskArtifactClaim, type TaskArtifactVerification } from "@goatcitadel/contracts";
import { assertHostAllowed, assertReadPathAllowed, redactUrlForError } from "@goatcitadel/policy-engine";

export const MAX_TASK_ARTIFACT_CLAIMS = 25;
export const MAX_TASK_ARTIFACT_CLAIM_VALUE_CHARS = 2048;
export const MAX_TASK_ARTIFACT_CLAIM_LABEL_CHARS = 200;

const DEFAULT_ARTIFACT_VERIFICATION_CONCURRENCY = 4;
const COMMIT_SHA_PATTERN = /^[a-fA-F0-9]{7,64}$/;

export interface ArtifactProbers {
  fs: { statExists(path: string): Promise<boolean> };
  http: { headOk(url: string): Promise<boolean> };
  git: { hasCommit(sha: string): Promise<boolean> };
  now?: () => string;
  fileReadRoots?: string[];
  networkAllowlist?: string[];
  maxConcurrency?: number;
}

export async function verifyClaimedArtifacts(
  claims: TaskArtifactClaim[],
  probers: ArtifactProbers,
): Promise<TaskArtifactVerification[]> {
  validateClaimBatch(claims);
  const at = probers.now ? probers.now() : new Date().toISOString();
  const results = new Array<TaskArtifactVerification>(claims.length);
  let nextIndex = 0;
  const concurrency = Math.max(
    1,
    Math.min(claims.length, probers.maxConcurrency ?? DEFAULT_ARTIFACT_VERIFICATION_CONCURRENCY),
  );
  const workers = Array.from({ length: concurrency }, async () => {
    while (nextIndex < claims.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await verifyOne(claims[index]!, probers, at);
    }
  });
  await Promise.all(workers);
  return results;
}

async function verifyOne(
  claim: TaskArtifactClaim,
  probers: ArtifactProbers,
  at: string,
): Promise<TaskArtifactVerification> {
  try {
    const exists = await probe(claim, probers);
    return { claim, status: exists ? "verified" : "missing", checkedAt: at };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { claim, status: "failed", checkedAt: at, detail };
  }
}

async function probe(claim: TaskArtifactClaim, probers: ArtifactProbers): Promise<boolean> {
  if (claim.kind === "file") {
    assertReadPathAllowed(claim.value, resolveFileReadRoots(probers), []);
    return probers.fs.statExists(claim.value);
  }
  if (claim.kind === "url") {
    assertHttpUrl(claim.value);
    assertHostAllowed(claim.value, probers.networkAllowlist ?? []);
    return probers.http.headOk(claim.value);
  }
  if (!COMMIT_SHA_PATTERN.test(claim.value)) {
    throw new Error("Commit SHA claim must be a 7-64 character hexadecimal Git object id.");
  }
  return probers.git.hasCommit(claim.value);
}

function validateClaimBatch(claims: TaskArtifactClaim[]): void {
  if (claims.length > MAX_TASK_ARTIFACT_CLAIMS) {
    throw new ValidationError({
      message: `Artifact verification accepts at most ${MAX_TASK_ARTIFACT_CLAIMS} claims per request`,
    });
  }
  for (const claim of claims) {
    if (claim.value.length > MAX_TASK_ARTIFACT_CLAIM_VALUE_CHARS) {
      throw new ValidationError({
        message: `Artifact claim values must be at most ${MAX_TASK_ARTIFACT_CLAIM_VALUE_CHARS} characters`,
      });
    }
    if (claim.label && claim.label.length > MAX_TASK_ARTIFACT_CLAIM_LABEL_CHARS) {
      throw new ValidationError({
        message: `Artifact claim labels must be at most ${MAX_TASK_ARTIFACT_CLAIM_LABEL_CHARS} characters`,
      });
    }
  }
}

function resolveFileReadRoots(probers: ArtifactProbers): string[] {
  const roots = (probers.fileReadRoots ?? []).map((root) => root.trim()).filter(Boolean);
  return roots.length > 0 ? roots : [process.cwd()];
}

function assertHttpUrl(value: string): void {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`Artifact URL is invalid: ${redactUrlForError(value)}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`Artifact URL protocol is not allowed: ${parsed.protocol}`);
  }
}
