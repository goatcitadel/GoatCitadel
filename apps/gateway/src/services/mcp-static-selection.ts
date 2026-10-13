/** Exact user-authored identifiers, including quoted mentions and sentence punctuation. */
export function hasExplicitMcpIdentifier(content: string, identifier: string): boolean {
  const escaped = identifier.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(`(^|[^\\p{L}\\p{N}_.:/-])${escaped}(?![\\p{L}\\p{N}_:/-]|\\.[\\p{L}\\p{N}_])`, "u").test(content);
}

export function selectExplicitStaticMcpServers<T extends { serverId: string }>(
  content: string,
  servers: readonly T[],
): T[] {
  // Server IDs can contain dots. A canonical tool mention belongs to the
  // longest saved server prefix, never another server whose ID is a prefix.
  const ordered = [...servers].sort((a, b) => b.serverId.length - a.serverId.length);
  const canonicalMentions = content.match(/(?<![\p{L}\p{N}_.:/-])mcp\.[^\s"'`<>{}()[\],;!?]+/gu) ?? [];
  const canonicalServers = new Set(
    canonicalMentions.flatMap((mention) => {
      const server = ordered.find(
        (entry) =>
          mention.startsWith(`mcp.${entry.serverId}.`) &&
          mention.slice(entry.serverId.length + 5).replace(/\.$/u, "").length > 0,
      );
      return server ? [server.serverId] : [];
    }),
  );
  return servers.filter(
    (server) => hasExplicitMcpIdentifier(content, server.serverId) || canonicalServers.has(server.serverId),
  );
}
