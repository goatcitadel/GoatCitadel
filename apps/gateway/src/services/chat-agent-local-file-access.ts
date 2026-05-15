import type { ChatToolRunRecord } from "@goatcitadel/contracts";
import { extractPrimaryUserTaskContent } from "./chat-agent-prompt-lab-contract.js";

export interface ChatHistoryMessageLike {
  role?: string;
  content?: unknown;
}

export function detectLocalFileAccessCheckIntent(content: string): boolean {
  const normalized = content.toLowerCase();
  return (
    normalized.includes("check whether you can access") ||
    normalized.includes("confirm whether you can access") ||
    normalized.includes("verify whether you can access") ||
    /\bwhat\s+do\s+you\s+need\b[\s\S]{0,80}\b(?:local\s+)?(?:file|filesystem|folder|directory)\s+access\b/.test(
      normalized,
    ) ||
    /\bwhat\s+(?:would|will)\s+you\s+need\b[\s\S]{0,80}\b(?:local\s+)?(?:file|filesystem|folder|directory)\s+access\b/.test(
      normalized,
    ) ||
    /\b(?:ask|prompt)\s+me\s+for\s+approval\b[\s\S]{0,80}\b(?:local\s+)?(?:file|filesystem|folder|directory)\b/.test(
      normalized,
    ) ||
    /\b(?:local\s+)?(?:file|filesystem|folder|directory)\s+access\b[\s\S]{0,80}\bapproval\b/.test(normalized) ||
    /\b(can|could|do)\s+you\s+(?:directly\s+)?access\s+(?:my\s+)?local project files\b/.test(normalized) ||
    /\b(can|could|do)\s+you\s+(?:directly\s+)?read\s+(?:my\s+)?local project files\b/.test(normalized) ||
    /\b(can|could)\s+you\s+(?:actually\s+)?open\b.*\blocal project files\b/.test(normalized)
  );
}

export function inferLocalFileAccessCheckPath(input: {
  content: string;
  historyMessages: ChatHistoryMessageLike[];
  promptPathExtractor?: (content: string) => string | undefined;
}): string | undefined {
  const currentPath = extractExplicitLocalAccessPaths(input.content)[0] ?? input.promptPathExtractor?.(input.content);
  if (currentPath) {
    return currentPath;
  }

  const recentUserMessages = [...input.historyMessages]
    .reverse()
    .filter((message) => message.role === "user")
    .map(extractMessageText);
  for (const messageContent of recentUserMessages) {
    const path = extractExplicitLocalAccessPaths(messageContent)[0] ?? input.promptPathExtractor?.(messageContent);
    if (path) {
      return path;
    }
  }

  for (const messageContent of [...input.historyMessages].reverse().map(extractMessageText)) {
    const path = extractExplicitLocalAccessPaths(messageContent)[0] ?? input.promptPathExtractor?.(messageContent);
    if (path) {
      return path;
    }
  }
  return undefined;
}

export function buildLocalFileAccessProbeSuccess(path: string, result: unknown): string {
  const items = Array.isArray((result as { items?: unknown }).items) ? (result as { items: unknown[] }).items : [];
  const itemSummary = items.length > 0 ? ` I can see ${items.length} item${items.length === 1 ? "" : "s"} there.` : "";
  return `I have local file access to \`${path}\` for this session now.${itemSummary} I can use that access to inspect the folder before taking any organizing action.`;
}

export function buildLocalFileAccessProbeFailure(
  path: string,
  toolRun: Pick<ChatToolRunRecord, "error" | "failureGuidance">,
): string {
  const reason = toolRun.error || toolRun.failureGuidance || "The local filesystem probe did not complete.";
  return `I tried to check access to \`${path}\`, but the runtime did not allow it: ${reason}`;
}

export function extractExplicitLocalAccessPaths(content: string): string[] {
  const userTask = extractPrimaryUserTaskContent(content);
  const candidates = new Set<string>();
  const addCandidate = (value: string | undefined): void => {
    const normalized = normalizeLocalAccessPathCandidate(value);
    if (normalized && looksLikeExplicitLocalAccessPath(normalized)) {
      candidates.add(normalized);
    }
  };

  for (const match of userTask.matchAll(/`([^`\r\n]+)`/g)) {
    addCandidate(match[1]);
  }

  for (const line of userTask.split(/\r?\n/)) {
    for (const match of line.matchAll(/[A-Za-z]:[\\/][^`"<>|?*\r\n]+/g)) {
      addCandidate(match[0]);
    }
    for (const match of line.matchAll(/\\\\[^`"<>|?*\r\n]+/g)) {
      addCandidate(match[0]);
    }
  }

  return [...candidates];
}

export function normalizeLocalAccessPathCandidate(value: string | undefined): string | undefined {
  const trimmed = value
    ?.trim()
    .replace(/^["'`(]+|["'`),.;:]+$/g, "")
    .trim();
  if (!trimmed) {
    return undefined;
  }
  const stopMatch = trimmed.match(
    /\s(?:(?:and\s+)?then|and|but|so|because|before|please)\s+(?:read|check|tell|summarize|organize|organizing|move|moving|list)\b/i,
  );
  const stopped = stopMatch?.index && stopMatch.index > 0 ? trimmed.slice(0, stopMatch.index).trim() : trimmed;
  return stopped.replace(/[),.;:]+$/g, "").trim();
}

export function looksLikeExplicitLocalAccessPath(value: string): boolean {
  const normalized = value.trim().replaceAll("\\", "/");
  if (/^[A-Za-z]:\/[^<>:"|?*\r\n]+$/i.test(normalized)) {
    return normalized.split("/").filter(Boolean).length >= 2;
  }
  if (/^\/\/[^<>:"|?*\r\n]+$/i.test(normalized)) {
    return normalized.split("/").filter(Boolean).length >= 2;
  }
  return false;
}

function extractMessageText(message: ChatHistoryMessageLike): string {
  const content = message.content;
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (!part || typeof part !== "object") {
          return "";
        }
        const record = part as Record<string, unknown>;
        return typeof record.text === "string" ? record.text : "";
      })
      .join("");
  }
  return "";
}
