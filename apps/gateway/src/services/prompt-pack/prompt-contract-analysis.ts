export function detectPromptRequestedRoles(prompt: string): string[] {
  const normalized = prompt.toLowerCase();
  const roleMatchers: Array<{ role: string; pattern: RegExp }> = [
    { role: "product", pattern: /\bproduct goat\b|\bproduct\s*[:-]/ },
    { role: "architect", pattern: /\barchitect goat\b|\barchitect\s*[:-]/ },
    { role: "coder", pattern: /\bcoder goat\b|\bcoder\s*[:-]/ },
    { role: "qa", pattern: /\bqa goat\b|\bqa\s*[:-]/ },
    { role: "ops", pattern: /\bops goat\b|\bops\s*[:-]/ },
    { role: "researcher", pattern: /\bresearcher goat\b|\bresearcher\s*[:-]/ },
    { role: "personal assistant", pattern: /\bpersonal assistant\b/ },
  ];
  const roles: string[] = [];
  for (const entry of roleMatchers) {
    if (entry.pattern.test(normalized)) {
      roles.push(entry.role);
    }
  }
  if (roles.length === 0 && /\broute this through\b/.test(normalized)) {
    return ["product", "architect", "coder"];
  }
  return roles;
}

export function extractPromptPackRolesInOrder(text: string): string[] {
  const match = text.match(/roles?\s+in\s+(?:this\s+)?(?:exact\s+)?order\b[:\s]*([^\n]+)/i);
  if (!match?.[1]) {
    return [];
  }
  const roleAliases = new Map<string, string>([
    ["planner", "planner"],
    ["product", "product"],
    ["architect", "architect"],
    ["coder", "coder"],
    ["qa", "qa"],
    ["ops", "ops"],
    ["researcher", "researcher"],
    ["risk review", "risk review"],
    ["operator", "operator"],
    ["operator handoff", "operator handoff"],
    ["personal assistant", "personal assistant"],
  ]);
  const roles: string[] = [];
  for (const rawPart of splitPromptPackLabelList(trimPromptPackRoleOrderTail(match[1]))) {
    const normalizedPart = rawPart
      .toLowerCase()
      .replace(/\bgoat\b/g, "")
      .replace(/\s+/g, " ")
      .trim();
    const canonical = roleAliases.get(normalizedPart);
    if (canonical && !roles.includes(canonical)) {
      roles.push(canonical);
    }
  }
  return roles;
}

