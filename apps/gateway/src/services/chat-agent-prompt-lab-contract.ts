import { isPromptLabHarnessContent } from "./prompt-pack-harness-normalization.js";

import { LOCAL_PATH_TOOL_NAMES, WEB_TOOL_NAMES } from "./chat-tool-families.js";

export function extractPrimaryUserTaskContent(content: string): string {
  const trimmed = content.trim();
  if (!trimmed) {
    return "";
  }
  const userTaskMatch = trimmed.match(/(?:^|\n)##\s+User Task\s*\n([\s\S]*?)(?:\n(?:Answer contract:|##\s+)|$)/i);
  if (userTaskMatch?.[1]) {
    return userTaskMatch[1].trim();
  }
  const delegatedTask = extractDelegatedCoworkTaskContent(trimmed);
  if (delegatedTask) {
    return delegatedTask;
  }
  return trimmed;
}

export function extractDelegatedCoworkTaskContent(content: string): string | undefined {
  if (!/^\s*Delegated role:/i.test(content)) {
    return undefined;
  }
  const readLabeledLine = (label: string): string | undefined => {
    const match = content.match(new RegExp(`(?:^|\\n)${label}:\\s*([^\\n]+)`, "i"));
    const value = match?.[1]?.trim();
    return value && value.length >= 3 ? value : undefined;
  };
  const currentObjective = readLabeledLine("Current step objective");
  const parentObjective = readLabeledLine("Parent objective");
  const successCriteria = readLabeledLine("Success criteria");
  const pieces = [currentObjective, parentObjective, successCriteria].filter((value): value is string =>
    Boolean(value),
  );
  return pieces.length > 0 ? pieces.join(" ") : undefined;
}

export function extractPromptLabQuotedUserAsk(content: string): string | undefined {
  const match = content.match(/\b(?:the\s+)?user\s+(?:asks|says):\s*["“]([^"”]+)["”]/i);
  const quoted = match?.[1]?.trim();
  return quoted && quoted.length >= 3 ? quoted : undefined;
}

export function parsePromptLabRunContract(content: string): {
  explicitTools: boolean;
  repoGroundedAssist: boolean;
  requiredToolFamilies: string[];
  requiredNamedTools: string[];
  toolUseSuppressed: boolean;
  userTask: string;
} {
  const userTask = extractPrimaryUserTaskContent(content);
  if (!isPromptLabHarnessContent(content)) {
    return {
      explicitTools: false,
      repoGroundedAssist: false,
      requiredToolFamilies: [],
      requiredNamedTools: [],
      toolUseSuppressed: false,
      userTask,
    };
  }
  const contractBody =
    content.match(/(?:^|\n)##\s+Prompt Lab Run Contract\s*\n([\s\S]*?)(?:\n##\s+User Task\s*\n|$)/i)?.[1] ?? "";
  const explicitTools =
    /\btool tier:\s*explicit-tools\b/i.test(contractBody) || /\bexplicit-tools evaluation\b/i.test(contractBody);
  const repoGroundedAssist = /\brepo inspection assist:\s*enabled\b/i.test(contractBody);
  const requiredToolFamilies = Array.from(
    new Set(
      contractBody
        .split(/\r?\n/)
        .filter((line) => /required tool families:/i.test(line))
        .flatMap((line) => line.split(":").slice(1).join(":").split(","))
        .map((item) => item.trim().toLowerCase())
        .filter(Boolean),
    ),
  );
  const requiredNamedTools = Array.from(
    new Set(
      contractBody
        .split(/\r?\n/)
        .filter((line) => /required named tools:/i.test(line))
        .flatMap((line) => [...line.matchAll(/`([^`]+)`/g)].map((match) => match[1]?.trim().toLowerCase()))
        .filter((item): item is string => Boolean(item)),
    ),
  );
  return {
    explicitTools,
    repoGroundedAssist,
    requiredToolFamilies,
    requiredNamedTools,
    toolUseSuppressed:
      promptLabUserTaskSuppressesToolUse(userTask) || /\bexplicitly forbids tool use\b/i.test(contractBody),
    userTask,
  };
}

export function promptLabUserTaskSuppressesToolUse(userTask: string | undefined): boolean {
  const normalized = (userTask ?? "").toLowerCase();
  return (
    /\banswer\s+without\s+tools\b/.test(normalized) ||
    /\bdo\s+not\s+use\s+(?:any\s+)?tools\b/.test(normalized) ||
    /\bdon't\s+use\s+(?:any\s+)?tools\b/.test(normalized) ||
    /\bplease\s+do\s+not\s+look\s+anything\s+up\b/.test(normalized) ||
    /\bdo\s+not\s+look\s+(?:anything|this|that|it)\s+up\b/.test(normalized) ||
    /\bdon't\s+look\s+(?:anything|this|that|it)\s+up\b/.test(normalized) ||
    /\bfrom\s+memory\s+only\b/.test(normalized) ||
    /\bbased\s+only\s+on\s+the\s+(?:details|prompt|text)\b/.test(normalized)
  );
}

export function promptLabContractRequiresFileTools(input: {
  requiredToolFamilies: string[];
  requiredNamedTools: string[];
}): boolean {
  return (
    input.requiredToolFamilies.includes("file/code tools") ||
    input.requiredNamedTools.some((toolName) => LOCAL_PATH_TOOL_NAMES.has(toolName))
  );
}

export function promptLabContractRequiresWebTools(input: {
  requiredToolFamilies: string[];
  requiredNamedTools: string[];
}): boolean {
  return (
    input.requiredToolFamilies.includes("web lookup tools") ||
    input.requiredNamedTools.some((toolName) => WEB_TOOL_NAMES.has(toolName))
  );
}

export function promptLabContractRequiresConcreteFileEvidence(userTask: string | undefined): boolean {
  const normalized = (userTask ?? "").toLowerCase();
  return (
    /\bexact (?:evidence|file|files|patch points?|assertions?|cit(?:e|ed)|line numbers?)\b/.test(normalized) ||
    /\bexact citations?\b/.test(normalized) ||
    /\bfile-grounded\b/.test(normalized) ||
    /\bcite the exact\b/.test(normalized) ||
    /\bcite\b[\s\S]{0,80}\bexact files?\b/.test(normalized) ||
    /\bcitations?\b[\s\S]{0,60}\bfiles?\s+you\s+used\b/.test(normalized) ||
    /\bcite\b[\s\S]{0,80}\bfiles?\s+used\b/.test(normalized) ||
    /\bconcret(?:e|ely)\s+read\b/.test(normalized) ||
    /\bfiles?\s+whose\s+contents\s+you\s+concretely\s+read\b/.test(normalized)
  );
}

export function extractPromptLabBulletBodies(responseText: string): Map<string, string> {
  const bullets = new Map<string, string>();
  const lines = responseText.split(/\r?\n/);
  let currentLabel: string | null = null;
  let currentBody: string[] = [];
  let currentParagraphClosed = false;

  const flush = () => {
    if (!currentLabel) {
      return;
    }
    const joined = currentBody.join("\n").trim();
    if (joined.length > 0) {
      bullets.set(normalizePromptLabLabel(currentLabel), joined);
    }
  };

  for (const line of lines) {
    const bulletMatch = line.match(/^\s*-\s*(?:\*\*)?(.+?)(?:\*\*)?\s*(?:—|:)\s*(.*)$/);
    if (bulletMatch) {
      flush();
      currentLabel = bulletMatch[1]?.trim() ?? null;
      currentBody = [bulletMatch[2]?.trim() ?? ""];
      currentParagraphClosed = false;
      continue;
    }
    if (!currentLabel) {
      continue;
    }
    if (line.trim().length === 0) {
      currentBody.push("");
      currentParagraphClosed = true;
      continue;
    }
    if (currentParagraphClosed && !/^\s+/.test(line)) {
      continue;
    }
    currentBody.push(line.trim());
  }
  flush();
  return bullets;
}

export function normalizePromptLabLabel(label: string): string {
  return label.trim().replace(/\s+/g, " ").toLowerCase();
}
