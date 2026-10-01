import type { PersonalityPreset, PersonalityPresetCategory } from "@goatcitadel/contracts";
import { splitLineList } from "./input-format";

export type PersonalityEditorDraft = {
  id: string;
  label: string;
  category: PersonalityPresetCategory;
  description: string;
  tone: string;
  style: string;
  systemOverlay: string;
  safetyNotes: string;
};

export function createEmptyPersonalityEditorDraft(): PersonalityEditorDraft {
  return {
    id: "",
    label: "",
    category: "core",
    description: "",
    tone: "",
    style: "",
    systemOverlay: "",
    safetyNotes: "Personality overlays never override safety, privacy, approval, tool, memory, or skill policies.",
  };
}

export function createPersonalityEditorDraft(personality: PersonalityPreset | null): PersonalityEditorDraft {
  if (!personality) {
    return createEmptyPersonalityEditorDraft();
  }
  return {
    id: personality.id,
    label: personality.label,
    category: personality.category,
    description: personality.description,
    tone: personality.tone,
    style: personality.style,
    systemOverlay: personality.systemOverlay,
    safetyNotes: personality.safetyNotes.join("\n"),
  };
}

export function personalityDraftToMutationInput(draft: PersonalityEditorDraft) {
  return {
    id: draft.id.trim() || undefined,
    label: draft.label.trim(),
    category: draft.category,
    description: draft.description.trim(),
    tone: draft.tone.trim(),
    style: draft.style.trim(),
    systemOverlay: draft.systemOverlay.trim(),
    safetyNotes: splitLineList(draft.safetyNotes),
  };
}

export function arePersonalityDraftsEqual(a: PersonalityEditorDraft, b: PersonalityEditorDraft): boolean {
  return (
    a.id === b.id &&
    a.label === b.label &&
    a.category === b.category &&
    a.description === b.description &&
    a.tone === b.tone &&
    a.style === b.style &&
    a.systemOverlay === b.systemOverlay &&
    a.safetyNotes === b.safetyNotes
  );
}

export function formatPersonalityStatus(personality: PersonalityPreset, defaultPersonalityId: string): string {
  const tags = [personality.builtin ? "Built-in" : "Custom"];
  if (personality.modified) {
    tags.push("Modified");
  }
  if (personality.id === defaultPersonalityId) {
    tags.push("Work default");
  }
  if (personality.editable === false) {
    tags.push("Locked");
  }
  return tags.join(" · ");
}

export function formatPersonalityCategoryLabel(category: PersonalityPresetCategory): string {
  return category
    .split("_")
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

export function normalizePersonalityEditorId(input: string | undefined): string {
  return (
    input
      ?.trim()
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "default"
  );
}
