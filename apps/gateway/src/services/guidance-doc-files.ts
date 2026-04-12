import type { GuidanceDocType } from "@goatcitadel/contracts";

export const GUIDANCE_DOC_FILE_MAP: Record<GuidanceDocType, string> = {
  goatcitadel: "GOATCITADEL.md",
  agents: "AGENTS.md",
  claude: "CLAUDE.md",
  contributing: "CONTRIBUTING.md",
  security: "SECURITY.md",
  vision: "VISION.md",
};
