import { redactSecretText } from "@goatcitadel/contracts";

/** Discovery text only. Never project structured tool, attachment or private reasoning payloads. */
export function chatListPreview(content: string | undefined): string | undefined {
  if (!content) return undefined;
  if (content.includes("<workflow_evidence>")) return "Captured workflow for review";
  const visible = redactSecretText(content).value
    .replace(/<(think|thinking|analysis|tool_call|tool_result|script|style)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)/gi, "")
    .replace(/<!--([\s\S]*?)(?:-->|$)/g, "")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/<[^>]*>/g, "")
    .replace(/[`*_#]/g, "")
    .replace(/\s+/g, " ").trim();
  return Array.from(redactSecretText(visible).value).slice(0, 160).join("") || undefined;
}
