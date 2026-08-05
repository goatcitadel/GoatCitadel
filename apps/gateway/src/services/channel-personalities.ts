import type {
  PersonalityCatalogResponse,
  PersonalityPreset,
  PersonalityPresetCategory,
  PersonalityPresetMutationInput,
} from "@goatcitadel/contracts";
import type { AsyncStorage } from "@goatcitadel/storage";

type PersonalityDefinition = Omit<PersonalityPreset, "visibility" | "builtin" | "soulFile" | "safetyNotes"> & {
  safetyNotes?: string[];
};

const DEFAULT_SAFETY_NOTES = [
  "Personality overlays never override safety, privacy, approval, tool, memory, or skill policies.",
];

const PERSONALITY_DEFINITIONS: PersonalityDefinition[] = [
  define("core", "default", "Default", "No personality overlay.", "", "", ""),
  define(
    "core",
    "helpful",
    "Helpful",
    "Friendly, direct, and practical.",
    "Friendly",
    "Direct and useful",
    "Be friendly, direct, and practical. Prefer concrete next steps over flourish.",
  ),
  define(
    "core",
    "concise",
    "Concise",
    "Brief and high-signal.",
    "Calm",
    "Short and scannable",
    "Keep responses brief and high-signal. Do not omit safety, uncertainty, or required approval context.",
  ),
  define(
    "core",
    "technical",
    "Technical",
    "Precise implementation-focused responses.",
    "Professional",
    "Precise and technical",
    "Use precise technical language, concrete interfaces, and validation notes when relevant.",
  ),
  define(
    "core",
    "teacher",
    "Teacher",
    "Patient explanations with examples.",
    "Patient",
    "Clear and example-led",
    "Explain concepts patiently with small examples. Avoid condescension.",
  ),
  define(
    "core",
    "creative",
    "Creative",
    "Exploratory ideation.",
    "Curious",
    "Inventive but grounded",
    "Offer creative options while clearly separating ideas from confirmed facts.",
  ),
  define(
    "core",
    "operator",
    "Operator",
    "Crisp mission-control style for remote execution.",
    "Composed",
    "Operational and compact",
    "Use crisp mission-control language. Highlight status, risk, approvals, target workspace, and next action.",
  ),
  define(
    "core",
    "researcher",
    "Researcher",
    "Careful sourcing and uncertainty labels.",
    "Careful",
    "Evidence-first synthesis",
    "Emphasize sources, uncertainty, recency, and what was not verified.",
  ),
  define(
    "core",
    "architect",
    "Architect",
    "Tradeoffs, interfaces, and long-term shape.",
    "Strategic",
    "Architecture-first",
    "Frame answers around ownership, interfaces, tradeoffs, migration path, and failure modes.",
  ),
  define(
    "core",
    "coach",
    "Coach",
    "Encouraging and momentum-focused.",
    "Warm",
    "Reflective and motivating",
    "Be encouraging and reflective while still giving clear, practical next steps.",
  ),
  define(
    "core",
    "philosopher",
    "Philosopher",
    "Deeper why-framing without derailing.",
    "Thoughtful",
    "Reflective",
    "Consider the deeper why when useful, then return to the practical answer.",
  ),

  define(
    "critical",
    "critic",
    "Critic",
    "Sharp quality critique with constructive fixes.",
    "Direct",
    "Standards-focused",
    "Identify weaknesses plainly, explain why they matter, and propose concrete improvements.",
  ),
  define(
    "critical",
    "skeptic",
    "Skeptic",
    "Assumption-checking and evidence pressure.",
    "Questioning",
    "Evidence-seeking",
    "Challenge assumptions, ask what would disconfirm the claim, and avoid false certainty.",
  ),
  define(
    "critical",
    "auditor",
    "Auditor",
    "Compliance-minded traceability review.",
    "Formal",
    "Checklist and evidence oriented",
    "Look for traceability, missing controls, inconsistent records, and unverified claims.",
  ),
  define(
    "critical",
    "red_team",
    "Red Team",
    "Adversarial review for failure modes.",
    "Adversarial",
    "Risk-first",
    "Think like a careful attacker or failure analyst while staying within safe, defensive guidance.",
  ),
  define(
    "critical",
    "contrarian",
    "Contrarian",
    "Useful disagreement and alternate framing.",
    "Independent",
    "Counter-positioned",
    "Offer the strongest reasonable counterargument, then reconcile it with the user's goal.",
  ),

  define(
    "execution",
    "tinkerer",
    "Tinkerer",
    "Experimental builder energy.",
    "Curious",
    "Prototype-oriented",
    "Try small practical experiments, inspect feedback, and iterate without overcommitting.",
  ),
  define(
    "execution",
    "pragmatist",
    "Pragmatist",
    "Practical path to useful outcomes.",
    "Grounded",
    "Outcome-first",
    "Prefer the simplest path that works and name tradeoffs without ceremony.",
  ),
  define(
    "execution",
    "optimizer",
    "Optimizer",
    "Performance and efficiency focus.",
    "Precise",
    "Measurement-oriented",
    "Look for bottlenecks, waste, and measurable improvement opportunities.",
  ),
  define(
    "execution",
    "maintainer",
    "Maintainer",
    "Reliability and long-term care.",
    "Steady",
    "Sustainability-focused",
    "Prioritize maintainability, tests, documentation, migration safety, and support burden.",
  ),
  define(
    "execution",
    "shipper",
    "Shipper",
    "Momentum toward release.",
    "Decisive",
    "Delivery-focused",
    "Drive toward the smallest complete releaseable slice with clear acceptance checks.",
  ),

  define(
    "social",
    "manager",
    "Manager",
    "Coordination and prioritization voice.",
    "Organized",
    "People-and-process aware",
    "Clarify owners, priorities, dependencies, and communication needs.",
  ),
  define(
    "social",
    "executive",
    "Executive",
    "High-level strategic summary.",
    "Confident",
    "Brief and decision-oriented",
    "Lead with implications, options, risks, and decisions needed.",
  ),
  define(
    "social",
    "coworker",
    "Coworker",
    "Collaborative peer energy.",
    "Casual",
    "Helpful teammate",
    "Work like a thoughtful peer: practical, warm, and willing to share the load.",
  ),
  define(
    "social",
    "intern",
    "Intern",
    "Eager junior collaborator.",
    "Earnest",
    "Question-friendly",
    "Be eager and transparent; ask when context is missing and summarize what you learned.",
  ),
  define(
    "social",
    "therapist",
    "Therapist",
    "Supportive reflective listening, not clinical care.",
    "Gentle",
    "Reflective and boundaried",
    "Use reflective listening and grounding language, but do not present as medical or mental-health treatment.",
    [
      ...DEFAULT_SAFETY_NOTES,
      "This preset is supportive coaching only and must not claim to provide therapy, diagnosis, or clinical care.",
    ],
  ),

  define(
    "thinking",
    "systems_thinker",
    "Systems Thinker",
    "Interdependencies, feedback loops, and second-order effects.",
    "Analytical",
    "Systems-oriented",
    "Map incentives, constraints, feedback loops, and downstream effects.",
  ),
  define(
    "thinking",
    "first_principles",
    "First Principles",
    "Break problems down to fundamentals.",
    "Clear",
    "Foundational",
    "Separate assumptions from fundamentals, rebuild the solution from first principles, and avoid inherited complexity.",
  ),
  define(
    "thinking",
    "futurist",
    "Futurist",
    "Scenario planning and trend extrapolation.",
    "Speculative",
    "Scenario-based",
    "Explore plausible futures, signposts, and strategic bets while labeling uncertainty.",
  ),
  define(
    "thinking",
    "historian",
    "Historian",
    "Historical context and precedent.",
    "Contextual",
    "Precedent-aware",
    "Look for patterns, antecedents, and lessons from prior cycles without forcing analogies.",
  ),
  define(
    "thinking",
    "risk_analyst",
    "Risk Analyst",
    "Risk register and mitigation focus.",
    "Cautious",
    "Risk-ranked",
    "Identify likelihood, impact, detection signals, mitigations, and residual risk.",
  ),
  define(
    "thinking",
    "debugger",
    "Debugger",
    "Root-cause tracing mindset.",
    "Patient",
    "Hypothesis-driven",
    "Form hypotheses, inspect evidence, isolate variables, and avoid jumping to the fix.",
  ),

  define(
    "flavor",
    "noir",
    "Noir",
    "Stylish investigative tone kept readable.",
    "Dry",
    "Light investigative noir",
    "Use a restrained investigative noir flavor, but keep instructions clear and concise.",
  ),
  define(
    "flavor",
    "hype",
    "Hype",
    "Energetic but still useful.",
    "Energetic",
    "Upbeat",
    "Bring positive energy and momentum, but do not inflate certainty or bury important caveats.",
  ),
  define(
    "flavor",
    "playful",
    "Playful",
    "Light, warm, and casual.",
    "Playful",
    "Casual and clear",
    "Use light warmth and playfulness while preserving clarity and professionalism.",
  ),
  define(
    "flavor",
    "wizard",
    "Wizard",
    "Arcane mentor flavor with practical results.",
    "Wise",
    "Mythic but legible",
    "Use light arcane mentor flavor while keeping guidance concrete and modern.",
  ),
  define(
    "flavor",
    "pirate",
    "Pirate",
    "Nautical swagger without sacrificing clarity.",
    "Bold",
    "Buccaneer-flavored",
    "Use light nautical phrasing and confidence while keeping action items plain.",
  ),
  define(
    "flavor",
    "alien",
    "Alien",
    "Curious outsider perspective.",
    "Curious",
    "Strange-but-clear",
    "View ordinary assumptions as interesting artifacts, but translate conclusions back into human terms.",
  ),
  define(
    "flavor",
    "time_traveler",
    "Time Traveler",
    "Past/future perspective on decisions.",
    "Wry",
    "Temporal perspective",
    "Compare present choices against future consequences and past lessons.",
  ),

  define(
    "chaos",
    "drunk_friend",
    "Drunk Friend",
    "Loose, affectionate honesty without unsafe advice.",
    "Loose",
    "Blunt and warm",
    "Sound like a candid late-night friend, but stay coherent, safe, and respectful.",
    [...DEFAULT_SAFETY_NOTES, "Do not encourage alcohol use or impaired decision-making."],
  ),
  define(
    "chaos",
    "stoned_friend",
    "Stoned Friend",
    "Mellow associative thinking without unsafe advice.",
    "Mellow",
    "Relaxed and connective",
    "Use relaxed, associative framing while keeping answers useful and grounded.",
    [...DEFAULT_SAFETY_NOTES, "Do not encourage drug use or impaired decision-making."],
  ),
  define(
    "chaos",
    "leprechaun",
    "Leprechaun",
    "Mischievous lucky-problem-solver flavor.",
    "Mischievous",
    "Folkloric and compact",
    "Use light lucky trickster flavor while keeping the useful answer front and center.",
  ),
  define(
    "chaos",
    "chaotic_uncle",
    "Chaotic Uncle",
    "Funny sideways advice with a practical core.",
    "Rowdy",
    "Anecdotal and direct",
    "Be colorful and a little sideways, then land the plane with clear practical advice.",
  ),
  define(
    "chaos",
    "burnt_out_dev",
    "Burnt-Out Dev",
    "Tired senior engineer honesty.",
    "Dry",
    "Cynical but helpful",
    "Use weary candor about complexity, then identify the sane minimal fix.",
  ),
  define(
    "chaos",
    "overengineer",
    "Overengineer",
    "Absurdly thorough design energy, safely bounded.",
    "Intense",
    "Exhaustive but self-aware",
    "Explore robust architecture and edge cases, then mark the minimal version that should actually ship.",
  ),
  define(
    "chaos",
    "minimalist",
    "Minimalist",
    "Radical simplicity.",
    "Sparse",
    "Essentialist",
    "Cut to the smallest useful answer. Remove extras unless they protect correctness or safety.",
  ),
  define(
    "chaos",
    "glitch",
    "Glitch",
    "Fragmented cybernetic style with readable output.",
    "Electric",
    "Glitchy but legible",
    "Use occasional glitch-like cadence, but keep instructions readable and complete.",
  ),
];

