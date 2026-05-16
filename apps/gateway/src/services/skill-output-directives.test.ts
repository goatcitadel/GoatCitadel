import { describe, expect, it } from "vitest";
import { parseSkillOutputDirectives } from "./skill-output-directives.js";

describe("parseSkillOutputDirectives", () => {
  it("returns text unchanged when no directive present", () => {
    const result = parseSkillOutputDirectives("Just a plain message.");
    expect(result.text).toBe("Just a plain message.");
    expect(result.directives).toEqual([]);
  });

  it("parses [[as_document fileName=report.md mimeType=text/markdown]]...[[/as_document]] blocks", () => {
    const input = `Here is your report:
[[as_document fileName=report.md mimeType=text/markdown]]
# Quarterly Report
Numbers and figures.
[[/as_document]]
End of message.`;
    const result = parseSkillOutputDirectives(input);
    expect(result.text).toMatch(/Here is your report:/);
    expect(result.text).toMatch(/End of message\./);
    expect(result.text).not.toMatch(/as_document/);
    expect(result.directives).toHaveLength(1);
    expect(result.directives[0]).toEqual({
      kind: "document",
      fileName: "report.md",
      mimeType: "text/markdown",
      content: "# Quarterly Report\nNumbers and figures.",
    });
  });

  it("supports multiple document blocks", () => {
    const input = `[[as_document fileName=a.txt mimeType=text/plain]]A[[/as_document]]
[[as_document fileName=b.txt mimeType=text/plain]]B[[/as_document]]`;
    const result = parseSkillOutputDirectives(input);
    expect(result.directives).toHaveLength(2);
    expect(result.directives[0]?.fileName).toBe("a.txt");
    expect(result.directives[1]?.fileName).toBe("b.txt");
  });

  it("falls back to default mimeType when omitted", () => {
    const input = `[[as_document fileName=note.txt]]hello[[/as_document]]`;
    const result = parseSkillOutputDirectives(input);
    expect(result.directives[0]?.mimeType).toBe("text/plain");
  });

  it("ignores malformed directives by leaving them as text", () => {
    const input = `[[as_document]]no filename[[/as_document]]`;
    const result = parseSkillOutputDirectives(input);
    expect(result.directives).toEqual([]);
    expect(result.text).toContain("[[as_document]]");
  });

  it("supports quoted attribute values", () => {
    const input = `[[as_document fileName="my file.md" mimeType="text/markdown"]]content[[/as_document]]`;
    const result = parseSkillOutputDirectives(input);
    expect(result.directives[0]?.fileName).toBe("my file.md");
    expect(result.directives[0]?.mimeType).toBe("text/markdown");
  });

  it("trims content of leading/trailing whitespace", () => {
    const input = `[[as_document fileName=note.md]]\n\n  content with surrounding ws  \n\n[[/as_document]]`;
    const result = parseSkillOutputDirectives(input);
    expect(result.directives[0]?.content).toBe("content with surrounding ws");
  });
});
