import type { TaskArtifactClaim, TaskArtifactVerification } from "@goatcitadel/contracts";

export interface ArtifactProbers {
  fs: { statExists(path: string): Promise<boolean> };
  http: { headOk(url: string): Promise<boolean> };
  git: { hasCommit(sha: string): Promise<boolean> };
  now?: () => string;
}

export async function verifyClaimedArtifacts(
  claims: TaskArtifactClaim[],
  probers: ArtifactProbers,
): Promise<TaskArtifactVerification[]> {
  const at = probers.now ? probers.now() : new Date().toISOString();
  return Promise.all(claims.map((claim) => verifyOne(claim, probers, at)));
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
    return probers.fs.statExists(claim.value);
  }
  if (claim.kind === "url") {
    return probers.http.headOk(claim.value);
  }
  return probers.git.hasCommit(claim.value);
}
