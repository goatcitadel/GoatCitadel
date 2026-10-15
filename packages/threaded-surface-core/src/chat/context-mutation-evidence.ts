/** Relationship checks supplement the unchanged Gateway/API contract owners. */
export function assertContextRecord(
  value: unknown,
  sessionId: string,
  workspaceId: string,
  idField: "candidateId" | "itemId" | "sessionId",
  expectedId?: string,
): string {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new TypeError("The Gateway returned no canonical context record.");
  const record = value as Record<string, unknown>;
  const id = record[idField];
  if (
    typeof id !== "string" ||
    !id.trim() ||
    record.sessionId !== sessionId ||
    (record.workspaceId !== undefined && record.workspaceId !== workspaceId) ||
    (expectedId !== undefined && id !== expectedId)
  )
    throw new TypeError("The canonical context receipt does not match the reviewed conversation or record.");
  return id;
}
