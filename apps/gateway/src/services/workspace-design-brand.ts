import type { ChatTurnCapabilityProfileRecord } from "@goatcitadel/contracts";
import type { ArtifactBrandInput } from "@goatcitadel/policy-engine";
import { parseDesignBrandBlock } from "@goatcitadel/skills";
import type { SkillContextDocReader } from "./governed-skill-instruction-service.js";

/**
 * The workspace brand for deck and document tools: the DESIGN.md brand block, read only when the
 * turn's frozen profile injected the workspace design context (so a turn that never saw DESIGN.md
 * is not silently branded by it). The governed render already failed closed on any DESIGN.md
 * drift before the provider ran; this read is cosmetic and never widens authority.
 */
export function resolveWorkspaceDesignBrand(
  profile: ChatTurnCapabilityProfileRecord | undefined,
  read: SkillContextDocReader | undefined,
): ArtifactBrandInput | undefined {
  if (!profile || !read) return undefined;
  const injectedDesignContext = (profile.selection.activatedSkills ?? []).some((skill) =>
    (skill.contextDocuments ?? []).some((doc) => doc.docType === "design"),
  );
  if (!injectedDesignContext) return undefined;
  const doc = read("design");
  if (!doc.exists) return undefined;
  const brand = parseDesignBrandBlock(doc.content);
  return brand ? { ...brand } : undefined;
}
