import {
  canonicalJsonString,
  readChatTurnFeatureReferences,
  remoteWorkerCapabilityBindingForTurn,
  type DurableChatTurnExecutionPayloadAuthority,
} from "@goatcitadel/contracts";
import type { DatabaseClient } from "./db.js";
import { SessionMutationAdmissionRepository } from "./session-mutation-admission-repo.js";

/** Immutable join only. Every caller must independently retain its current
 * request/durable/worker claim before using this selected evidence. */
export function readRemoteWorkerAdmissionFeatureBinding(
  db: DatabaseClient,
  authority: DurableChatTurnExecutionPayloadAuthority,
) {
  const binding = remoteWorkerCapabilityBindingForTurn(authority);
  const reference = binding.admissionReference;
  if (!reference) throw new Error("Remote worker admission reference cannot use a historical profile.");
  const retained = new SessionMutationAdmissionRepository(db).findFeatureReferences(reference.scope);
  if (!retained || retained.referenceSha256 !== reference.featureReferenceSha256)
    throw new Error("Remote worker feature reference changed.");
  const references = readChatTurnFeatureReferences(retained.references);
  const placement = references.remotePlacement;
  if (
    !placement ||
    !("version" in placement) ||
    placement.version !== "chat.remote-placement.admission.v1" ||
    canonicalJsonString(placement.scope) !== canonicalJsonString(reference.scope) ||
    !references.providerRoute
  )
    throw new Error("Remote worker placement lacks exact selected feature evidence.");
  return { binding, reference, references, placement };
}
