import { createTransientInputOwner } from "../library/transient-input-owner";
// Dedicated volatile credential custody. Never read by general editor drafts, serialize,
// inspect in diagnostics, or persist to browser storage. Submission remains owner-specific.
const credentials = createTransientInputOwner();
export const useCredentialInput = credentials.useSessionDraft;
export const hasCredentialInput = credentials.hasSessionDraft;
const submissions = new Map<string, { key: string; value: string }>();
let submissionId = 0;
/** Only this opaque local receipt may enter generic change-plan continuation state. */
export function retainCredentialSubmission(key: string, value: string): string {
  const receipt = `credential-input-${++submissionId}`;
  submissions.set(receipt, { key, value });
  return receipt;
}
export function settleCredentialSubmission(key: string, receipt: string, accept: (value: string) => boolean): boolean {
  const submitted = submissions.get(receipt);
  if (!submitted || submitted.key !== key) return false;
  const settled = accept(submitted.value);
  submissions.delete(receipt);
  return settled;
}
export function __resetCredentialInputsForTests() {
  submissions.clear();
  credentials.resetForTests();
}
