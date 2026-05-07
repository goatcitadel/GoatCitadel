import { extractPrimaryUserTaskContent } from "./chat-agent-prompt-lab-contract.js";

export function detectCoworkRoleOrder(prompt: string): string[] {
  const explicitSections = extractExactCoworkSections(prompt)
    .map(normalizeCoworkRoleLabel)
    .filter((section) => isRecognizedCoworkRole(section) && section !== "synthesis");
  if (explicitSections.length > 0) {
    return explicitSections;
  }
  const requiredRoleOrderMatch = prompt.match(/required role order\b[:\s]*([^\n]+)/i)?.[1];
  if (requiredRoleOrderMatch) {
    return parseCoworkRoleList(requiredRoleOrderMatch);
  }
  const userTask = extractPrimaryUserTaskContent(prompt);
  const roleSource = userTask || prompt;
  const rolesInOrderMatch = roleSource.match(/roles?\s+in\s+(?:this\s+)?(?:exact\s+)?order\b[:\s]*([^\n]+)/i)?.[1];
  if (rolesInOrderMatch) {
    return parseCoworkRoleList(rolesInOrderMatch);
  }
  const roleMatchers: Array<{ role: string; pattern: RegExp }> = [
    { role: "planner", pattern: /\bplanner\b/i },
    { role: "product", pattern: /\bproduct\b/i },
    { role: "researcher", pattern: /\bresearcher\b/i },
    { role: "architect", pattern: /\barchitect\b/i },
    { role: "coder", pattern: /\bcoder\b/i },
    { role: "qa", pattern: /\bqa\b/i },
    { role: "ops", pattern: /\bops\b/i },
    { role: "risk review", pattern: /\brisk review\b/i },
    { role: "operator handoff", pattern: /\boperator handoff\b/i },
    { role: "operator", pattern: /\boperator(?![\s-]+(?:handoff|visible|facing|ready))\b/i },
    { role: "personal assistant", pattern: /\bpersonal assistant\b/i },
  ];
  const roles: string[] = [];
  for (const matcher of roleMatchers) {
    if (matcher.pattern.test(roleSource) && !roles.includes(matcher.role)) {
      roles.push(matcher.role);
    }
  }
  return roles;
}

export function parseCoworkRoleList(value: string): string[] {
  const rolePatterns: Array<{ role: string; pattern: RegExp }> = [
    { role: "operator handoff", pattern: /\boperator\s+handoff\b/gi },
    { role: "personal assistant", pattern: /\bpersonal\s+assistant\b/gi },
    { role: "risk review", pattern: /\brisk\s+review\b/gi },
    { role: "quality assurance", pattern: /\bquality\s+assurance\b/gi },
    { role: "planner", pattern: /\bplanner\b/gi },
    { role: "product", pattern: /\bproduct\b/gi },
    { role: "researcher", pattern: /\bresearcher\b/gi },
    { role: "architect", pattern: /\barchitect\b/gi },
    { role: "coder", pattern: /\bcoder\b/gi },
    { role: "qa", pattern: /\bqa\b/gi },
    { role: "ops", pattern: /\bops\b/gi },
    { role: "operator", pattern: /\boperator(?![\s-]+(?:handoff|visible|facing|ready))\b/gi },
  ];
  const matches: Array<{ role: string; index: number }> = [];
  for (const { role, pattern } of rolePatterns) {
    for (const match of value.matchAll(pattern)) {
      matches.push({ role: normalizeCoworkRoleLabel(role), index: match.index ?? 0 });
    }
  }
  const ordered = matches
    .sort((left, right) => left.index - right.index)
    .map((match) => match.role)
    .filter((role, index, roles) => roles.indexOf(role) === index && isRecognizedCoworkRole(role));
  if (ordered.length > 0) {
    return ordered;
  }
  return value
    .split(/\s*,\s*|\s+and\s+/i)
    .map((part) => normalizeCoworkRoleLabel(part))
    .filter(isRecognizedCoworkRole);
}

export function promptKeepsRequestedRoleOrderOnly(prompt: string): boolean {
  const userTask = extractPrimaryUserTaskContent(prompt);
  return (
    /\bkeep\b[\s\S]{0,40}\brequested role order only\b/i.test(prompt) ||
    /\brequested role order only\b/i.test(prompt) ||
    /\bkeep exactly these sections(?: in order)?\b/i.test(prompt) ||
    /\broles?\s+in\s+(?:this\s+)?exact\s+order\b/i.test(userTask) ||
    /\bproduce\b[\s\S]{0,80}\bsections?\s+for\s+members,\s*organizer,\s+and\s+risk\s+review\b/i.test(userTask) ||
    (/\brequested role order\b/i.test(prompt) && /\bno extra headings\b/i.test(prompt)) ||
    (/\bexactly these sections(?: in order)?\b/i.test(prompt) &&
      /\bdo not add any (?:intro|recap|synthesis|extra headings?)\b/i.test(prompt))
  );
}

export function coworkContractRequiresSynthesis(prompt: string): boolean {
  return !promptKeepsRequestedRoleOrderOnly(prompt);
}

