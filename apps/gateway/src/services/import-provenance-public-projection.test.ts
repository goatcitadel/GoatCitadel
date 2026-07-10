import { describe, expect, it } from "vitest";
import { projectImportProvenanceReferencesForPublic } from "./import-provenance-public-projection.js";

describe("import provenance public projection", () => {
  it("leaves safe repository URLs and local source references byte-identical", () => {
    const raw = {
      query: "notebooklm research",
      repoUrl: "https://github.com/example/agency-agents.git",
      candidate: {
        sourceRef: "C:/workspace/skills/example/SKILL.md",
        sourceUrl: "https://github.com/example/skill.git",
        repositoryUrl: "https://github.com/example/skill.git",
        matchedTerms: ["notebooklm", "research"],
      },
    };

    expect(projectImportProvenanceReferencesForPublic(raw)).toEqual(raw);
  });

  it("projects only credential-bearing provenance references and leaves raw values and prose unchanged", () => {
    const rawUrl = "https://source-user:source-secret@example.test/private.git?token=source-secret";
    const rawMarkdown = [
      "---",
      "name: Private Skill",
      "---",
      "",
      "Operator-authored example: Authorization: Bearer prose-must-remain-byte-identical",
    ].join("\n");
    const raw = {
      query: rawUrl,
      repoUrl: rawUrl,
      candidate: {
        sourceRef: rawUrl,
        sourceUrl: rawUrl,
        repositoryUrl: rawUrl,
      },
      sources: [{ upstreamUrl: rawUrl, matchedTerms: [rawUrl, "private"], description: rawMarkdown }],
      rawMarkdown,
      operatorNote: rawMarkdown,
    };

    const projected = projectImportProvenanceReferencesForPublic(raw);

    expect(projected.query).not.toContain("source-secret");
    expect(projected.repoUrl).not.toContain("source-secret");
    expect(projected.candidate.sourceRef).not.toContain("source-secret");
    expect(projected.candidate.sourceUrl).not.toContain("source-secret");
    expect(projected.candidate.repositoryUrl).not.toContain("source-secret");
    expect(projected.sources[0]?.upstreamUrl).not.toContain("source-secret");
    expect(projected.sources[0]?.matchedTerms?.[0]).not.toContain("source-secret");
    expect(projected.sources[0]?.matchedTerms?.[1]).toBe("private");
    expect(JSON.stringify(projected)).toContain("[REDACTED]");
    expect(projected.rawMarkdown).toBe(rawMarkdown);
    expect(projected.operatorNote).toBe(rawMarkdown);
    expect(projected.sources[0]?.description).toBe(rawMarkdown);

    expect(raw.query).toBe(rawUrl);
    expect(raw.repoUrl).toBe(rawUrl);
    expect(raw.candidate.sourceRef).toBe(rawUrl);
    expect(raw.sources[0]?.upstreamUrl).toBe(rawUrl);
    expect(raw.sources[0]?.matchedTerms).toEqual([rawUrl, "private"]);
    expect(raw.rawMarkdown).toBe(rawMarkdown);
  });
});
