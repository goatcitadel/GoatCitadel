import { ServiceUnavailableError } from "@goatcitadel/contracts";

/** A confirmed definition commit must never be reclassified as a retryable preflight failure. */
export class BuiltinPromptPackPostCommitError extends ServiceUnavailableError {
  readonly mutationCommitted = true;
  constructor(packId: string) {
    super("The prompt pack was imported, but follow-up export refresh could not be confirmed.", {
      reason: "PROMPT_PACK_IMPORT_POST_COMMIT",
      packId,
      mutationCommitted: true,
    });
  }
}
