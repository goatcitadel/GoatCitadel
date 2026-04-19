export function looksLikePromptLabPromptPackMarkdownImportPrompt(userTask: string | undefined): boolean {
  const normalized = (userTask ?? "").toLowerCase();
  return (
    /\bprompt-pack\b|\bprompt pack\b/.test(normalized) &&
    /\bmarkdown\b/.test(normalized) &&
    /\b(auto-loaded|autoloaded|auto loaded|imported|import)\b/.test(normalized)
  );
}

export function looksLikePromptLabPromptPackRepoBindingPrompt(userTask: string | undefined): boolean {
  const normalized = (userTask ?? "").toLowerCase();
  return (
    /\bprompt-pack\b|\bprompt pack\b/.test(normalized) &&
    /\b(repo\/project binding|repo-bound|project binding|tool-path resolution|tool path resolution)\b/.test(normalized)
  );
}

export function looksLikePromptLabPromptPackOperatorSurfacePrompt(userTask: string | undefined): boolean {
  const normalized = (userTask ?? "").toLowerCase();
  return (
    /\breport rendering\b/.test(normalized) &&
    /\btrend rendering\b/.test(normalized) &&
    /\bbenchmark\b/.test(normalized) &&
    /\b(status|api|apis|operator|evidence)\b/.test(normalized)
  );
}
