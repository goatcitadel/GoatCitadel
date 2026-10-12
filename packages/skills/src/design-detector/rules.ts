/**
 * Text-detectable design rules. Each is a regex approximation of a craft-floor rule (pointer in
 * `craftFloorRule`) or of the calibrated anti-slop table the Ops design-quality check already used.
 * They are GoatCitadel-authored heuristics, not impeccable's rule engine, and they are always advisory.
 */

export interface DesignDetectorRule {
  id: string;
  severity: "advisory";
  /** Fixed operator-facing one-liner; never derived from the scanned text. */
  summary: string;
  /** Craft-floor comment marker the rule approximates (`<!-- rule:... -->` in reference/craft-floor.md). */
  craftFloorRule?: string;
  re: RegExp;
}

/**
 * The calibrated anti-slop table. Ids and regexes are shared byte for byte with the Ops design-quality
 * check (`design-quality.ts` imports this table); do not change them without updating that check's fixtures.
 */
export const ANTI_SLOP_PATTERNS = [
  {
    id: "default-indigo",
    re: /#(?:6366f1|4f46e5|4338ca|3730a3|8b5cf6|7c3aed|a855f7)\b/iu,
  },
  {
    id: "generic-trust-gradient",
    re: /linear-gradient\([^)]*(?:purple|violet|indigo|#6366f1|#4f46e5|#8b5cf6|#7c3aed|#a855f7|#3b82f6|#06b6d4|cyan|pink)[^)]*\)/iu,
  },
  {
    id: "emoji-as-ui-icon",
    re: /[✨🚀🎯⚡🔥💡]/u,
  },
  {
    id: "invented-metric",
    re: /\b(?:10×\s+(?:faster|better|easier)|100×\s+(?:faster|better)|99\.\d+%\s+uptime|zero[- ]downtime|3×\s+more\s+(?:productive|efficient))\b/iu,
  },
  {
    id: "lorem-copy",
    re: /\blorem\s+ipsum\b/iu,
  },
  {
    id: "feature-one-copy",
    re: /\bfeature\s+(one|two|three|1|2|3)\b/iu,
  },
  {
    id: "placeholder-copy",
    re: /\bplaceholder\s+text\b/iu,
  },
] as const;

const ANTI_SLOP_SUMMARIES: Record<
  (typeof ANTI_SLOP_PATTERNS)[number]["id"],
  { summary: string; craftFloorRule: string }
> = {
  "default-indigo": {
    summary: "Default indigo or violet palette; use the workspace or token accent.",
    craftFloorRule: "skill-reflex-theme-by-habit",
  },
  "generic-trust-gradient": {
    summary: "Generic purple-to-cyan gradient; pick one accent.",
    craftFloorRule: "skill-reflex-theme-by-habit",
  },
  "emoji-as-ui-icon": {
    summary: "Emoji used as an icon; use a drawn icon at one stroke weight.",
    craftFloorRule: "skill-ban-glyph-icons",
  },
  "invented-metric": {
    summary: "Invented metric copy; use measured numbers or none.",
    craftFloorRule: "skill-copy-design-material",
  },
  "lorem-copy": { summary: "Lorem ipsum placeholder copy.", craftFloorRule: "skill-copy-design-material" },
  "feature-one-copy": { summary: "Placeholder feature names.", craftFloorRule: "skill-copy-design-material" },
  "placeholder-copy": { summary: "Placeholder text left in copy.", craftFloorRule: "skill-copy-design-material" },
};

const CRAFT_FLOOR_RULES: readonly DesignDetectorRule[] = [
  {
    id: "gradient-text",
    severity: "advisory",
    summary: "Gradient text; carry emphasis with weight or size.",
    craftFloorRule: "skill-ban-gradient-text",
    re: /(?:-webkit-)?background-clip\s*:\s*text|\bbg-clip-text\b/iu,
  },
  {
    id: "side-stripe-border",
    severity: "advisory",
    summary: "Colored side-stripe border above 1px on a card, list item, callout, or alert.",
    craftFloorRule: "skill-ban-side-stripe-borders",
    re: /border-(?:left|right)\s*:\s*(?:[2-9]|\d{2,})(?:\.\d+)?px|\bborder-[lr]-(?:[2-9]|\d{2,})\b/iu,
  },
  {
    id: "hard-offset-shadow",
    severity: "advisory",
    summary: "Hard zero-blur offset shadow; a depth system needs offset and soft blur.",
    craftFloorRule: "skill-ban-hard-offset-shadow",
    re: /box-shadow\s*:\s*-?[1-9]\d*(?:\.\d+)?px\s+-?[1-9]\d*(?:\.\d+)?px\s+0(?:px)?(?=\s|;|$)/iu,
  },
  {
    id: "glass-by-default",
    severity: "advisory",
    summary: "Backdrop blur used as decoration rather than as a specific effect.",
    craftFloorRule: "skill-ban-glassmorphism-default",
    re: /backdrop-filter\s*:\s*[^;]*blur\(|\bbackdrop-blur(?:-[a-z0-9]+)?\b/iu,
  },
  {
    id: "numbered-section-marker",
    severity: "advisory",
    summary: "Numbered section markers (01 / 02) that carry no information.",
    craftFloorRule: "skill-ban-numbered-section-markers",
    re: /\b0[1-9]\s*(?:\/|·|—|–)\s*0[1-9]\b/u,
  },
  {
    id: "kicker-eyebrow",
    severity: "advisory",
    summary: "Kicker or eyebrow label above a heading; let the heading carry its own weight.",
    craftFloorRule: "skill-ban-eyebrow-on-every-section",
    re: /\b(?:kicker|eyebrow)\b/iu,
  },
  {
    id: "bounce-easing",
    severity: "advisory",
    summary: "Overshoot or bounce easing; use an exponential ease-out from a visible default.",
    craftFloorRule: "skill-motion-floor",
    re: /cubic-bezier\(\s*[^,()]+,\s*[^,()]+,\s*[^,()]+,\s*(?:1\.0*[1-9]\d*|[2-9](?:\.\d+)?|\d{2,}(?:\.\d+)?)\s*\)|\bease-(?:in|out|in-out)-back\b|\belastic\b|\bbounce\b/iu,
  },
];

/** Bump when a rule id, regex, or summary changes; memo keys and evidence cite it. */
export const DESIGN_DETECTOR_RULES_VERSION = 1;

export const DESIGN_DETECTOR_RULES: readonly DesignDetectorRule[] = Object.freeze([
  ...ANTI_SLOP_PATTERNS.map((pattern) => ({
    id: pattern.id,
    severity: "advisory" as const,
    summary: ANTI_SLOP_SUMMARIES[pattern.id].summary,
    craftFloorRule: ANTI_SLOP_SUMMARIES[pattern.id].craftFloorRule,
    re: pattern.re,
  })),
  ...CRAFT_FLOOR_RULES,
]);
