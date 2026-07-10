import { describe, expect, it } from "vitest";
import type { ChatGeneratedArtifactRecord, ChatSessionRecord } from "@goatcitadel/contracts";
import { projectChatGeneratedArtifactForPublic, projectChatSessionForPublic } from "./chat-secret-projection.js";

describe("chat secret projection", () => {
  it("projects legacy generated-artifact content without changing canonical content or hash truth", () => {
    const artifact: ChatGeneratedArtifactRecord = {
      artifactId: "artifact-1",
      sessionId: "session-1",
      turnId: "turn-1",
      title: "password: legacy-title-secret",
      kind: "markdown",
      content:
        '{\\"DATABASE_PASSWORD\\":\\"legacy-content-secret\\",\\"webhookUrl\\":\\"https://hooks.example.test/services/team/legacy-hook-secret\\"}',
      sourceSurface: "chat",
      version: 1,
      contentHash: "sha256:stored-content",
      createdAt: "2026-07-09T12:00:00.000Z",
      updatedAt: "2026-07-09T12:00:00.000Z",
    };

    const projected = projectChatGeneratedArtifactForPublic(artifact);

    expect(JSON.stringify(projected)).not.toContain("legacy-title-secret");
    expect(JSON.stringify(projected)).not.toContain("legacy-content-secret");
    expect(JSON.stringify(projected)).not.toContain("legacy-hook-secret");
    expect(projected.contentHash).toBe("sha256:stored-content");
    expect(projected.publicProjection).toEqual(
      expect.objectContaining({
        contentRedacted: true,
        canonicalContentHashRefersToStoredArtifact: true,
      }),
    );
    expect(artifact.title).toContain("legacy-title-secret");
    expect(artifact.content).toContain("legacy-content-secret");
  });

  it("does not claim content was redacted when only generated-artifact metadata changed", () => {
    const artifact: ChatGeneratedArtifactRecord = {
      artifactId: "artifact-title-only",
      sessionId: "session-1",
      turnId: "turn-1",
      title: "password: legacy-title-secret",
      kind: "markdown",
      content: "credential-free content",
      sourceSurface: "chat",
      version: 1,
      contentHash: "sha256:stored-content",
      createdAt: "2026-07-09T12:00:00.000Z",
      updatedAt: "2026-07-09T12:00:00.000Z",
    };

    const projected = projectChatGeneratedArtifactForPublic(artifact);

    expect(projected.publicProjection).toMatchObject({
      artifactRedacted: true,
      contentRedacted: false,
      redactionCount: 1,
    });
  });

  it("projects generated-artifact reference metadata nested in public session records", () => {
    const session = {
      sessionId: "session-reference",
      sessionKey: "mission:operator:reference",
      scope: "mission",
      includeInHistory: true,
      pinned: false,
      lifecycleStatus: "active",
      channel: "mission",
      account: "operator",
      updatedAt: "2026-07-09T12:00:00.000Z",
      lastActivityAt: "2026-07-09T12:00:00.000Z",
      tokenTotal: 0,
      costUsdTotal: 0,
      generatedArtifacts: [
        {
          artifactId: "artifact-reference",
          kind: "markdown",
          title: "Authorization: Bearer nested-reference-secret",
          sourceSurface: "chat",
          version: 1,
          createdAt: "2026-07-09T12:00:00.000Z",
        },
      ],
    } satisfies ChatSessionRecord;

    const projected = projectChatSessionForPublic(session);

    expect(JSON.stringify(projected)).not.toContain("nested-reference-secret");
    expect(projected.tokenTotal).toBe(0);
    expect(session.generatedArtifacts?.[0]?.title).toContain("nested-reference-secret");
  });
});
