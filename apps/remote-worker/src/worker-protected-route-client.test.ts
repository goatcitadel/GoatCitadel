import { afterEach, describe, expect, it, vi } from "vitest";
import type { RetainedRuntimeCredential } from "./worker-credential-vault.js";
import { callProtectedRoute, WorkerProtectedRouteError } from "./worker-protected-route-client.js";
import { WorkerWireClient } from "./worker-wire-client.js";

const credential: RetainedRuntimeCredential = {
  credentialId: "credential-1",
  credentialGeneration: 1,
  workerGeneration: 1,
  registryWorkspaceId: "default",
  authorizationCredential: "secret-bearer",
  clientCertificateSha256: "a".repeat(64),
  workerPublicKeySpkiSha256: "b".repeat(64),
  signingPrivateKeyPem: "secret-private-key",
};
const client = new WorkerWireClient({
  host: "127.0.0.1",
  port: 1,
  clientCertificatePem: "unused",
  clientPrivateKeyPem: "unused",
  trustAnchorPem: "unused",
});

afterEach(() => vi.restoreAllMocks());

async function refused(payload: Readonly<Record<string, unknown>>, operation = "assignment.settlement.submit") {
  const post = vi.spyOn(client, "post").mockResolvedValue({ status: 403, body: { error: "secret-upstream" } });
  const outcome = await callProtectedRoute({
    client,
    credential,
    rawPath: "/api/v1/remote-workers/assignment-settlement-submissions",
    operation,
    idempotencyKey: "request-1",
    payload,
  }).catch((error: unknown) => error);
  expect(post).toHaveBeenCalledTimes(1);
  expect(outcome).toBeInstanceOf(WorkerProtectedRouteError);
  return outcome as WorkerProtectedRouteError;
}

describe("worker protected route rejection diagnostics", () => {
  it("retains the final settlement lease revision without exposing its outcome", async () => {
    const error = await refused({ leaseRevision: 17, settlement: "secret-outcome" }, "assignment.settle");
    expect(error.message).toBe("Route assignment.settle was refused (status 403, lease revision 17).");
    expect(String(error)).not.toContain("secret-");
  });
  it.each(["chat.tool", "effect.dispatch", "artifact.open", "artifact.part", "artifact.commit"])(
    "identifies %s without exposing request or response contents",
    async (kind) => {
      const error = await refused({
        leaseRevision: 17,
        leaseToken: "secret-lease",
        submission: { kind, args: "secret-tool-input" },
      });
      expect(error.message).toBe(
        `Route assignment.settlement.submit was refused (status 403, submission ${kind}, lease revision 17).`,
      );
      expect(String(error)).not.toContain("secret-");
    },
  );

  it.each([undefined, [], { kind: "secret-kind" }])("redacts unrecognized submission labels", async (submission) => {
    const error = await refused({ leaseRevision: "secret-revision", submission });
    expect(error.message).toContain("submission unrecognized, lease revision unrecognized");
    expect(String(error)).not.toContain("secret-");
  });
});