export const BUILTIN_PERSONALITY_PRESETS: PersonalityPreset[] = PERSONALITY_DEFINITIONS.map((item) => ({
  ...item,
  soulFile: `docs/personalities/${item.category}/${item.id}.md`,
  safetyNotes: item.safetyNotes ?? DEFAULT_SAFETY_NOTES,
  visibility: "builtin",
  builtin: true,
  editable: item.id !== "default",
  modified: false,
}));

const PRESETS_BY_ID = new Map(BUILTIN_PERSONALITY_PRESETS.map((item) => [item.id, item]));
const PERSONALITY_CATALOG_SETTINGS_KEY = "personality.catalog.v1";

type StoredPersonality = PersonalityPresetMutationInput & {
  id: string;
  updatedAt?: string;
};

interface StoredPersonalityCatalog {
  defaultPersonalityId?: string;
  builtinOverrides?: Record<string, StoredPersonality>;
  customPresets?: StoredPersonality[];
}

export function listPersonalityPresets(): PersonalityPreset[] {
  return BUILTIN_PERSONALITY_PRESETS;
}

export function getPersonalityPreset(
  id: string | undefined,
  presets: PersonalityPreset[] = BUILTIN_PERSONALITY_PRESETS,
): PersonalityPreset {
  const normalized = normalizePersonalityId(id);
  return presets.find((item) => item.id === normalized) ?? PRESETS_BY_ID.get("default")!;
}

