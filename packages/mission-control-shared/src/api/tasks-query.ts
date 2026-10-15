/** Shared pure query construction; no request, state or runtime authority. */
export function withWorkspaceQuery(path: string, workspaceId?: string, citadelId?: string): string {
  const query = new URLSearchParams();
  const trimmedCitadelId = citadelId?.trim();
  const trimmedWorkspaceId = workspaceId?.trim();
  if (trimmedCitadelId) {
    query.set("citadelId", trimmedCitadelId);
  }
  if (trimmedWorkspaceId) {
    query.set("workspaceId", trimmedWorkspaceId);
  }
  const suffix = query.toString();
  if (!suffix) {
    return path;
  }
  return `${path}${path.includes("?") ? "&" : "?"}${suffix}`;
}
