import type { ChatWebMode } from "@goatcitadel/contracts";

/**
 * Decides whether a Chat turn counts as a web lookup. Regex-detected web intent always counts;
 * Deep mode also counts on its own unless the turn targets a local file or is a workflow-skill
 * capture. Web Off never counts, whatever was detected.
 */
export function resolveTurnWebLookupIntent(input: {
  webMode: ChatWebMode;
  detectedWebLookupIntent: boolean;
  localFileIntent: boolean;
  workflowSkillCapture: boolean;
}): boolean {
  if (input.webMode === "off") return false;
  return (
    input.detectedWebLookupIntent || (input.webMode === "deep" && !input.localFileIntent && !input.workflowSkillCapture)
  );
}
