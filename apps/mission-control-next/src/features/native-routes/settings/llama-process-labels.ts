import type { LlamaCppRuntimeOwnership } from "@goatcitadel/contracts";

/** Who started the llama.cpp process, in the words Settings shows for it. */
export const LLAMA_PROCESS_LABELS: Record<LlamaCppRuntimeOwnership, string> = {
  owned: "Started by GoatCitadel",
  external: "Started outside GoatCitadel; GoatCitadel only watches it",
  none: "Not running under GoatCitadel",
};
