import { buildGatewayUrl, readGatewayAuthHeaders, request } from "./client-core.js";
export interface NativeFileScope { registryWorkspaceId: string; assignmentId: string; assignmentGeneration: number; nonce: string }
export interface NativeFileEntry { fileIndex: number; logicalPath: string; byteCount: number; sha256: string }
export interface NativeFileList extends NativeFileScope { receiptSha256: string; files: readonly NativeFileEntry[] }
const invalid = () => new Error("Native file response did not match the requested verified artifact.");
const digest = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/u.test(value) && !/^0+$/u.test(value);
function address(scope: NativeFileScope) {
  if ([scope.registryWorkspaceId, scope.assignmentId].some(value => typeof value !== "string" || !value || value.length > 256 || value.normalize("NFKC").trim() !== value || /\p{Cc}/u.test(value)) ||
      !Number.isSafeInteger(scope.assignmentGeneration) || scope.assignmentGeneration < 1 || scope.assignmentGeneration > 2147483647 || !digest(scope.nonce)) throw invalid();
  return `/api/v1/ops/workspaces/${encodeURIComponent(scope.registryWorkspaceId)}/remote-worker-assignments/${encodeURIComponent(scope.assignmentId)}/native-file-artifacts/${scope.nonce}?assignmentGeneration=${scope.assignmentGeneration}`;
}
function row(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) throw invalid();
  return value as Record<string, unknown>;
}
export async function fetchNativeFileList(input: NativeFileScope): Promise<NativeFileList> {
  const scope = Object.freeze({ ...input }), path = address(scope), value = row(await request<unknown>(path),
    ["registryWorkspaceId", "assignmentId", "assignmentGeneration", "nonce", "receiptSha256", "files"]);
  if (Object.entries(scope).some(([key, expected]) => value[key] !== expected) || !digest(value.receiptSha256) || !Array.isArray(value.files) || value.files.length < 1 || value.files.length > 64) throw invalid();
  const paths = new Set<string>();
  const files = value.files.map((input, index) => {
    const file = row(input, ["fileIndex", "logicalPath", "byteCount", "sha256"]);
    if (file.fileIndex !== index || typeof file.logicalPath !== "string" || !file.logicalPath || file.logicalPath.length > 512 || /\p{Cc}/u.test(file.logicalPath) ||
        paths.has(file.logicalPath) || typeof file.byteCount !== "number" || !Number.isSafeInteger(file.byteCount) || file.byteCount < 0 || file.byteCount > 1048576 || !digest(file.sha256)) throw invalid();
    paths.add(file.logicalPath); return Object.freeze({ fileIndex: index, logicalPath: file.logicalPath, byteCount: file.byteCount, sha256: file.sha256 });
  });
  return Object.freeze({ ...scope, receiptSha256: value.receiptSha256, files: Object.freeze(files) });
}
export async function downloadNativeFile(input: NativeFileScope, selected: NativeFileEntry) {
  const scope = Object.freeze({ ...input }), file = Object.freeze({ ...selected });
  if (!Number.isSafeInteger(file.fileIndex) || file.fileIndex < 0 || file.fileIndex > 63 || !Number.isSafeInteger(file.byteCount) || file.byteCount < 0 || file.byteCount > 1048576 || !digest(file.sha256)) throw invalid();
  const path = `${address(scope)}&fileIndex=${file.fileIndex}`;
  const response = await fetch(buildGatewayUrl(path), { headers: readGatewayAuthHeaders(path), signal: AbortSignal.timeout(15000) });
  if (!response.ok || response.headers.get("content-type") !== "application/octet-stream" || response.headers.get("x-content-sha256") !== file.sha256 || !response.body) {
    await response.body?.cancel().catch(() => undefined); throw invalid();
  }
  const reader = response.body.getReader(), bytes = new Uint8Array(file.byteCount); let offset = 0;
  try {
    for (;;) {
      const chunk = await reader.read(); if (chunk.done) break;
      if (offset + chunk.value.byteLength > bytes.length) throw invalid(); bytes.set(chunk.value, offset); offset += chunk.value.byteLength;
    }
    if (offset !== bytes.length || Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), byte => byte.toString(16).padStart(2, "0")).join("") !== file.sha256) throw invalid();
    return { blob: new Blob([bytes], { type: "application/octet-stream" }), fileName: `native-${scope.nonce.slice(0, 16)}-${file.fileIndex}.bin` };
  } finally { bytes.fill(0); await reader.cancel().catch(() => undefined); reader.releaseLock(); }
}
