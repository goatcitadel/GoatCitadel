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
  },
  {
    id: "archives",
    input:
      "The archive restore passed. Backup retention remains the risk. On Friday Niko will verify the retention window. The tape migration was canceled.",
    facts: ["restore", "retention", "Niko", "Friday"],
    canceled: "tape migration",
  },
  {
    id: "checkout",
    input:
      "Approved checkout screenshots are marked ready, but tax rounding has a known risk. Mina owns the tax test on Wednesday. The gift receipt experiment was canceled.",
    facts: ["screenshots", "rounding", "tax test", "Mina", "Wednesday"],
    canceled: "gift receipt",
  },
  {
    id: "warehouse",
    input:
      "An inventory pilot reached its first depot. Unstable barcode readers could delay adoption. Omar will replace the affected readers on Monday. The gate camera trial is canceled.",
    facts: ["depot", "barcode", "replace", "Omar", "Monday"],
    canceled: "gate camera",
  },
  {
    id: "migration",
    input:
      "Contact migration finished validation. Duplicate addresses may affect delivery. Lena will review the exceptions on Thursday. Calendar import is now canceled.",
    facts: ["validation", "duplicate", "exceptions", "Lena", "Thursday"],
    canceled: "calendar import",
  },
  {
    id: "mobile",
    input:
      "Android sign-in passed its smoke test. Session expiry is the remaining risk. On Saturday Theo will run the expiry test. The icon redesign was canceled.",
    facts: ["sign-in", "expiry", "Theo", "Saturday"],
    canceled: "icon redesign",
  },
];

const hasPhrase = (text, phrase) => text.toLowerCase().includes(phrase.toLowerCase());

export function gradeWeeklyBrief(answer, task) {
  const sections = ["Status", "Risks", "Next steps"].filter((heading) =>
    new RegExp(`^\\s*(?:#{1,6}\\s*)?(?:\\*\\*)?${heading}(?:\\*\\*)?\\s*(?::|$)`, "imu").test(answer),
  );
  const missingFacts = task.facts.filter((fact) => !hasPhrase(answer, fact));
  const followedCorrection = !hasPhrase(answer, task.canceled);
  return {
    sections,
    missingFacts,
    followedCorrection,
    score: sections.length + task.facts.length - missingFacts.length + Number(followedCorrection),
  };
}

export function gradeBriefPair(disabled, enabled) {
  const regression =
    enabled.missingFacts.some((fact) => !disabled.missingFacts.includes(fact)) ||
    (disabled.followedCorrection && !enabled.followedCorrection);
  return { improved: enabled.score > disabled.score && !regression, regression };
}
