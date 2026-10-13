import { createHash } from "node:crypto";
import type { ChatTurnCapabilityProfileRecord } from "@goatcitadel/contracts";
import type { ArtifactBrandInput } from "@goatcitadel/policy-engine";
import { parseDesignBrandBlock } from "@goatcitadel/skills";
import type { SkillContextDocReader } from "./governed-skill-instruction-service.js";

/**
 * The workspace brand for deck and document tools: the DESIGN.md brand block, read only when the
 * turn's frozen profile injected the workspace design context (so a turn that never saw DESIGN.md
 * is not silently branded by it). The governed render already failed closed on any DESIGN.md
 * drift before the provider ran, but DESIGN.md can still change before an artifact tool runs, so
 * the live content must match the frozen receipt's hash and size; otherwise no brand is applied.
 * This read is cosmetic and never widens authority.
 */
export function resolveWorkspaceDesignBrand(
  profile: ChatTurnCapabilityProfileRecord | undefined,
  read: SkillContextDocReader | undefined,
): ArtifactBrandInput | undefined {
  if (!profile || !read) return undefined;
  const frozenDesign = (profile.selection.activatedSkills ?? [])
    .flatMap((skill) => skill.contextDocuments ?? [])
    .find((doc) => doc.docType === "design");
  if (!frozenDesign) return undefined;
  const doc = read("design");
  if (!doc.exists) return undefined;
  // Hash exactly as the governed render does when it freezes the context-document receipt.
  const sha256 = createHash("sha256").update(doc.content, "utf8").digest("hex");
  if (sha256 !== frozenDesign.sha256 || Buffer.byteLength(doc.content, "utf8") !== frozenDesign.bytes) {
    return undefined;
  }
  const brand = parseDesignBrandBlock(doc.content);
  return brand ? { ...brand } : undefined;
}
