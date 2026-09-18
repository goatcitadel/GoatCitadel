const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const RECEIPT_ACCOUNT = /^mcp:.+:(?:access-token|refresh-token|environment):receipt-v1:([a-f0-9-]+)$/u;
const MAX_BYTES = 48 * 1024;

export function isMcpReceiptAccount(account: string): boolean {
  const match = RECEIPT_ACCOUNT.exec(account);
  return match !== null && UUID.test(match[1]!);
}

export function isMcpCredentialWriteId(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value);
}

/** The receipt and value occupy one immutable keychain slot. Neither the raw
 * value nor its digest belongs in the staging/retirement metadata. */
export function encodeMcpCredentialReceipt(secret: string, writeId: string): string {
  if (!isMcpCredentialWriteId(writeId) || typeof secret !== "string" || !secret.trim()) throw invalid();
  // Windows PowerShell console pipes may use a legacy code page. Keep the
  // envelope ASCII on both stdin and stdout while preserving UTF-16 code units.
  const encoded = JSON.stringify({ version: 1, writeId, secret })
    .replace(/[^\x20-\x7e]/gu, (character) => character.split("")
      .map((unit) => `\\u${unit.charCodeAt(0).toString(16).padStart(4, "0")}`).join(""));
  if (Buffer.byteLength(encoded, "utf8") > MAX_BYTES) throw invalid();
  return encoded;
}

export function decodeMcpCredentialReceipt(encoded: string): { writeId: string; secret: string } {
  if (Buffer.byteLength(encoded, "utf8") > MAX_BYTES) throw invalid();
  let value: unknown;
  try { value = JSON.parse(encoded); } catch { throw invalid(); }
  const row = value as { version?: unknown; writeId?: unknown; secret?: unknown };
  if (!row || typeof row !== "object" || Array.isArray(row) || Object.keys(row).length !== 3 || row.version !== 1 ||
    !isMcpCredentialWriteId(row.writeId) || typeof row.secret !== "string" || !row.secret.trim()) throw invalid();
  return { writeId: row.writeId, secret: row.secret };
}

function invalid(): Error { return new Error("MCP credential write receipt is invalid or unavailable."); }
