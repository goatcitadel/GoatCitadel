import { describe, expect, it } from "vitest";
import { extractHostCandidatesForTests } from "./engine.js";

// Regression coverage for CODEX_FINDING #22 (Matrix/Mattermost attachments
// bypass per-grant allowedHosts). The fix walks attachments[].url so the
// `allowedHosts` constraint applies to attachment fetches, not just to the
// top-level args.url/host/target.

describe("extractHostCandidates with attachments (codex #22)", () => {
  it("returns the top-level args.url host", () => {
    expect(extractHostCandidatesForTests({ url: "https://matrix.example.org/_matrix" })).toContain(
      "matrix.example.org",
    );
  });

  it("returns hosts from args.attachments[].url", () => {
    const hosts = extractHostCandidatesForTests({
      url: "https://matrix.example.org/_matrix",
      attachments: [{ url: "https://internal.example.com/secret.bin" }, { url: "https://other.example.com/" }],
    });
    expect(hosts).toContain("matrix.example.org");
    expect(hosts).toContain("internal.example.com");
    expect(hosts).toContain("other.example.com");
  });

  it("walks args.files[].url too", () => {
    const hosts = extractHostCandidatesForTests({ files: [{ url: "https://drive.example.com/file.bin" }] });
    expect(hosts).toContain("drive.example.com");
  });

  it("walks downloadUrl and href on attachment records", () => {
    const hosts = extractHostCandidatesForTests({
      attachments: [{ downloadUrl: "https://a.example.com/x" }, { href: "https://b.example.com/y" }],
    });
    expect(hosts).toContain("a.example.com");
    expect(hosts).toContain("b.example.com");
  });

  it("safely ignores non-array attachments", () => {
    expect(
      extractHostCandidatesForTests({ attachments: "not-an-array" } as unknown as Record<string, unknown>),
    ).toEqual([]);
  });

  it("safely ignores non-string url fields", () => {
    expect(extractHostCandidatesForTests({ attachments: [{ url: 42 }] } as unknown as Record<string, unknown>)).toEqual(
      [],
    );
  });
});
