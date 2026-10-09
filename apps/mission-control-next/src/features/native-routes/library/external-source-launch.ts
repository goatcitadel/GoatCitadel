/** One governed source-launch destination for Library and the later Chat attachment flow. */
export function externalSourceManagementHref(workspaceId: string, sourceId?: string) {
  const query = new URLSearchParams({ shell: "classic", workspaceId });
  if (sourceId) query.set("sourceId", sourceId);
  return `/library/knowledge?${query}#external-sources`;
}
