import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatGeneratedArtifactRecord } from "@goatcitadel/contracts";

const detect = vi.hoisted(() => ({ calls: 0 }));
vi.mock("@goatcitadel/skills", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@goatcitadel/skills")>();
  return {
    ...actual,
    detectDesignAdvisories: (text: string) => {
      detect.calls += 1;
      return actual.detectDesignAdvisories(text);
    },
  };
});

import { ARTIFACT_ADVISORY_CACHE_MAX, withDesignAdvisories } from "./chat-generated-artifact-advisories.js";

function artifact(overrides: Partial<ChatGeneratedArtifactRecord>): ChatGeneratedArtifactRecord {
  return {
    artifactId: "artifact-1",
    sessionId: "sess-1",
    turnId: "turn-1",
    title: "Hero",
    kind: "html",
    content: '<div class="backdrop-blur-md">hero</div>',
    sourceSurface: "chat",
    version: 1,
    contentHash: "hash-1",
    createdAt: "2026-10-12T00:00:00.000Z",
    updatedAt: "2026-10-12T00:00:00.000Z",
    ...overrides,
  } as ChatGeneratedArtifactRecord;
}

beforeEach(() => {
  detect.calls = 0;
});

describe("withDesignAdvisories", () => {
  it("derives advisories once per content hash and reuses them across reads", () => {
    const first = withDesignAdvisories(artifact({ artifactId: "a" }));
    const second = withDesignAdvisories(artifact({ artifactId: "b" }));

    expect(first.designAdvisories?.map((advisory) => advisory.ruleId)).toEqual(["glass-by-default"]);
    expect(second.designAdvisories).toEqual(first.designAdvisories);
    expect(detect.calls).toBe(1);
  });

  it("scans again for a different hash and never for non-HTML or redacted artifacts", () => {
    withDesignAdvisories(artifact({ contentHash: "hash-2", content: '<p class="eyebrow">x</p>' }));
    expect(detect.calls).toBe(1);

    const markdown = withDesignAdvisories(artifact({ kind: "markdown", contentHash: "hash-3" }));
    const redacted = withDesignAdvisories(
      artifact({
        contentHash: "hash-4",
        publicProjection: {
          contentRedacted: true,
          redactedPaths: ["content"],
          canonicalContentHashRefersToStoredArtifact: true,
        },
      }),
    );
    expect(markdown).not.toHaveProperty("designAdvisories");
    expect(redacted).not.toHaveProperty("designAdvisories");
    expect(detect.calls).toBe(1);
  });

  it("keeps the cache bounded", () => {
    for (let index = 0; index < ARTIFACT_ADVISORY_CACHE_MAX + 1; index += 1) {
      withDesignAdvisories(artifact({ contentHash: `bulk-${index}` }));
    }
    expect(detect.calls).toBe(ARTIFACT_ADVISORY_CACHE_MAX + 1);
    withDesignAdvisories(artifact({ contentHash: "bulk-0" }));
    expect(detect.calls).toBe(ARTIFACT_ADVISORY_CACHE_MAX + 2);
  });
});
