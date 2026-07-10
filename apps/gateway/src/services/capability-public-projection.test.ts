import { describe, expect, it } from "vitest";
import type { CodeModeRunArtifactPreview } from "@goatcitadel/contracts";
import {
  projectCapabilityPublicValue,
  projectCapabilityToolSchemaForPublic,
  projectCodeModeRunArtifactPreviewForPublic,
} from "./capability-public-projection.js";

describe("capability public projection", () => {
  it("projects arbitrary capability evidence without changing ids, hashes, or raw input", () => {
    const raw = {
      proposalId: "proposal-1",
      payload: { token: "proposal-short" },
      originatingRun: {
        runId: "run-1",
        codeHash: "sha256:stored-code",
        stdoutPreview: "Authorization: Bearer stdout-short",
        result: { password: "result-short", requestCount: 2 },
        errorDetails: {
          endpoint: "https://hooks.slack.com/services/team/bot/signing-short",
        },
      },
    };

    const projected = projectCapabilityPublicValue(raw);

    expect(projected).toMatchObject({
      proposalId: "proposal-1",
      payload: { token: "[REDACTED]" },
      originatingRun: {
        runId: "run-1",
        codeHash: "sha256:stored-code",
        stdoutPreview: "Authorization: [REDACTED]",
        result: { password: "[REDACTED]", requestCount: 2 },
        errorDetails: {
          endpoint: "https://hooks.slack.com/services/[REDACTED]/[REDACTED]/[REDACTED]",
        },
      },
    });
    expect(raw.payload.token).toBe("proposal-short");
    expect(raw.originatingRun.stdoutPreview).toContain("stdout-short");
  });

  it("keeps stored artifact hashes while reporting whether public content was redacted", () => {
    const raw = createPreview('{"token":"artifact-short","ok":true}');
    const clean = createPreview('{"ok":true}');

    const projected = projectCodeModeRunArtifactPreviewForPublic(raw);
    const cleanProjected = projectCodeModeRunArtifactPreviewForPublic(clean);

    expect(projected).toMatchObject({
      content: '{"token":"[REDACTED]","ok":true}',
      artifact: { sha256: "sha256:stored-raw" },
      sha256: "sha256:stored-raw",
      publicProjection: {
        contentRedacted: true,
        canonicalSha256RefersToStoredArtifact: true,
      },
    });
    expect(cleanProjected.publicProjection).toEqual({
      contentRedacted: false,
      canonicalSha256RefersToStoredArtifact: true,
    });
    expect(raw.content).toContain("artifact-short");
    expect(raw.publicProjection).toBeUndefined();
  });

  it("preserves JSON Schema container shapes while hiding secret-property example values", () => {
    const raw = {
      schema: {
        type: "object",
        properties: {
          password: {
            type: "string",
            enum: ["first-secret", "second-secret"],
            examples: ["example-secret"],
          },
          passwordProfile: {
            type: "object",
            default: {
              primary: "primary-secret",
              history: ["older-secret"],
            },
          },
          profile: {
            type: "object",
            default: {
              password: ["nested-secret-a", "nested-secret-b"],
              nested: { apiKey: "deep-nested-secret" },
              label: "safe label",
            },
            examples: [{ apiKey: "nested-example-secret", enabled: true }],
          },
        },
        additionalItems: {
          type: "object",
          properties: { password: { type: "string" } },
        },
        contentSchema: {
          type: "object",
          properties: { token: { type: "string" } },
        },
        dependencies: {
          password: ["username"],
          profile: {
            properties: { apiKey: { type: "string" } },
          },
        },
        dependentRequired: {
          password: ["username", "token"],
        },
      },
    };

    const projected = projectCapabilityToolSchemaForPublic(raw);

    expect(projected.schema.properties.password).toMatchObject({
      type: "string",
      enum: ["[REDACTED]", "[REDACTED]"],
      examples: ["[REDACTED]"],
    });
    expect(projected.schema.properties.passwordProfile.default).toEqual({
      primary: "[REDACTED]",
      history: ["[REDACTED]"],
    });
    expect(projected.schema.properties.profile).toMatchObject({
      default: {
        password: ["[REDACTED]", "[REDACTED]"],
        nested: { apiKey: "[REDACTED]" },
        label: "safe label",
      },
      examples: [{ apiKey: "[REDACTED]", enabled: true }],
    });
    expect(projected.schema.additionalItems).toEqual(raw.schema.additionalItems);
    expect(projected.schema.contentSchema).toEqual(raw.schema.contentSchema);
    expect(projected.schema.dependencies).toEqual(raw.schema.dependencies);
    expect(projected.schema.dependentRequired).toEqual(raw.schema.dependentRequired);
    expect(JSON.stringify(projected)).not.toContain("first-secret");
    expect(JSON.stringify(projected)).not.toContain("nested-secret");
    expect(raw.schema.properties.password.enum).toEqual(["first-secret", "second-secret"]);
    expect(raw.schema.properties.passwordProfile.default.primary).toBe("primary-secret");
  });
});

function createPreview(content: string): CodeModeRunArtifactPreview {
  return {
    runId: "run-1",
    artifactKind: "stdout",
    artifact: {
      artifactId: "artifact-1",
      relPath: "data/code-mode/stdout.txt",
      sha256: "sha256:stored-raw",
      bytes: content.length,
      mimeType: "text/plain",
      createdAt: "2026-07-09T00:00:00.000Z",
    },
    content,
    sha256: "sha256:stored-raw",
    verifiedAt: "2026-07-09T00:00:00.000Z",
    truncated: false,
  };
}