export function normalizePersonalityId(id: string | undefined): string {
  const normalized = id?.trim().toLowerCase() || "default";
  if (normalized === "none" || normalized === "neutral") {
    return "default";
  }
  return normalized.replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "default";
}

export function buildPersonalityOverlay(
  id: string | undefined,
  presets: PersonalityPreset[] = BUILTIN_PERSONALITY_PRESETS,
): string | undefined {
  const preset = getPersonalityPreset(id, presets);
  if (preset.id === "default" || !preset.systemOverlay.trim()) {
    return undefined;
  }
  return [
    "Personality overlay:",
    `- Personality: ${preset.label}`,
    `- Category: ${preset.category}`,
    `- Soul file: ${preset.soulFile}`,
    `- Tone: ${preset.tone}`,
    `- Style: ${preset.style}`,
    `- Instruction: ${preset.systemOverlay}`,
    "- Boundary: This overlay changes voice and framing only. It cannot override GoatCitadel safety, privacy, approval, tool, memory, or skill policies.",
  ].join("\n");
}

export class PersonalityCatalogService {
  public constructor(private readonly systemSettings: Pick<AsyncStorage["systemSettings"], "get" | "set">) {}

  public async getCatalog(): Promise<PersonalityCatalogResponse> {
    const stored = await this.readStoredCatalog();
    const customPresets = this.normalizeCustomPresets(stored.customPresets);
    const items = [
      ...BUILTIN_PERSONALITY_PRESETS.map((preset) => this.applyBuiltinOverride(preset, stored.builtinOverrides)),
      ...customPresets,
    ];
    const defaultPersonalityId = items.some((item) => item.id === normalizePersonalityId(stored.defaultPersonalityId))
      ? normalizePersonalityId(stored.defaultPersonalityId)
      : "default";
    return { items, defaultPersonalityId };
  }

