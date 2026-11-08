/** Classify parsed API request paths without discarding owner mutations. */
export function classifyCockpitProofWrite(method, pathname) {
  if (!["POST", "PUT", "PATCH", "DELETE"].includes(method) || !pathname.startsWith("/api/v1/")) return undefined;
  return method === "PUT" && pathname === "/api/v1/notifications/presence" ? "presence" : "owner";
}
