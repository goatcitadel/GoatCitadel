import { normalizeRemoteWorkerNativeFileStaging } from "./remote-worker-native-file-staging.js";
import { createRemoteWorkerNativeFileExportSelection, type RemoteWorkerNativeFileExportSelection } from "./remote-worker-native-file-export.js";
import { normalizeRemoteWorkerRuntimeResultExpectation } from "./remote-worker-runtime-result.js";
import type { RemoteWorkerCellProvisioningExchange } from "./remote-worker-cell-provisioning.js";

/** Decode native path-to-identity metadata against an independently approved
 * plan and retained result. Authenticated native custody and current per-file
 * disclosure authorization are still required before accepting content. */
export function readRemoteWorkerNativeFileSelections(recordHex: unknown, approvedPlan: unknown, expectation: unknown,
  resultHex: unknown, history: RemoteWorkerCellProvisioningExchange): readonly RemoteWorkerNativeFileExportSelection[] {
  const invalid = () => new TypeError("Native file selections differ from the approved plan or retained result.");
  const plan = normalizeRemoteWorkerNativeFileStaging(approvedPlan), expected = normalizeRemoteWorkerRuntimeResultExpectation(expectation);
  if (typeof recordHex !== "string" || recordHex.length !== (108 + 24 * plan.paths.length) * 2 || !/^[a-f0-9]+$/u.test(recordHex) ||
      recordHex.slice(0, 16) !== "474346534c303031" || recordHex.slice(16, 80) !== expected.nonce ||
      recordHex.slice(80, 144) !== expected.requestSha256) throw invalid();
  const count = Number.parseInt(recordHex.slice(214, 216) + recordHex.slice(212, 214) + recordHex.slice(210, 212) + recordHex.slice(208, 210), 16);
  if (count !== plan.paths.length) throw invalid();
  const selections: RemoteWorkerNativeFileExportSelection[] = [], identities = new Set<string>();
  let total = 0;
  for (let index = 0; index < count; ++index) {
    const fileIdentityHex = recordHex.slice(216 + index * 48, 264 + index * 48);
    if (identities.has(fileIdentityHex)) throw invalid();
    const selection = createRemoteWorkerNativeFileExportSelection({ fileIdentityHex, logicalPath: plan.paths[index] },
      expected, resultHex, history, plan.maximumFileBytes);
    if (selection.resultSha256 !== recordHex.slice(144, 208)) throw invalid();
    total += selection.logicalFileBytes;
    if (total > plan.maximumTotalBytes) throw invalid();
    identities.add(fileIdentityHex); selections.push(selection);
  }
  return Object.freeze(selections);
}