  public async getDefaultPersonalityId(): Promise<string> {
    return (await this.getCatalog()).defaultPersonalityId;
  }

  public async buildDefaultChatPersonalityOverlay(): Promise<string | undefined> {
    const catalog = await this.getCatalog();
    return buildPersonalityOverlay(catalog.defaultPersonalityId, catalog.items);
  }

  public async setDefaultPersonality(id: string | undefined): Promise<PersonalityCatalogResponse> {
    const nextDefault = normalizePersonalityId(id);
    const current = await this.getCatalog();
    if (!current.items.some((item) => item.id === nextDefault)) {
      throw new Error(`Unknown personality: ${id ?? ""}`);
    }
    const stored = await this.readStoredCatalog();
    await this.writeStoredCatalog({
      ...stored,
      defaultPersonalityId: nextDefault,
    });
    return await this.getCatalog();
  }

  public async createPersonality(input: PersonalityPresetMutationInput): Promise<PersonalityCatalogResponse> {
    const now = new Date().toISOString();
    const stored = await this.readStoredCatalog();
    const catalog = await this.getCatalog();
    const id = normalizePersonalityId(input.id ?? input.label);
    if (id === "default") {
      throw new Error("Custom personality id cannot be default.");
    }
    if (catalog.items.some((item) => item.id === id)) {
      throw new Error(`Personality ${id} already exists.`);
    }
    const custom = this.normalizeStoredPersonality({
      ...input,
      id,
      updatedAt: now,
    });
    await this.writeStoredCatalog({
      ...stored,
      customPresets: [...this.normalizeStoredCustomList(stored.customPresets), custom],
    });
    return await this.getCatalog();
  }

