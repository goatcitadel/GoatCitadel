export function isPromptLabHarnessContent(content: string): boolean {
  const normalized = content.toLowerCase();
  return normalized.includes("## prompt lab run contract") || normalized.includes("## prompt lab tooling contract");
}

export function looksLikeRepoGroundedInspectionPrompt(prompt: string): boolean {
  const normalized = prompt.toLowerCase();
  return (
    /\binspect(?: the)? (?:repo|repository|codebase|workspace)\b/.test(normalized) ||
    /\buse (?:(?:file|code|file\/code|file or code)(?: tools?)?)\b/.test(normalized) ||
    /\b(?:file|code) tools\b/.test(normalized) ||
    /\bexact files?\b/.test(normalized) ||
    /\bexact evidence\b/.test(normalized) ||
    /\bexact citations?\b/.test(normalized) ||
    /\bcurrent implementation\b/.test(normalized) ||
    /\bguidance-loading chain\b/.test(normalized) ||
    /\binspect\b[\s\S]{0,80}\b(?:routes|services|wiring|contracts?|tests?|ui|copy|prompt lab|prompt-pack)\b/.test(
      normalized,
    ) ||
    (/\bcurrent\b/.test(normalized) && /\b(repo|repository|workspace|codebase)\b/.test(normalized))
  );
}