export function roleSectionPresent(response: string, role: string): boolean {
  const normalized = response.toLowerCase();
  const patterns: Record<string, RegExp> = {
    product: /(?:^|\n)\s*(?:#+\s*)?(?:\*\*|__)?product(?: goat)?(?:\*\*|__)?\b|prd/i,
    architect: /(?:^|\n)\s*(?:#+\s*)?(?:\*\*|__)?architect(?: goat)?(?:\*\*|__)?\b|architecture/i,
    coder: /(?:^|\n)\s*(?:#+\s*)?(?:\*\*|__)?coder(?: goat)?(?:\*\*|__)?\b|implementation|task list/i,
    qa: /(?:^|\n)\s*(?:#+\s*)?(?:\*\*|__)?qa(?: goat)?(?:\*\*|__)?\b|test plan|regression/i,
    ops: /(?:^|\n)\s*(?:#+\s*)?(?:\*\*|__)?ops(?: goat)?(?:\*\*|__)?\b|rollout|deployment/i,
    researcher: /(?:^|\n)\s*(?:#+\s*)?(?:\*\*|__)?researcher(?: goat)?(?:\*\*|__)?\b|sources|confidence/i,
    planner: /(?:^|\n)\s*(?:#+\s*)?(?:\*\*|__)?planner(?:\*\*|__)?\b|planning basis|decision path/i,
    synthesis:
      /(?:^|\n)\s*(?:#+\s*)?(?:\*\*|__)?(?:synthesis|synthesized recommendation|recommendation|final recommendation)(?:\*\*|__)?\b/i,
    "risk review": /(?:^|\n)\s*(?:#+\s*)?(?:\*\*|__)?risk review(?:\*\*|__)?\b|tradeoffs?|what would change/i,
    operator: /(?:^|\n)\s*(?:#+\s*)?(?:\*\*|__)?operator(?: goat)?(?:\*\*|__)?\b|operator handoff/i,
    "personal assistant": /(?:^|\n)\s*(?:#+\s*)?(?:\*\*|__)?personal assistant(?:\*\*|__)?\b/i,
  };
  const matcher = patterns[role];
  return matcher ? matcher.test(normalized) : false;
}

function escapePromptPackRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function responseContainsPromptPackSection(response: string, label: string): boolean {
  const trimmed = label.trim().replace(/[`"]/g, "");
  if (!trimmed) {
    return false;
  }
  const pattern = escapePromptPackRegex(trimmed)
    .replace(/\\\//g, "[\\\\/]")
    .replace(/\\-/g, "[-–—]")
    .replace(/\s+/g, "\\s+");
  return new RegExp(`(?:^|\\n)\\s*(?:#+\\s*)?(?:\\*\\*|__)?${pattern}(?:\\*\\*|__)?\\b`, "i").test(response);
}

export function responseMentionsPromptPackPerspective(response: string, label: string): boolean {
  const normalizedResponse = response.toLowerCase();
  const normalizedLabel = label.toLowerCase().trim();
  if (!normalizedLabel) {
    return false;
  }
  const compactLabel = normalizedLabel
    .replace(/\b(impact|implications|tradeoffs?|lens|lenses|perspective|perspectives)\b/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return (
    normalizedResponse.includes(normalizedLabel) ||
    (compactLabel.length > 0 && normalizedResponse.includes(compactLabel))
  );
}

export function detectPresentRoleSections(response: string): string[] {
  const candidateRoles = [
    "product",
    "researcher",
    "planner",
    "synthesis",
    "risk review",
    "operator",
    "architect",
    "coder",
    "qa",
    "ops",
  ];
  return candidateRoles.filter((role) => roleSectionPresent(response, role));
}

export function hasPromptPackSynthesisSection(response: string): boolean {
  return /(?:^|\n)\s*(?:#+\s*)?(?:synthesis|synthesized recommendation|controller synthesis|recommendation|final recommendation|final answer|conclusion|bottom line)\b/i.test(
    response,
  );
}

export function requiresPromptPackCitationEvidence(prompt: string): boolean {
  return (
    /\bcitation(?:s)?\b/i.test(prompt) ||
    /\bline numbers?\b/i.test(prompt) ||
    /\bexact files?\b/i.test(prompt) ||
    /\bfile(?:-specific|-grounded)\b[\s\S]{0,30}\bevidence\b/i.test(prompt) ||
    /\bevidence\b[\s\S]{0,30}\b(file(?:s)?|line(?:s)?|citation(?:s)?)\b/i.test(prompt) ||
    /\b(file(?:s)?|line(?:s)?|citation(?:s)?)\b[\s\S]{0,30}\bevidence\b/i.test(prompt) ||
    /\bcite\b[\s\S]{0,80}\b(file(?:s)?|line(?:s)?|citation(?:s)?|evidence)\b/i.test(prompt)
  );
}

export function extractPromptPackOrderedSections(prompt: string): string[] {
  const blockMarkers = [
    /output exactly these sections in this order:\s*([\s\S]+)/i,
    /keep exactly these sections in order:\s*([\s\S]+)/i,
  ];
  for (const marker of blockMarkers) {
    const match = prompt.match(marker);
    if (!match?.[1]) {
      continue;
    }
    const sections = parsePromptPackOrderedSectionTail(match[1]);
    if (sections.length > 0) {
      return sections;
    }
  }
  const sectionsForLabels = extractPromptPackSectionsForLabels(prompt);
  if (sectionsForLabels.length > 0) {
    return sectionsForLabels;
  }
  const backtickedWithSections = extractPromptPackBacktickedWithSections(prompt);
  if (backtickedWithSections.length > 0) {
    return backtickedWithSections;
  }
  const rolesInOrderMatch = prompt.match(/roles?\s+in\s+(?:this\s+)?(?:exact\s+)?order\b[:\s]*([^\n]+)/i);
  if (!rolesInOrderMatch?.[1]) {
    return [];
  }
  return splitPromptPackLabelList(trimPromptPackRoleOrderTail(rolesInOrderMatch[1]));
}

function extractPromptPackBacktickedWithSections(prompt: string): string[] {
  const match = prompt.match(/\bwith\s+((?:`[^`]+`\s*(?:,\s*|\s+and\s+)?){2,})/i);
  if (!match?.[1]) {
    return [];
  }
  return [...match[1].matchAll(/`([^`]+)`/g)].map((item) => item[1]!.trim()).filter(Boolean);
}

function extractPromptPackSectionsForLabels(prompt: string): string[] {
  const marker = "sections for";
  const lowerPrompt = prompt.toLowerCase();
  let searchStart = 0;
  while (searchStart < prompt.length) {
    const markerIndex = lowerPrompt.indexOf(marker, searchStart);
    if (markerIndex < 0) {
      return [];
    }
    const tail = prompt.slice(markerIndex + marker.length).trimStart();
    const firstChar = tail[0] ?? "";
    if (firstChar >= "A" && firstChar <= "Z") {
      const endIndex = findPromptPackSectionListEnd(tail);
      const rawLabels = tail.slice(0, endIndex).trim().replace(/[.]+$/, "");
      const sections = splitPromptPackLabelList(rawLabels);
      if (sections.length > 0) {
        return sections;
      }
    }
    searchStart = markerIndex + marker.length;
  }
  return [];
}

function findPromptPackSectionListEnd(value: string): number {
  const candidates = [value.indexOf(", then"), value.indexOf(" then"), value.indexOf(". "), value.indexOf("\n")].filter(
    (index) => index >= 0,
  );
  return candidates.length > 0 ? Math.min(...candidates) : value.length;
}

function parsePromptPackOrderedSectionTail(rawTail: string): string[] {
  const firstLine = rawTail.split(/\r?\n/, 1)[0]?.trim() ?? "";
  if (firstLine.length > 0 && !/^[-*]\s+/.test(firstLine)) {
    const inlineSections = splitPromptPackLabelList(firstLine.replace(/[.]+$/, ""));
    if (inlineSections.length > 0) {
      return inlineSections;
    }
  }

  const lines = rawTail.split(/\r?\n/);
  const sections: string[] = [];
  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (!trimmed) {
      if (sections.length > 0) {
        break;
      }
      continue;
    }
    if (/^rules?:/i.test(trimmed)) {
      break;
    }
    const bulletMatch = trimmed.match(/^[-*]\s+`?([^`]+?)`?\s*$/);
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

export function extractPromptPackPerspectiveLabels(prompt: string): string[] {
  const labels = new Set<string>();
  const addMatch = (pattern: RegExp): void => {
    const match = prompt.match(pattern);
    if (!match?.[1]) {
      return;
    }
    for (const label of splitPromptPackLabelList(match[1])) {
      labels.add(label);
    }
  };

  addMatch(/perspectives:\s*([^.]+)\./i);
  addMatch(/break the work into\s*([^.]+?)\s+lenses?/i);
  addMatch(/weigh\s+([^.]+?)\./i);

  return [...labels];
}

function splitPromptPackLabelList(rawValue: string): string[] {
  return rawValue
    .replace(/[`"]/g, "")
    .split(/\s*,\s*|\s+and\s+/i)
    .map((part) => part.trim().replace(/^and\s+/i, ""))
    .filter((part) => part.length > 0);
}

function trimPromptPackRoleOrderTail(rawValue: string): string {
  const [head = ""] = rawValue.split(/[.;]/, 1);
  return head.replace(/[.]+$/, "").trim();
}

export function promptRequiresControllerOwnedDelivery(prompt: string): boolean {
  return /\bonly the controller should speak in the final answer\b|\bwithout dumping raw sub-agent chatter\b|\bwithout raw sub-agent chatter\b/i.test(
    prompt,
  );
}
