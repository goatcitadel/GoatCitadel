import { expect, it } from "vitest";
import type { ChatGeneratedArtifactRecord } from "@goatcitadel/contracts";
import { readArtifactRunId } from "./artifact-run-link";
const artifact: ChatGeneratedArtifactRecord = {
  artifactId: "artifact",
  workspaceId: "one",
  sessionId: "session",
  turnId: "turn",
  title: "Artifact",
  kind: "markdown",
  content: "Result",
  contentHash: "a".repeat(64),
  version: 1,
  sourceSurface: "chat",
  createdAt: "2026-10-14",
  updatedAt: "2026-10-14",
};
it.each([
  { legacy: { runId: "direct" }, expected: "direct" },
  { legacy: { durableRunId: "durable" }, expected: "durable" },
  { legacy: { trace: { durable: { runId: "nested" } } }, expected: "nested" },
  { legacy: { trace: { durableRunId: "trace-durable" } }, expected: "trace-durable" },
  { legacy: { trace: { runId: "trace" } }, expected: "trace" },
])("retains the existing historical artifact execution linkage $expected", ({ legacy, expected }) => {
  expect(readArtifactRunId({ ...artifact, ...legacy })).toBe(expected);
});
it("preserves canonical linkage precedence and nullish fallback", () => {
  const direct = { ...artifact, runId: "direct", durableRunId: "other", trace: { runId: "old" } };
  expect(readArtifactRunId(direct)).toBe("direct");
  expect(
    readArtifactRunId({ ...artifact, runId: null, durableRunId: "fallback" } as unknown as ChatGeneratedArtifactRecord),
  ).toBe("fallback");
  expect(readArtifactRunId(artifact)).toBeUndefined();
});
