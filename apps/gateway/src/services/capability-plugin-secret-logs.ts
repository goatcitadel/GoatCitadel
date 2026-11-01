import { createHash } from "node:crypto";
import { redactStructuredSecrets } from "@goatcitadel/contracts";
import type { Logger } from "@goatcitadel/gateway-core";

// The server log lines about a plugin's stored signing secrets. The logger redacts a key store reference wherever it
// appears, so each is logged as a stable fingerprint instead: enough to match it against the key store's references,
// and never the reference or the secret itself.

/** A stable, non-secret name for one key store reference: the first 16 hex characters of its SHA-256. */
export function keyStoreReferenceFingerprint(secretRef: string): string {
  return `sha256:${createHash("sha256").update(secretRef).digest("hex").slice(0, 16)}`;
}

/** The two lines, written to the given logger. */
export function pluginSecretLogs(log: Pick<Logger, "error">) {
  return {
    /** An uninstall that couldn't tell which stored secrets are in use kept them: logged by plugin and reference. */
    reportUndecidedSecrets(pluginId: string, secretRefs: readonly string[], error: unknown): void {
      log.error(
        "a plugin uninstall kept its stored signing secrets, as it couldn't tell whether a hook still uses them",
        {
          pluginId,
          keyStoreReferences: secretRefs.map(keyStoreReferenceFingerprint),
          err: diagnosticOf(error),
        },
      );
    },
    /** A signing secret that couldn't be deleted is logged by its reference, so it can be found and removed. */
    reportFailedSecretDelete(secretRef: string, error: unknown): void {
      log.error("a plugin hook's stored signing secret couldn't be deleted", {
        keyStoreReference: keyStoreReferenceFingerprint(secretRef),
        err: diagnosticOf(error),
      });
    },
  };
}

function diagnosticOf(error: unknown): unknown {
  const diagnostic = error instanceof Error ? { name: error.name, message: error.message } : { value: error };
  return redactStructuredSecrets(diagnostic).value;
}
