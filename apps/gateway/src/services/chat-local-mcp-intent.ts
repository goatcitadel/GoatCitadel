/** Local MCP work owns its tool selection; it does not imply a public web lookup. */
export function isExplicitLocalMcpTask(content: string): boolean {
  if (!/\bmcp[._]invoke\b/iu.test(content)) return false;
  if (!/\b(?:local|localhost|127\.0\.0\.1)\b/iu.test(content) && !content.includes("[::1]")) return false;
  if (/\b(?:browser|web)\.(?:search|fetch|navigate)\b/iu.test(content)) return false;
  for (const match of content.matchAll(/https?:\/\/[^\s<>]+/giu)) {
    try {
      if (!["localhost", "127.0.0.1", "[::1]"].includes(new URL(match[0]).hostname)) return false;
    } catch {
      return false;
    }
  }
  return true;
}
