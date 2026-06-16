/**
 * CitadelPassage — explicit cross-Citadel sharing bridge (spec §12.7).
 *
 * Only allow-listed fields may cross a Passage boundary, and a Passage
 * can carry an optional expiry so the bridge automatically closes.
 */

export interface CitadelPassage {
  passageId: string;
  sourceCitadelId: string;
  sourceChamberId?: string;
  destinationCitadelId: string;
  /** ONLY these top-level keys may cross the Passage boundary. */
  allowedFields: string[];
  /** ISO-8601 instant; absent means the Passage never expires. */
  expiresAt?: string;
}

/**
 * Returns true when the Passage is currently active:
 * - No `expiresAt` → always active.
 * - `expiresAt` present → active only when it is strictly after `nowIso`.
 */
export function isPassageActive(
  passage: CitadelPassage,
  nowIso: string,
): boolean {
  if (passage.expiresAt === undefined) {
    return true;
  }
  return Date.parse(passage.expiresAt) > Date.parse(nowIso);
}

/**
 * Returns a NEW object containing only the keys that are both listed in
 * `passage.allowedFields` AND present in `data`.
 *
 * Does NOT mutate `data`.
 */
export function filterPassageFields(
  passage: CitadelPassage,
  data: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const key of passage.allowedFields) {
    if (Object.prototype.hasOwnProperty.call(data, key)) {
      result[key] = data[key];
    }
  }
  return result;
}
