import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { PromptPackBuiltinImportResult, PromptPackSecurityEvalPackRecord } from "@goatcitadel/contracts";
import { canonicalJsonString } from "@goatcitadel/contracts";
import {
  fetchPromptPackBuiltins,
  fetchPromptPackReport,
  importBuiltinPromptPackIfAbsent,
} from "@goatcitadel/mission-control-shared/api/prompt-packs";
import { isApiRequestError } from "@goatcitadel/mission-control-shared/api/client";
import { describeApiError } from "@goatcitadel/mission-control-shared/api/describe-api-error";

type Review = { definition: PromptPackSecurityEvalPackRecord };
type Attempt = { phase: "checking" | "saving" | "uncertain" | "confirmed"; message?: string };
const attempts = new Map<string, Attempt>();
const listeners = new Set<() => void>();
let version = 0;
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
const snapshot = () => version;
function update(key: string, state?: Attempt) {
  if (state) attempts.set(key, state);
  else attempts.delete(key);
  version += 1;
  for (const listener of listeners) listener();
}
const locked = (key: string) =>
  ["checking", "saving", "uncertain", "confirmed"].includes(attempts.get(key)?.phase ?? "");

export function supportsBuiltinFirstImport(item: PromptPackSecurityEvalPackRecord): boolean {
  const capability = item.importCapability;
  return Boolean(
    capability?.version === "prompt_pack.builtin_import.v1" &&
    capability.operation === "create_only" &&
    capability.packId === item.packKey &&
    capability.targetState === "absent" &&
    /^[a-f0-9]{64}$/.test(capability.definitionRevision) &&
    /^[a-f0-9]{64}$/.test(capability.contentSha256) &&
    Number.isSafeInteger(item.testCount) &&
    item.testCount > 0 &&
    item.status !== "unavailable",
  );
}
function sameReviewedDefinition(
  before: PromptPackSecurityEvalPackRecord,
  after: PromptPackSecurityEvalPackRecord,
): boolean {
  return (
    supportsBuiltinFirstImport(after) &&
    before.packKey === after.packKey &&
    before.testCount === after.testCount &&
    before.importCapability?.definitionRevision === after.importCapability?.definitionRevision &&
    before.importCapability?.contentSha256 === after.importCapability?.contentSha256
  );
}
export function assertBuiltinImportResult(
  definition: PromptPackSecurityEvalPackRecord,
  result: PromptPackBuiltinImportResult,
): void {
  const descriptor = definition.importCapability;
  const receipt = result?.importReceipt;
  if (
    !descriptor ||
    receipt?.version !== "prompt_pack.builtin_import_receipt.v1" ||
    receipt.operation !== "created" ||
    receipt.packKey !== definition.packKey ||
    receipt.definitionRevision !== descriptor.definitionRevision ||
    receipt.contentSha256 !== descriptor.contentSha256 ||
    result.pack?.packId !== descriptor.packId ||
    result.pack.contentSha256 !== descriptor.contentSha256 ||
    result.pack.testCount !== definition.testCount ||
    !Array.isArray(result.tests) ||
    result.tests.length !== definition.testCount ||
    result.tests.some((test) => test.packId !== descriptor.packId || !test.testId) ||
    new Set(result.tests.map((test) => test.testId)).size !== definition.testCount
  ) {
    throw new Error("The Gateway did not confirm the exact reviewed definition import.");
  }
}
function definiteConflict(error: unknown): boolean {
  if (!isApiRequestError(error) || error.status !== 409 || !error.body || typeof error.body !== "object") return false;
  const body = error.body as Record<string, unknown>;
  const details = body.details as Record<string, unknown> | undefined;
  return (
    body.code === "WRITE_CONFLICT" &&
    ["PROMPT_PACK_DEFINITION_CONFLICT", "PROMPT_PACK_ALREADY_EXISTS"].includes(String(details?.reason)) &&
    body.mutationCommitted !== true &&
    body.committed !== true &&
    details?.mutationCommitted === false &&
    details.committed !== true
  );
}

