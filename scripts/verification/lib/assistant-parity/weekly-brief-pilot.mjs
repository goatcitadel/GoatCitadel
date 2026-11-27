export const briefSkillName = "weekly-project-brief";

export const briefInstructions = `---
name: weekly-project-brief
description: Turn weekly project updates into a brief for the team.
---
# Weekly project brief

## When to use
Use for a weekly-project-brief based on supplied project updates.

## Inputs
Use the supplied project status, risks, next actions, people and dates.

## Instructions
Find the current status, the real risk, and the next action. Preserve the next owner and date exactly. Omit canceled work entirely, even when the source includes it.

## Failure handling
If an owner or date is missing, say Unknown. Use only supplied facts.

## Output
Use exactly these three headings on their own lines: Status, Risks, Next steps. Put the next owner and date under Next steps.

## Verification
Check that the brief contains the correct status, risk, next action, owner and date. Check that no canceled item is mentioned.

## Boundaries
Use the supplied text only. No tools or external actions.`;

export const weeklyBriefCases = [
  {
    id: "search-release",
    input:
      "Search indexing is ready for staging. The weak spot is stale permissions after reindexing. Asha will rerun the access audit on Tuesday. The query dashboard has been canceled.",
    facts: ["staging", "permissions", "access audit", "Asha", "Tuesday"],
    canceled: "query dashboard",
    statusContradiction: /\b(?:not ready|not started|not yet ready|failed staging)\b/iu,
  },
  {
    id: "archives",
    input:
      "The archive restore passed. Backup retention remains the risk. On Friday Niko will verify the retention window. The tape migration was canceled.",
    facts: ["restore", "retention", "Niko", "Friday"],
    canceled: "tape migration",
    statusContradiction: /\b(?:restore (?:failed|did not pass|has not run)|not started)\b/iu,
  },
  {
    id: "checkout",
    input:
      "Approved checkout screenshots are marked ready, but tax rounding has a known risk. Mina owns the tax test on Wednesday. The gift receipt experiment was canceled.",
    facts: ["screenshots", "rounding", "tax test", "Mina", "Wednesday"],
    canceled: "gift receipt",
    statusContradiction: /\b(?:screenshots (?:are not ready|were rejected)|no screenshots)\b/iu,
  },
  {
    id: "warehouse",
    input:
      "An inventory pilot reached its first depot. Unstable barcode readers could delay adoption. Omar will replace the affected readers on Monday. The gate camera trial is canceled.",
    facts: ["depot", "barcode", "replace", "Omar", "Monday"],
    canceled: "gate camera",
    statusContradiction: /\b(?:pilot (?:has not started|has not reached)|no depots?)\b/iu,
  },
  {
    id: "migration",
    input:
      "Contact migration finished validation. Duplicate addresses may affect delivery. Lena will review the exceptions on Thursday. Calendar import is now canceled.",
    facts: ["validation", "duplicate", "exceptions", "Lena", "Thursday"],
    canceled: "calendar import",
    statusContradiction: /\b(?:not (?:yet )?(?:started|complete[dp]?)|validation (?:failed|is pending|has not finished)|still (?:in|under) validation)\b/iu,
  },
  {
    id: "mobile",
    input:
      "Android sign-in passed its smoke test. Session expiry is the remaining risk. On Saturday Theo will run the expiry test. The icon redesign was canceled.",
    facts: ["sign-in", "expiry", "Theo", "Saturday"],
    canceled: "icon redesign",
    statusContradiction: /\b(?:sign-in failed|smoke test (?:failed|did not pass|is pending))\b/iu,
  },
];

const normalize = (text) =>
  text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
const hasPhrase = (text, phrase) => ` ${normalize(text)} `.includes(` ${normalize(phrase)} `);
const headings = ["Status", "Risks", "Next steps"];
const days = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const calendarDateRE = /\b(?:\d{4}-\d{1,2}-\d{1,2}|\d{1,2}\/\d{1,2}(?:\/\d{2,4})?|(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\.?\s+\d{1,2}(?:st|nd|rd|th)?(?:,?\s+\d{4})?)\b/giu;
const deniedKnownRiskRE = /\b(?:no (?:known |significant |remaining )?risks?\b(?!\s+(?:other than|except)\b)|risks?\s*:\s*(?:none\b|n\/a\b))/iu;

export function gradeWeeklyBrief(answer, task) {
  const matches = [
    ...answer.matchAll(/^[ \t]*(?:#{1,6}[ \t]*)?(?:\*\*)?(Status|Risks|Next steps)(?:\*\*)?[ \t]*(?::|$)/gimu),
  ];
  const sections = headings.filter((heading) => matches.some((match) => normalize(match[1]) === normalize(heading)));
  const nextIndex = matches.findIndex((match) => normalize(match[1]) === "next steps");
  const next = matches[nextIndex];
  const nextSteps = next ? answer.slice(next.index + next[0].length, matches[nextIndex + 1]?.index) : "";
  const [owner, due] = task.facts.slice(-2);
  const ownerAndDateInNextSteps = hasPhrase(nextSteps, owner) && hasPhrase(nextSteps, due);
  const unsupportedDates = [
    ...days.filter((day) => day !== due && hasPhrase(answer, day)),
    ...new Set(Array.from(answer.matchAll(calendarDateRE), ([date]) => normalize(date))),
  ];
  const missingFacts = task.facts.filter((fact) => !hasPhrase(answer, fact));
  const followedCorrection = !hasPhrase(answer, task.canceled);
  const contradictedStatus = task.statusContradiction.test(answer);
  const deniedKnownRisk = deniedKnownRiskRE.test(answer);
  return {
    sections,
    missingFacts,
    followedCorrection,
    ownerAndDateInNextSteps,
    unsupportedDates,
    contradictedStatus,
    deniedKnownRisk,
    score:
      sections.length +
      task.facts.length -
      missingFacts.length +
      Number(followedCorrection) +
      Number(ownerAndDateInNextSteps),
  };
}

export function gradeBriefPair(disabled, enabled) {
  const regression =
    enabled.missingFacts.some((fact) => !disabled.missingFacts.includes(fact)) ||
    (disabled.followedCorrection && !enabled.followedCorrection) ||
    enabled.unsupportedDates.some((date) => !disabled.unsupportedDates.includes(date)) ||
    (enabled.contradictedStatus && !disabled.contradictedStatus) ||
    (enabled.deniedKnownRisk && !disabled.deniedKnownRisk);
  return {
    improved: enabled.score > disabled.score && !regression && !enabled.contradictedStatus &&
      !enabled.deniedKnownRisk && !enabled.unsupportedDates.length,
    regression,
  };
}
