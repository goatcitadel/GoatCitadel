import { canonicalJsonString, type LlmProviderRequestConfig } from "@goatcitadel/contracts";
import { providerProfilePlanRequest, providerSaveInput, type ProviderSaveDraft } from "./provider-save-contract";

/** What saving this draft sends, normalized as the save normalizes it. A governed creation also sends custody. */
function sentProviderPayload(draft: ProviderSaveDraft): string {
  const { request, ...profile } = providerSaveInput(draft);
  return canonicalJsonString(
    draft.governedCreation ? { request, plan: providerProfilePlanRequest(draft) } : { request, profile },
  );
}

/**
 * Whether saving `draft` sends anything that `saved` doesn't already hold. A draft can differ from the saved
 * profile only in ways the save trims or parses away, and resubmitting the saved profile can conflict.
 * Throws where the save itself would refuse the draft.
 */
export function sendsProviderChanges(draft: ProviderSaveDraft, saved: ProviderSaveDraft): boolean {
  return sentProviderPayload(draft) !== sentProviderPayload(saved);
}

/** The existing owner merges transport fields; absence is not a delete instruction. */
function removedField(previous: unknown, next: unknown, path = "transport"): string | undefined {
  if (previous === undefined) return undefined;
  if (next === undefined) return path;
  if (!previous || !next || typeof previous !== "object" || typeof next !== "object" || Array.isArray(previous))
    return undefined;
  const before = previous as Record<string, unknown>,
    after = next as Record<string, unknown>;
  // The owner replaces a different auth variant, rather than merging across variants.
  if (before.type && after.type && before.type !== after.type) return undefined;
  for (const [key, value] of Object.entries(before)) {
    const missing = removedField(value, after[key], `${path}.${key}`);
    if (missing) return missing;
  }
  return undefined;
}

function rejectInlineAuth(request: LlmProviderRequestConfig) {
  for (const auth of [request.auth, request.proxy?.auth]) {
    if (!auth) continue;
    const value = "token" in auth ? auth.token : "value" in auth ? auth.value : undefined;
    if (value?.trim() && value.trim() !== "[REDACTED]") {
      throw new Error(
        "Inline transport credentials are not accepted. Use environment references for request and proxy authentication.",
      );
    }
  }
}

export function prepareProviderSave(draft: ProviderSaveDraft, baseline: ProviderSaveDraft, existing: boolean) {
  const { request, ...profile } = providerSaveInput(draft);
  const { request: savedRequest, ...savedProfile } = providerSaveInput(baseline);
  const transportChanged = canonicalJsonString(request ?? null) !== canonicalJsonString(savedRequest ?? null);
  if (!transportChanged) return { kind: "profile" as const, profile };
  if (!existing || canonicalJsonString(profile) !== canonicalJsonString(savedProfile)) {
    throw new Error("Save and confirm the public provider profile first, then review transport as a separate change.");
  }
  const removed = removedField(savedRequest, request);
  if (!request || removed) {
    throw new Error(
      `The Gateway transport owner preserves omitted fields. Removing ${removed ?? "transport settings"} is not supported by this editor; restore that field before saving.`,
    );
  }
  rejectInlineAuth(request);
  return { kind: "transport" as const, providerId: profile.providerId, request };
}
