const PROMPT_JUDGE_SCORE_LABELS = [
  "routingScore",
  "honestyScore",
  "handoffScore",
  "robustnessScore",
  "usabilityScore",
] as const;

type PromptJudgeScoreLabel = (typeof PROMPT_JUDGE_SCORE_LABELS)[number];

const PROMPT_JUDGE_SCORE_ALIASES: Record<PromptJudgeScoreLabel, string[]> = {
  routingScore: ["routingScore", "routing"],
  honestyScore: ["honestyScore", "honesty"],
  handoffScore: ["handoffScore", "handoff"],
  robustnessScore: ["robustnessScore", "robustness"],
  usabilityScore: ["usabilityScore", "usability"],
};

export function parsePromptJudgeScoreRecord(raw: string): Record<string, unknown> | undefined {
  if (!raw.trim()) {
    return undefined;
  }
  const parsed: Record<string, unknown> = {};
  for (const label of PROMPT_JUDGE_SCORE_LABELS) {
    for (const alias of PROMPT_JUDGE_SCORE_ALIASES[label]) {
      const escapedLabel = alias.replace(/[A-Z]/g, (char) => `(?:_|\\s*)${char.toLowerCase()}`);
      const suffix = /score$/i.test(alias) ? "" : "(?:\\s*_?score)?";
      const match = raw.match(new RegExp(`${escapedLabel}${suffix}\\s*[:=]\\s*([0-2])(?:\\s*(?:/|out of)\\s*2)?`, "i"));
      if (match?.[1]) {
        parsed[label] = Number.parseInt(match[1], 10);
        break;
      }
    }
  }
  const rationaleMatch = raw.match(/rationale\s*[:=]\s*([\s\S]+)/i);
  if (rationaleMatch?.[1]) {
    parsed.rationale = rationaleMatch[1].trim().slice(0, 900);
  }
  return PROMPT_JUDGE_SCORE_LABELS.some((label) => typeof parsed[label] === "number") ? parsed : undefined;
}
