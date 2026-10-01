import type { SkillListItem } from "@goatcitadel/contracts";
import type { StatusPresentation } from "./status-vocabulary.js";

const skillStates: Readonly<Record<SkillListItem["state"], StatusPresentation>> = {
  enabled: { label: "On", tone: "done" },
  sleep: { label: "Sleeping", tone: "neutral" },
  disabled: { label: "Off", tone: "neutral" },
};

function firstSentence(text: string | undefined): string | undefined {
  const normalized = text?.replace(/\s+/g, " ").trim();
  if (!normalized) return undefined;
  const sentence = normalized.match(/^.+?[.!?](?=\s|$)/)?.[0] ?? normalized;
  return sentence.slice(0, 160);
}

export function presentSkillRow(skill: SkillListItem): {
  description: string;
  status: StatusPresentation;
  trust?: string;
} {
  const hint = skill.routingHints?.whenToUse.find((item) => item.trim())?.trim();
  return {
    description: hint || firstSentence(skill.instructionBody) || "No description yet.",
    status: skillStates[skill.state],
    ...(skill.trustLabel ? { trust: skill.trustLabel } : {}),
  };
}
