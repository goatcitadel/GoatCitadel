import { describe, expect, it } from "vitest";
import { ANTI_SLOP_PATTERNS, DESIGN_DETECTOR_RULES, detectDesignAdvisories } from "./design-detector/index.js";

const CASES: ReadonlyArray<{ ruleId: string; positive: string; negative: string; craftFloorRule?: string }> = [
  { ruleId: "default-indigo", positive: "color: #6366f1;", negative: "color: #006f85;" },
  {
    ruleId: "generic-trust-gradient",
    positive: "background: linear-gradient(90deg, purple, cyan);",
    negative: "background: linear-gradient(90deg, #006f85, #0f172a);",
  },
  {
    ruleId: "emoji-as-ui-icon",
    positive: "<span>🚀 Launch</span>",
    negative: "<Rocket aria-hidden />",
    craftFloorRule: "skill-ban-glyph-icons",
  },
  {
    ruleId: "invented-metric",
    positive: "<p>10× faster than before</p>",
    negative: "<p>Measured 2.1s to first paint</p>",
    craftFloorRule: "skill-copy-design-material",
  },
  { ruleId: "lorem-copy", positive: "<p>Lorem ipsum dolor</p>", negative: "<p>Welcome back, Ana.</p>" },
  { ruleId: "feature-one-copy", positive: "<h3>Feature One</h3>", negative: "<h3>Exports</h3>" },
  { ruleId: "placeholder-copy", positive: "<p>Placeholder text here</p>", negative: "<p>Ready when you are.</p>" },
  {
    ruleId: "gradient-text",
    positive: ".hero h1 { background-clip: text; -webkit-text-fill-color: transparent; }",
    negative: ".hero h1 { color: var(--fg); }",
    craftFloorRule: "skill-ban-gradient-text",
  },
  {
    ruleId: "side-stripe-border",
    positive: ".callout { border-left: 4px solid var(--accent); }",
    negative: ".callout { border-left: 1px solid var(--line); }",
    craftFloorRule: "skill-ban-side-stripe-borders",
  },
  {
    ruleId: "hard-offset-shadow",
    positive: ".card { box-shadow: 4px 4px 0 #000; }",
    negative: ".card { box-shadow: 0 8px 24px rgb(0 0 0 / 0.16); }",
    craftFloorRule: "skill-ban-hard-offset-shadow",
  },
  {
    ruleId: "glass-by-default",
    positive: '<div className="backdrop-blur-md bg-white/30">',
    negative: '<div className="bg-raised">',
    craftFloorRule: "skill-ban-glassmorphism-default",
  },
  {
    ruleId: "numbered-section-marker",
    positive: "<span>01 / 03</span>",
    negative: "<span>Step 1 of 3</span>",
    craftFloorRule: "skill-ban-numbered-section-markers",
  },
  {
    ruleId: "kicker-eyebrow",
    positive: '<p className="eyebrow">Overview</p>',
    negative: '<h2 className="text-lg">Overview</h2>',
    craftFloorRule: "skill-ban-eyebrow-on-every-section",
  },
  {
    ruleId: "bounce-easing",
    positive: "transition: transform 300ms cubic-bezier(0.68, -0.55, 0.27, 1.55);",
    negative: "transition: transform 160ms cubic-bezier(0.2, 0, 0, 1);",
    craftFloorRule: "skill-motion-floor",
  },
];

describe("design detector rules", () => {
  it("keeps the seven shared anti-slop ids and regexes", () => {
    expect(ANTI_SLOP_PATTERNS.map((pattern) => pattern.id)).toEqual([
      "default-indigo",
      "generic-trust-gradient",
      "emoji-as-ui-icon",
      "invented-metric",
      "lorem-copy",
      "feature-one-copy",
      "placeholder-copy",
    ]);
    expect(ANTI_SLOP_PATTERNS.every((pattern) => pattern.re instanceof RegExp)).toBe(true);
  });

  it("covers every rule with a positive and a negative case", () => {
    expect(new Set(DESIGN_DETECTOR_RULES.map((rule) => rule.id)).size).toBe(DESIGN_DETECTOR_RULES.length);
    expect(CASES.map((item) => item.ruleId).sort()).toEqual(DESIGN_DETECTOR_RULES.map((rule) => rule.id).sort());
    expect(DESIGN_DETECTOR_RULES.every((rule) => rule.severity === "advisory" && rule.summary.length > 0)).toBe(true);
  });

  it.each(CASES)("fires $ruleId on its positive and not on its negative", (item) => {
    const positive = detectDesignAdvisories(`/* line one */\n${item.positive}`);
    const negative = detectDesignAdvisories(item.negative);

    expect(positive.map((advisory) => advisory.ruleId)).toContain(item.ruleId);
    expect(positive.find((advisory) => advisory.ruleId === item.ruleId)?.line).toBe(2);
    if (item.craftFloorRule) {
      expect(positive.find((advisory) => advisory.ruleId === item.ruleId)?.craftFloorRule).toBe(item.craftFloorRule);
    }
    expect(negative.map((advisory) => advisory.ruleId)).not.toContain(item.ruleId);
  });
});

describe("detectDesignAdvisories", () => {
  it("reports each rule once, sorted by line, capped at eight findings and about one kilobyte", () => {
    const text = [...CASES.map((item) => item.positive), ...CASES.map((item) => item.positive)].join("\n");
    const advisories = detectDesignAdvisories(text);

    expect(advisories).toHaveLength(8);
    expect(new Set(advisories.map((advisory) => advisory.ruleId)).size).toBe(8);
    expect(advisories.map((advisory) => advisory.line)).toEqual(
      [...advisories.map((advisory) => advisory.line)].sort((a, b) => a - b),
    );
    expect(Buffer.byteLength(JSON.stringify(advisories), "utf8")).toBeLessThanOrEqual(1280);
    expect(detectDesignAdvisories(text, { maxFindings: 3 })).toHaveLength(3);
  });

  it("never echoes the scanned text", () => {
    const secret = "sk-live-SECRET-TOKEN-123";
    const advisories = detectDesignAdvisories(`.hero { background-clip: text; } /* ${secret} */`);

    expect(advisories.length).toBeGreaterThan(0);
    expect(JSON.stringify(advisories)).not.toContain(secret);
    expect(JSON.stringify(advisories)).not.toContain("background-clip");
  });

  it("returns nothing for clean text", () => {
    expect(detectDesignAdvisories(".panel { padding: 16px; border: 1px solid var(--line); }")).toEqual([]);
    expect(detectDesignAdvisories("")).toEqual([]);
  });
});
