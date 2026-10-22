import { describe, expect, it } from "vitest";
import { hasSubstantiveSeedQuery, resolveTurnWebLookupIntent } from "./web-research-mode.js";

describe("resolveTurnWebLookupIntent", () => {
  it("treats Deep mode as web lookup when nothing else claims the turn", () => {
    expect(
      resolveTurnWebLookupIntent({
        webMode: "deep",
        detectedWebLookupIntent: false,
        localFileIntent: false,
        workflowSkillCapture: false,
      }),
    ).toBe(true);
  });

  it("lets local-file intent win over Deep mode", () => {
    expect(
      resolveTurnWebLookupIntent({
        webMode: "deep",
        detectedWebLookupIntent: false,
        localFileIntent: true,
        workflowSkillCapture: false,
      }),
    ).toBe(false);
  });

  it("never turns on web lookup when web is off", () => {
    expect(
      resolveTurnWebLookupIntent({
        webMode: "off",
        detectedWebLookupIntent: true,
        localFileIntent: false,
        workflowSkillCapture: false,
      }),
    ).toBe(false);
  });

  it("keeps Auto mode on regex detection only", () => {
    const base = { webMode: "auto" as const, localFileIntent: false, workflowSkillCapture: false };
    expect(resolveTurnWebLookupIntent({ ...base, detectedWebLookupIntent: false })).toBe(false);
    expect(resolveTurnWebLookupIntent({ ...base, detectedWebLookupIntent: true })).toBe(true);
  });
});

describe("hasSubstantiveSeedQuery", () => {
  it("rejects a greeting", () => {
    expect(hasSubstantiveSeedQuery("hi")).toBe(false);
  });

  it("rejects a short follow-up made of stopwords and two words", () => {
    expect(hasSubstantiveSeedQuery("make it shorter")).toBe(false);
  });

  it("accepts a real research question", () => {
    expect(hasSubstantiveSeedQuery("Compare Debezium vs Postgres logical replication")).toBe(true);
  });

  it("ignores one-character tokens and stopwords in any case", () => {
    expect(hasSubstantiveSeedQuery("Hello, please  a b c")).toBe(false);
    expect(hasSubstantiveSeedQuery("")).toBe(false);
  });

  it("counts words in scripts without whitespace separators", () => {
    expect(hasSubstantiveSeedQuery("比较一下这两种数据库复制方案的优缺点")).toBe(true);
  });

  it("rejects a short CJK greeting", () => {
    expect(hasSubstantiveSeedQuery("你好")).toBe(false);
  });
});
