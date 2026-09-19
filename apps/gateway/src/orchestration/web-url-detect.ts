/** Recognize supplied website addresses without treating tool names or paths as URLs. */
export function extractExplicitWebUrl(content: string): string | undefined {
  const explicit = content.match(/(?<![\w@./\\-])(?:https?:\/\/(?:\[[0-9a-f:.]+\])?|www\.)[^\s<>"'`\])}]*/iu)?.[0];
  // A bare domain needs a website cue: arbitrary dotted words can be files or tools.
  const contextual = content.match(
    /\b(?:website|web\s+site|site|domain|url)\b(?:\s+(?:at|is))?[\s,:=([<"'`]+([a-z0-9][^\s<>"'`\])}]+)/iu,
  )?.[1];
  const candidate = (explicit ?? contextual)?.replace(/[.,;:!?]+$/u, "");
  if (!candidate) return undefined;

  const hasScheme = /^https?:\/\//iu.test(candidate);
  const url = hasScheme ? candidate : `https://${candidate}`;
  try {
    const parsed = new URL(url);
    if (
      !hasScheme &&
      (parsed.username ||
        parsed.password ||
        !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/iu.test(parsed.hostname) ||
        /\.(?:ts|tsx|js|jsx|mjs|cjs|json|md|txt|html|css|py|rs|go|sh|yaml|yml)$/iu.test(parsed.hostname))
    )
      return undefined;
    return url;
  } catch {
    return undefined;
  }
}