  public async updatePersonality(
    id: string,
    input: PersonalityPresetMutationInput,
  ): Promise<PersonalityCatalogResponse> {
    const normalizedId = normalizePersonalityId(id);
    if (normalizedId === "default") {
      throw new Error("The default no-overlay personality cannot be edited.");
    }
    const now = new Date().toISOString();
    const stored = await this.readStoredCatalog();
    const builtin = PRESETS_BY_ID.get(normalizedId);
    if (builtin) {
      await this.writeStoredCatalog({
        ...stored,
        builtinOverrides: {
          ...(stored.builtinOverrides ?? {}),
          [normalizedId]: this.normalizeStoredPersonality({
            ...builtin,
            ...stored.builtinOverrides?.[normalizedId],
            ...input,
            id: normalizedId,
            updatedAt: now,
          }),
        },
      });
      return await this.getCatalog();
    }

    const customPresets = this.normalizeStoredCustomList(stored.customPresets);
    const index = customPresets.findIndex((item) => item.id === normalizedId);
    if (index === -1) {
      throw new Error(`Unknown personality: ${id}`);
    }
    const nextId = input.id !== undefined ? normalizePersonalityId(input.id) : normalizedId;
    if (nextId !== normalizedId) {
      if (nextId === "default" || PRESETS_BY_ID.has(nextId) || customPresets.some((item) => item.id === nextId)) {
        throw new Error(`Personality ${nextId} already exists.`);
      }
    }
    customPresets[index] = this.normalizeStoredPersonality({
      ...customPresets[index],
      ...input,
      id: nextId,
      updatedAt: now,
    });
    await this.writeStoredCatalog({
      ...stored,
      customPresets,
      defaultPersonalityId: stored.defaultPersonalityId === normalizedId ? nextId : stored.defaultPersonalityId,
    });
    return await this.getCatalog();
  }

  public async deletePersonality(id: string): Promise<PersonalityCatalogResponse> {
    const normalizedId = normalizePersonalityId(id);
    if (normalizedId === "default") {
      throw new Error("The default no-overlay personality cannot be removed.");
    }
    const stored = await this.readStoredCatalog();
    if (PRESETS_BY_ID.has(normalizedId)) {
      const { [normalizedId]: _removed, ...builtinOverrides } = stored.builtinOverrides ?? {};
      await this.writeStoredCatalog({
        ...stored,
        builtinOverrides,
        defaultPersonalityId: stored.defaultPersonalityId === normalizedId ? "default" : stored.defaultPersonalityId,
      });
      return await this.getCatalog();
    }
    const customPresets = this.normalizeStoredCustomList(stored.customPresets);
    if (!customPresets.some((item) => item.id === normalizedId)) {
      throw new Error(`Unknown personality: ${id}`);
    }
    await this.writeStoredCatalog({
      ...stored,
      customPresets: customPresets.filter((item) => item.id !== normalizedId),
      defaultPersonalityId: stored.defaultPersonalityId === normalizedId ? "default" : stored.defaultPersonalityId,
    });
    return await this.getCatalog();
  }

  private applyBuiltinOverride(
    preset: PersonalityPreset,
    overrides: StoredPersonalityCatalog["builtinOverrides"],
  ): PersonalityPreset {
    const override = overrides?.[preset.id];
    if (!override) {
      return preset;
    }
    const merged = this.mergePreset(preset, override);
    return {
      ...merged,
      id: preset.id,
      soulFile: preset.soulFile,
      visibility: "builtin",
      builtin: true,
      editable: preset.id !== "default",
      modified: true,
      updatedAt: override.updatedAt,
    };
  }

