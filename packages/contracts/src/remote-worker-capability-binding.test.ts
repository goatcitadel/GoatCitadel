import { describe, expect, it } from "vitest";
import {
  normalizeRemoteWorkerCapabilityBinding,
  sameRemoteWorkerCapabilityBinding,
} from "./remote-worker-capability-binding.js";

const scope = {
  admissionId: "admission",
  sessionIncarnationId: "incarnation",
  workspaceId: "workspace",
  sessionId: "session",
  turnId: "turn",
  aggregateRevision: 3,
  controllerGeneration: 2,
  materialSha256: "1".repeat(64),
  actorId: "actor",
  actorSource: "token" as const,
};
const admission = {
  admissionReference: {
    version: "goatcitadel.remote-worker-admission-reference.v1" as const,
    scope,
    featureReferenceSha256: "2".repeat(64),
  },
};

describe("remote worker capability authority variant", () => {
  it("preserves historical binding bytes and keeps admission evidence distinct", () => {
    const historical = { capabilityProfileSha256: "a".repeat(64) };
    expect(JSON.stringify(normalizeRemoteWorkerCapabilityBinding(historical))).toBe(JSON.stringify(historical));
    expect(normalizeRemoteWorkerCapabilityBinding(admission)).not.toHaveProperty("capabilityProfileSha256");
    expect(sameRemoteWorkerCapabilityBinding(admission, structuredClone(admission))).toBe(true);
    expect(sameRemoteWorkerCapabilityBinding(admission, historical)).toBe(false);
  });
  it.each([
    {},
    { ...admission, capabilityProfileSha256: "a".repeat(64) },
    { capabilityProfileSha256: "bad" },
    { admissionReference: { ...admission.admissionReference, credentials: "forbidden" } },
    { admissionReference: { ...admission.admissionReference, scope: { ...scope, actorSource: "none" } } },
  ])("rejects ambiguous, malformed or unscoped evidence", (value) => {
    expect(() => normalizeRemoteWorkerCapabilityBinding(value as never)).toThrow();
  });
  it("binds actor, generation and material independently", () => {
    for (const change of [{ actorId: "other" }, { controllerGeneration: 3 }, { materialSha256: "3".repeat(64) }]) {
      expect(
        sameRemoteWorkerCapabilityBinding(admission, {
          admissionReference: { ...admission.admissionReference, scope: { ...scope, ...change } },
        }),
      ).toBe(false);
    }
  });
});
