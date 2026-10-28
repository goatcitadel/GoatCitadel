/** Hashing needs the whole file in memory (Web Crypto cannot hash a stream), so only small uploads carry a hash. */
export const UPLOAD_HASH_MAX_BYTES = 8 * 1024 * 1024;

/**
 * The SHA-256 a streamed upload sends as `X-Content-SHA256` for the Gateway to verify. Skipped where Web Crypto is
 * unavailable (plain-HTTP LAN origins) and for files over {@link UPLOAD_HASH_MAX_BYTES}.
 */
export async function hashUploadBody(body: Blob): Promise<string | undefined> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle || body.size > UPLOAD_HASH_MAX_BYTES) return undefined;
  const digest = new Uint8Array(await subtle.digest("SHA-256", await body.arrayBuffer()));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** The `X-Content-SHA256` header for a streamed upload, or nothing when the hash was skipped. */
export async function uploadHashHeaders(
  body: Blob,
): Promise<{ headers: Record<string, string> } | Record<string, never>> {
  const sha256 = await hashUploadBody(body);
  return sha256 ? { headers: { "X-Content-SHA256": sha256 } } : {};
}
