import { canonicalJsonString, normalizeRemoteWorkerNativeFileExportSelection, readRemoteWorkerNativeFileContent,
  normalizeRemoteWorkerNativeFileStaging, normalizeRemoteWorkerNativeFileDisclosure, remoteWorkerNativeFileStagingSha256,
  type RemoteWorkerNativeFileStaging, type RemoteWorkerNativeFileDisclosure,
  type RemoteWorkerNativeFileContent, type RemoteWorkerNativeFileExportSelection } from "@goatcitadel/contracts";
import { snapshotRemoteWorkerCellCapacityAuthority, type AsyncStorage, type RemoteWorkerRuntimeResultPageAssignmentInput } from "@goatcitadel/storage";

export interface RemoteWorkerNativeFileValidationPort {
  validate(input: Omit<RemoteWorkerRuntimeResultPageAssignmentInput, "submission"> & { selection: RemoteWorkerNativeFileExportSelection;
    recordHex: string; signal?: AbortSignal }, maximumBytes: number): Promise<RemoteWorkerNativeFileContent>;
  authorize(input: NativeDisclosureInput): Promise<NativeDisclosureResult>;
  validateDisclosed(input: NativeDisclosureInput & { recordHex: string }): Promise<NativeDisclosureResult & { content: RemoteWorkerNativeFileContent }>;
}
type NativeDisclosureInput = Omit<RemoteWorkerRuntimeResultPageAssignmentInput, "submission"> & {
  selection: RemoteWorkerNativeFileExportSelection; fileStaging: RemoteWorkerNativeFileStaging; signal?: AbortSignal;
};
type NativeDisclosureResult = Readonly<{ selection: RemoteWorkerNativeFileExportSelection; disclosure: RemoteWorkerNativeFileDisclosure }>;
function disclosureResult(value: NativeDisclosureResult, selection: RemoteWorkerNativeFileExportSelection, plan: RemoteWorkerNativeFileStaging): NativeDisclosureResult {
  const returned = normalizeRemoteWorkerNativeFileExportSelection(value.selection), disclosure = normalizeRemoteWorkerNativeFileDisclosure(value.disclosure);
  if (canonicalJsonString(returned) !== canonicalJsonString(selection) || disclosure.registryWorkspaceId !== selection.registryWorkspaceId ||
      disclosure.assignmentId !== selection.assignmentId || disclosure.assignmentGeneration !== selection.assignmentGeneration ||
      disclosure.nonce !== selection.nonce || disclosure.requestSha256 !== selection.requestSha256 ||
      disclosure.fileStagingSha256 !== remoteWorkerNativeFileStagingSha256(plan)) throw new Error("Native file disclosure differs from protected assignment evidence.");
  return Object.freeze({ selection, disclosure });
}
/** Internal protected-native delivery gate. This creates no upload, publication
 * receipt or worker RPC. The caller separately owns origin/disclosure authority. */
type NativeFileValidationStorage = {
  remoteWorkerRuntimeResults: Pick<AsyncStorage["remoteWorkerRuntimeResults"],
    "authorizeFileDisclosureForAssignment" | "verifyDisclosedFileContentForAssignment" | "verifyFileContentForAssignment">;
};
export function createRemoteWorkerNativeFileValidator(storage: NativeFileValidationStorage): RemoteWorkerNativeFileValidationPort {
  return { authorize: async input => {
    const signal = input.signal; signal?.throwIfAborted();
    const authority = snapshotRemoteWorkerCellCapacityAuthority(input), selection = normalizeRemoteWorkerNativeFileExportSelection(input.selection);
    const fileStaging = normalizeRemoteWorkerNativeFileStaging(input.fileStaging);
    const value = await storage.remoteWorkerRuntimeResults.authorizeFileDisclosureForAssignment({ ...authority, selection, fileStaging });
    signal?.throwIfAborted(); return disclosureResult(value, selection, fileStaging);
  }, validateDisclosed: async input => {
    const signal = input.signal; signal?.throwIfAborted();
    const authority = snapshotRemoteWorkerCellCapacityAuthority(input), selection = normalizeRemoteWorkerNativeFileExportSelection(input.selection);
    const fileStaging = normalizeRemoteWorkerNativeFileStaging(input.fileStaging), recordHex = input.recordHex;
    const content = readRemoteWorkerNativeFileContent(recordHex, selection);
    const value = await storage.remoteWorkerRuntimeResults.verifyDisclosedFileContentForAssignment({ ...authority, selection, fileStaging, recordHex });
    signal?.throwIfAborted();
    if (canonicalJsonString(value.content) !== canonicalJsonString(content)) throw new Error("Disclosed native content differs from its validated record.");
    return Object.freeze({ ...disclosureResult(value, selection, fileStaging), content });
  }, validate: async (input, maximumBytes) => {
    const signal = input.signal;
    signal?.throwIfAborted();
    const authority = snapshotRemoteWorkerCellCapacityAuthority(input);
    const selection = normalizeRemoteWorkerNativeFileExportSelection(input.selection), recordHex = input.recordHex;
    const expected = readRemoteWorkerNativeFileContent(recordHex, selection);
    const verified = await storage.remoteWorkerRuntimeResults.verifyFileContentForAssignment({ ...authority, selection, recordHex }, maximumBytes);
    signal?.throwIfAborted();
    if (canonicalJsonString(verified) !== canonicalJsonString(expected)) throw new Error("Native file validation differs from the protected delivery record.");
    return expected;
  } };
}