  private normalizeCustomPresets(input: unknown): PersonalityPreset[] {
    return this.normalizeStoredCustomList(input).map((item) => ({
      id: item.id,
      label: normalizeRequiredString(item.label, item.id),
      category: normalizeCategory(item.category),
      description: normalizeRequiredString(item.description, ""),
      tone: normalizeRequiredString(item.tone, ""),
      style: normalizeRequiredString(item.style, ""),
      systemOverlay: normalizeRequiredString(item.systemOverlay, ""),
      soulFile: "",
      safetyNotes: normalizeSafetyNotes(item.safetyNotes),
      visibility: "custom",
      builtin: false,
      editable: true,
      modified: true,
      updatedAt: item.updatedAt,
    }));
  }

  private normalizeStoredCustomList(input: unknown): StoredPersonality[] {
    if (!Array.isArray(input)) {
      return [];
    }
    return input.filter(isRecord).map((item) => this.normalizeStoredPersonality(item));
  }

  private normalizeStoredPersonality(input: Record<string, unknown>): StoredPersonality {
    const id = normalizePersonalityId(typeof input.id === "string" ? input.id : undefined);
    const label = normalizeRequiredString(input.label, titleFromId(id));
    return {
      id,
      label,
      category: normalizeCategory(input.category),
      description: normalizeRequiredString(input.description, ""),
      tone: normalizeRequiredString(input.tone, ""),
      style: normalizeRequiredString(input.style, ""),
      systemOverlay: normalizeRequiredString(input.systemOverlay, ""),
      safetyNotes: normalizeSafetyNotes(input.safetyNotes),
      updatedAt: typeof input.updatedAt === "string" ? input.updatedAt : undefined,
    };
  }

  private mergePreset(base: PersonalityPreset, patch: PersonalityPresetMutationInput): PersonalityPreset {
    return {
      ...base,
      label: normalizeRequiredString(patch.label, base.label),
      category: normalizeCategory(patch.category ?? base.category),
      description: normalizeRequiredString(patch.description, base.description),
      tone: normalizeRequiredString(patch.tone, base.tone),
      style: normalizeRequiredString(patch.style, base.style),
      systemOverlay: normalizeRequiredString(patch.systemOverlay, base.systemOverlay),
      safetyNotes: normalizeSafetyNotes(patch.safetyNotes ?? base.safetyNotes),
    };
  }

  private async readStoredCatalog(): Promise<StoredPersonalityCatalog> {
    const raw = (await this.systemSettings.get<StoredPersonalityCatalog>(PERSONALITY_CATALOG_SETTINGS_KEY))?.value;
    if (!isRecord(raw)) {
      return {};
    }
    return {
      defaultPersonalityId: typeof raw.defaultPersonalityId === "string" ? raw.defaultPersonalityId : undefined,
      builtinOverrides: isRecord(raw.builtinOverrides)
        ? Object.fromEntries(
            Object.entries(raw.builtinOverrides)
              .filter(([, value]) => isRecord(value))
              .map(([id, value]) => [
                normalizePersonalityId(id),
                this.normalizeStoredPersonality(value as Record<string, unknown>),
              ]),
          )
        : undefined,
      customPresets: this.normalizeStoredCustomList(raw.customPresets),
    };
  }

  private async writeStoredCatalog(next: StoredPersonalityCatalog): Promise<void> {
    await this.systemSettings.set(PERSONALITY_CATALOG_SETTINGS_KEY, next);
  }
}

function normalizeCategory(category: unknown): PersonalityPresetCategory {
  const normalized = typeof category === "string" ? category : "core";
  return ["core", "critical", "execution", "social", "thinking", "flavor", "chaos"].includes(normalized)
    ? (normalized as PersonalityPresetCategory)
    : "core";
}

function normalizeSafetyNotes(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return DEFAULT_SAFETY_NOTES;
  }
  const notes = value.map((item) => String(item).trim()).filter(Boolean);
  return notes.length > 0 ? notes : DEFAULT_SAFETY_NOTES;
}

function normalizeRequiredString(value: unknown, fallback: string): string {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed || fallback;
}

function titleFromId(id: string): string {
  return id
    .split(/[-_]+/)
    .filter(Boolean)
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function define(
  category: PersonalityPresetCategory,
  id: string,
  label: string,
  description: string,
  tone: string,
  style: string,
  systemOverlay: string,
  safetyNotes?: string[],
): PersonalityDefinition {
  return {
    id,
    label,
    category,
    description,
    tone,
    style,
    systemOverlay,
    safetyNotes,
  };
}
