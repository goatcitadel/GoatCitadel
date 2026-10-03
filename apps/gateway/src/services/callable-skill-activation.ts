import type {
  CapabilityCatalogEntry,
  LoadedSkill,
  SkillActivationDecision,
  SkillResolveInput,
} from "@goatcitadel/contracts";
import { rankSkillSelectionCandidates, resolveSkillActivation } from "@goatcitadel/skills";

interface CallableSkillSelectionInput {
  request: SkillResolveInput;
  loadedSkills: LoadedSkill[];
  inspectableCatalog: CapabilityCatalogEntry[];
  callableCatalog: CapabilityCatalogEntry[];
}

/** Explicit evaluation entry point; never replaces the runtime decision or activates a skill. */
export function evaluateCallableSkillSelection(input: CallableSkillSelectionInput, limit = 5) {
  const entries = input.callableCatalog.filter((entry) => entry.kind === "skill" && entry.callable && entry.skillId);
  const callableIds = new Set(entries.map((entry) => entry.skillId));
  const aliases = buildAliasIndex(entries);
  const explicitSkills = extractExplicitTokens(input.request)
    .map((token) => aliases.get(normalizeAlias(token)))
    .filter((name): name is string => Boolean(name));
  return {
    decision: resolveCallableSkillActivation(input),
    shadow: rankSkillSelectionCandidates(
      { ...input.request, explicitSkills },
      input.loadedSkills.filter((skill) => callableIds.has(skill.skillId)),
      limit,
    ),
  };
}

/**
 * Resolve skills exclusively from the capability system's canonical callable
 * catalog. Filesystem discovery remains an inspectable source, never an
 * implicit activation grant.
 */
export function resolveCallableSkillActivation(input: CallableSkillSelectionInput): SkillActivationDecision {
  const loadedBySkillId = new Map(input.loadedSkills.map((skill) => [skill.skillId, skill]));
  const callableEntries = input.callableCatalog.filter(
    (entry): entry is CapabilityCatalogEntry & { skillId: string } =>
      entry.kind === "skill" && entry.callable === true && typeof entry.skillId === "string",
  );
  const callableSkills = callableEntries
    .map((entry) => loadedBySkillId.get(entry.skillId))
    .filter((skill): skill is LoadedSkill => Boolean(skill));

  const callableAliases = buildAliasIndex(callableEntries);
  const explicitTokens = extractExplicitTokens(input.request);
  const normalizedExplicit = explicitTokens
    .map((token) => callableAliases.get(normalizeAlias(token)))
    .filter((name): name is string => Boolean(name));
  const decision = resolveSkillActivation(
    {
      ...input.request,
      explicitSkills: normalizedExplicit,
    },
    callableSkills,
  );

  const noncallableAliases = buildAliasIndex(
    input.inspectableCatalog.filter(
      (entry) => (entry.kind === "skill" || entry.kind === "candidate_skill") && !entry.callable,
    ),
  );
  const blocked = [...decision.blocked];
  for (const token of explicitTokens) {
    if (!noncallableAliases.has(normalizeAlias(token))) continue;
    if (blocked.some((item) => item.skill === token && item.reason === "skill_not_callable")) continue;
    blocked.push({ skill: token, reason: "skill_not_callable" });
  }

  return { ...decision, blocked };
}

function buildAliasIndex(entries: CapabilityCatalogEntry[]): Map<string, string> {
  const aliases = new Map<string, string>();
  for (const entry of entries) {
    const canonicalName = entry.title;
    for (const candidate of [entry.capabilityId, entry.skillId, entry.candidateId, entry.title]) {
      if (typeof candidate === "string" && candidate.trim()) {
        aliases.set(normalizeAlias(candidate), canonicalName);
      }
    }
  }
  return aliases;
}

function extractExplicitTokens(input: SkillResolveInput): string[] {
  const tokens = new Set((input.explicitSkills ?? []).map((value) => value.trim()).filter(Boolean));
  for (const match of input.text.matchAll(/@skill\s+([a-z0-9:_-]+)/giu)) {
    if (match[1]) tokens.add(match[1]);
  }
  for (const match of input.text.matchAll(/\buse\s+([a-z0-9:_-]+)\b/giu)) {
    if (match[1]) tokens.add(match[1]);
  }
  return [...tokens];
}

function normalizeAlias(value: string): string {
  return value.trim().toLowerCase();
}