/** Create definitions only. A browser cannot authorize replacement or resolve an unknown write by retrying. */
export function useBuiltinPromptPackImport({ reload }: { reload: () => Promise<unknown> }) {
  useSyncExternalStore(subscribe, snapshot, snapshot);
  const mounted = useRef(true),
    generation = useRef(0);
  const [review, setReview] = useState<Review | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      generation.current += 1;
    };
  }, []);
  const current = (token: number) => mounted.current && generation.current === token;
  async function requestReview(definition: PromptPackSecurityEvalPackRecord) {
    if (!supportsBuiltinFirstImport(definition) || locked(definition.packKey)) return;
    const token = ++generation.current;
    setReview(null);
    setNotice(null);
    update(definition.packKey, { phase: "checking" });
    try {
      const owner = await fetchPromptPackBuiltins();
      const fresh = owner.items.find((item) => item.packKey === definition.packKey);
      if (!fresh || !sameReviewedDefinition(definition, fresh))
        throw new Error("The definition or its import availability changed. Refresh before reviewing it again.");
      if (current(token)) setReview({ definition: fresh });
    } catch (error) {
      if (current(token)) setNotice(describeApiError(error).summary);
    } finally {
      update(definition.packKey);
    }
  }
  async function confirm() {
    const selected = review?.definition;
    if (!selected || !supportsBuiltinFirstImport(selected) || locked(selected.packKey)) return;
    const token = generation.current;
    const descriptor = selected.importCapability!;
    update(selected.packKey, { phase: "saving" });
    setNotice(null);
    let receiptRecorded = false;
    try {
      // The import request is the first thing this block does, so every caught error follows its dispatch
      // (js/trivial-conditional flagged the former always-true `dispatched` flag).
      const result = await importBuiltinPromptPackIfAbsent(selected.packKey, {
        expectedDefinitionRevision: descriptor.definitionRevision,
      });
      assertBuiltinImportResult(selected, result);
      receiptRecorded = true;
      const owner = await fetchPromptPackReport(descriptor.packId);
      if (
        owner.pack.packId !== descriptor.packId ||
        owner.pack.contentSha256 !== descriptor.contentSha256 ||
        owner.pack.updatedAt !== result.pack.updatedAt ||
        owner.pack.testCount !== selected.testCount ||
        owner.tests.length !== result.tests.length ||
        new Set(owner.tests.map((test) => test.testId)).size !== result.tests.length ||
        owner.tests.some((test) => test.packId !== descriptor.packId) ||
        owner.tests.some(
          (test) =>
            canonicalJsonString(test) !==
            canonicalJsonString(result.tests.find((saved) => saved.testId === test.testId)),
        )
      ) {
        throw new Error("The imported definition could not be confirmed from its current owner.");
      }
      update(selected.packKey, {
        phase: "confirmed",
        message: `${owner.pack.name} imported and confirmed with ${owner.tests.length} test${owner.tests.length === 1 ? "" : "s"}. No evaluations were run.`,
      });
      if (current(token)) {
        setReview(null);
        setNotice(attempts.get(selected.packKey)!.message!);
      }
      // Refresh failures do not turn a confirmed write into an invitation to retry.
      try {
        await reload();
      } catch {
        /* The separate evidence view already reports its refresh state. */
      }
    } catch (error) {
      const uncertain = !definiteConflict(error);
      const message = uncertain
        ? `${receiptRecorded ? "An import receipt was recorded, but the current saved definition could not be confirmed." : "Import outcome is unconfirmed."} Do not retry this definition. Inspect its saved owner.`
        : `The import was not applied. Refresh and review the current definition. ${describeApiError(error).summary}`;
      update(selected.packKey, uncertain ? { phase: "uncertain", message } : undefined);
      if (current(token)) {
        setReview(null);
        setNotice(message);
      }
      try {
        await reload();
      } catch {
        /* Keep the original mutation outcome. */
      }
    }
  }
  function cancel() {
    if (review && attempts.get(review.definition.packKey)?.phase === "saving") return;
    generation.current += 1;
    setReview(null);
  }
  return {
    review,
    notice,
    requestReview,
    confirm,
    cancel,
    pending: review ? attempts.get(review.definition.packKey)?.phase === "saving" : false,
    stateFor: (key: string) => attempts.get(key),
    locked,
  };
}

export function __resetBuiltinPromptPackImportsForTests() {
  attempts.clear();
  version += 1;
  for (const listener of listeners) listener();
}