export function extractExactCoworkSections(prompt: string): string[] {
  const userTask = extractPrimaryUserTaskContent(prompt) || prompt;
  if (/\bsections?\s+for\s+members,\s*organizer,\s+and\s+risk\s+review\b/i.test(userTask)) {
    return ["Members", "Organizer", "Risk Review"];
  }
  const marker = prompt.match(
    /(?:output|keep) exactly these(?: top-level)? sections(?: in this order| in order)?:\s*([\s\S]+)/i,
  );
  if (!marker?.[1]) {
    return [];
  }
  const [firstLine = "", ...remainingLines] = marker[1].split(/\r?\n/);
  const firstLineTrimmed = firstLine.trim();
  if (firstLineTrimmed && !/^[*-]\s+/.test(firstLineTrimmed)) {
    const inlineSections = Array.from(firstLine.matchAll(/`([^`]+)`/g))
      .map((match) => match[1]?.trim() ?? "")
      .filter(Boolean);
    if (inlineSections.length > 0) {
      return inlineSections;
    }
  }
  const sections: string[] = [];
  for (const rawLine of [firstLine, ...remainingLines]) {
    const trimmed = rawLine.trim();
    if (!trimmed) {
      if (sections.length > 0) {
        break;
      }
      continue;
    }
    const bulletMatch = trimmed.match(/^[-*]\s+`?([^`]+?)`?\s*\.?$/);
    if (!bulletMatch) {
      if (sections.length > 0) {
        break;
      }
      continue;
    }
    sections.push(bulletMatch[1]!.trim());
  }
  return sections;
}

export function normalizeCoworkRoleLabel(value: string): string {
  const normalized = value
    .toLowerCase()
    .replace(/[`".:]/g, "")
    .replace(/\bgoat\b/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) {
    return "";
  }
  if (normalized === "quality assurance") {
    return "qa";
  }
  return normalized;
}

export function isRecognizedCoworkRole(role: string): boolean {
  return (
    role === "planner" ||
    role === "product" ||
    role === "researcher" ||
    role === "architect" ||
    role === "coder" ||
    role === "qa" ||
    role === "ops" ||
    role === "risk review" ||
    role === "operator" ||
    role === "operator handoff" ||
    role === "personal assistant"
  );
}

export function formatCoworkRoleHeading(role: string): string {
  return role === "qa"
    ? "QA"
    : role
        .split(" ")
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
        .join(" ");
}

export function coworkRoleSectionPresent(response: string, role: string): boolean {
  const patterns: Record<string, RegExp> = {
    planner: /(?:^|\n)\s*(?:#+\s*)?(?:\*\*|__)?planner(?:\*\*|__)?\b/i,
    product: /(?:^|\n)\s*(?:#+\s*)?(?:\*\*|__)?product(?: goat)?(?:\*\*|__)?\b/i,
    researcher: /(?:^|\n)\s*(?:#+\s*)?(?:\*\*|__)?researcher(?: goat)?(?:\*\*|__)?\b/i,
    architect: /(?:^|\n)\s*(?:#+\s*)?(?:\*\*|__)?architect(?: goat)?(?:\*\*|__)?\b/i,
    coder: /(?:^|\n)\s*(?:#+\s*)?(?:\*\*|__)?coder(?: goat)?(?:\*\*|__)?\b/i,
    qa: /(?:^|\n)\s*(?:#+\s*)?(?:\*\*|__)?qa(?: goat)?(?:\*\*|__)?\b/i,
    ops: /(?:^|\n)\s*(?:#+\s*)?(?:\*\*|__)?ops(?: goat)?(?:\*\*|__)?\b/i,
    "risk review": /(?:^|\n)\s*(?:#+\s*)?(?:\*\*|__)?risk review(?:\*\*|__)?\b/i,
    "operator handoff": /(?:^|\n)\s*(?:#+\s*)?(?:\*\*|__)?operator handoff(?:\*\*|__)?\b/i,
    operator: /(?:^|\n)\s*(?:#+\s*)?(?:\*\*|__)?operator(?:\*\*|__)?(?![\s-]+(?:handoff|visible|facing|ready))\b/i,
    "personal assistant": /(?:^|\n)\s*(?:#+\s*)?(?:\*\*|__)?personal assistant(?:\*\*|__)?\b/i,
  };
  return patterns[role]?.test(response) ?? false;
}

export function detectPresentCoworkRoles(response: string): string[] {
  return [
    "planner",
    "product",
    "researcher",
    "architect",
    "coder",
    "qa",
    "ops",
    "risk review",
    "operator handoff",
    "operator",
    "personal assistant",
  ].filter((role) => coworkRoleSectionPresent(response, role));
}

export function hasCoworkSynthesisSection(response: string): boolean {
  return /(?:^|\n)\s*(?:#+\s*)?(?:synthesis|final recommendation|recommendation|final answer|conclusion|bottom line)\b/i.test(
    response,
  );
}

export function parseCoworkMarkdownSections(response: string): Array<{ heading: string; bodyLines: string[] }> {
  const sections: Array<{ heading: string; bodyLines: string[] }> = [];
  let current: { heading: string; bodyLines: string[] } | undefined;
  for (const line of response.split(/\r?\n/)) {
    const headingMatch = line.match(/^\s*#{1,6}\s+(.+?)\s*$/);
    const bareHeadingMatch =
      headingMatch ??
      line.match(
        /^\s*(Members|Organizer|Researcher|Planner|Risk Review|Operator Handoff|Operator|Product|Architect|Coder|QA|Ops|Personal Assistant|Synthesis)\s*$/i,
      );
    if (bareHeadingMatch) {
      if (current) {
        sections.push(current);
      }
      current = {
        heading: bareHeadingMatch[1]!.trim(),
        bodyLines: [],
      };
      continue;
    }
    if (current) {
      current.bodyLines.push(line);
    }
  }
  if (current) {
    sections.push(current);
  }
  return sections;
}

export function extractRequestedCoworkSectionBulletCount(prompt: string): number | undefined {
  const exactMatch = prompt.match(/\beach section must contain exactly (\d+) bullets?\b/i);
  if (!exactMatch?.[1]) {
    return undefined;
  }
  const parsed = Number.parseInt(exactMatch[1], 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

export function normalizeCoworkSectionBody(bodyLines: string[], exactBulletCount?: number): string {
  const trimmedLines = bodyLines.map((line) => line.trimEnd());
  if (exactBulletCount === undefined) {
    return trimmedLines.join("\n").trim();
  }
  const bulletLines = trimmedLines.filter((line) => /^[-*]\s+/.test(line.trim()));
  return bulletLines.slice(0, exactBulletCount).join("\n").trim();
}

export function extractCoworkWordLimit(prompt: string): number | undefined {
  const match = prompt.match(/\b(?:under|below|max(?:imum)? of)\s+(\d+)\s+words?\b/i);
  if (!match?.[1]) {
    return undefined;
  }
  const parsed = Number.parseInt(match[1], 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

export function countWords(value: string): number {
  return value.trim().split(/\s+/).filter(Boolean).length;
}

export function compactCoworkOutputToWordLimit(response: string, maxWords: number): string {
  if (countWords(response) <= maxWords) {
    return response;
  }
  const compactedLines = response.split(/\r?\n/).map((line) => compactCoworkLine(line));
  const compacted = compactedLines.join("\n").trim();
  if (countWords(compacted) <= maxWords) {
    return compacted;
  }
  const tightened = compactedLines
    .map((line) => compactCoworkLine(line, true))
    .join("\n")
    .trim();
  return countWords(tightened) <= maxWords ? tightened : compacted;
}

export function compactCoworkLine(line: string, aggressive = false): string {
  const trimmed = line.trim();
  if (!trimmed.startsWith("-")) {
    return line;
  }
  const withoutMarkdown = trimmed.replace(/\*\*([^*]+)\*\*/g, "$1");
  const body = withoutMarkdown.replace(/^-+\s*/, "");
  const sentenceSplit = body.split(/(?<=[.!?])\s+/);
  const primarySentence = sentenceSplit[0] ?? body;
  if (!aggressive) {
    return `- ${primarySentence.trim()}`;
  }
  const compactClause = primarySentence.split(/[;:](?=\s+[A-Z])/)[0] ?? primarySentence;
  return `- ${compactClause.trim()}`;
}

export function repairRequestedRoleOrderOnlyCoworkOutput(input: {
  prompt: string;
  responseText: string;
  requiredRoles: string[];
}): string | undefined {
  const exactSections = extractExactCoworkSections(input.prompt);
  const effectiveRoles = input.requiredRoles.length > 0 ? input.requiredRoles : detectCoworkRoleOrder(input.prompt);
  const requiredSections =
    exactSections.length > 0 ? exactSections : effectiveRoles.map((role) => formatCoworkRoleHeading(role));
  if (requiredSections.length === 0) {
    return undefined;
  }

  const parsedSections = parseCoworkMarkdownSections(input.responseText);
  if (parsedSections.length === 0) {
    return undefined;
  }

  const exactBulletCount = extractRequestedCoworkSectionBulletCount(input.prompt);
  const repairedSections: string[] = [];
  for (const sectionLabel of requiredSections) {
    const normalizedLabel = normalizeCoworkRoleLabel(sectionLabel);
    const section = parsedSections.find((candidate) => normalizeCoworkRoleLabel(candidate.heading) === normalizedLabel);
    if (!section) {
      return undefined;
    }
    const normalizedBody = normalizeCoworkSectionBody(section.bodyLines, exactBulletCount);
    if (!normalizedBody) {
      return undefined;
    }
    repairedSections.push(`${sectionLabel}\n${normalizedBody}`);
  }

  const repaired = repairedSections.join("\n\n").trim();
  return repaired.length > 0 ? repaired : undefined;
}

export function normalizeRequestedRoleOnlyCoworkHeadings(response: string): string {
  return response.replace(/^##\s+([^\n]+)$/gm, "$1").trim();
}
