import { createHash } from "node:crypto";
import { normalizeRemoteWorkerNativeFileReceipt, remoteWorkerNativeFileReceiptSha256, normalizeRemoteWorkerNativeFileTransferPage,
  normalizeRemoteWorkerRuntimeResultSubmission, nativeFileTransferExpectedPages, nativeFileTransferPageForDeclaration,
  readRemoteWorkerNativeFileContent, REMOTE_WORKER_NATIVE_FILE_PAGE_BYTES,
  type RemoteWorkerNativeFileReceipt, type RemoteWorkerNativeFileTransferPage } from "@goatcitadel/contracts";
import { snapshotRemoteWorkerCellCapacityAuthority, type AsyncStorage } from "@goatcitadel/storage";
import type { RemoteWorkerNativeArtifactStore } from "./remote-worker-native-artifact-store.js";
import type { RemoteWorkerNativeArtifactSettlement } from "./remote-worker-native-artifact-settlement.js";

type Storage = {
  remoteWorkerNativeFileTransfers: Pick<AsyncStorage["remoteWorkerNativeFileTransfers"],
    "beginForAssignment" | "appendPageForAssignment" | "readForAssignment" | "releasePagesForAssignment">;
  remoteWorkerNativeFileReceipts: Pick<AsyncStorage["remoteWorkerNativeFileReceipts"], "findForAssignment">;
};
type Authority = ReturnType<typeof snapshotRemoteWorkerCellCapacityAuthority> & { signal: AbortSignal };
type Lookup = Authority & { nonce: string; requestSha256: string };
const invalid = () => new Error("Native file transfer requires complete, unchanged, currently authorized records.");
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/** Bounded internal receiver. Raw pages remain temporary until the complete
 * native batch has a retained receipt and canonical verified artifact manifest.
 * This owner has no execution dispatcher and never retries a native launch. */
export class RemoteWorkerNativeFileTransferService {
  constructor(private readonly storage: Storage, private readonly artifacts: Pick<RemoteWorkerNativeArtifactStore, "stage">,
    private readonly settlement: Pick<RemoteWorkerNativeArtifactSettlement, "settle">) {}

  public async begin(input: Authority & { declaration: RemoteWorkerNativeFileReceipt }) {
    const authority = snapshotRemoteWorkerCellCapacityAuthority(input), declaration = normalizeRemoteWorkerNativeFileReceipt(input.declaration), signal = input.signal;
    signal.throwIfAborted();
    const saved = await this.storage.remoteWorkerNativeFileTransfers.beginForAssignment({ ...authority, declaration });
    signal.throwIfAborted();
    if (saved.transferSha256 !== remoteWorkerNativeFileReceiptSha256(declaration) ||
        remoteWorkerNativeFileReceiptSha256(saved.declaration) !== saved.transferSha256) throw invalid();
    return saved;
  }

  public async append(input: Authority & { page: RemoteWorkerNativeFileTransferPage }) {
    const authority = snapshotRemoteWorkerCellCapacityAuthority(input), page = normalizeRemoteWorkerNativeFileTransferPage(input.page), signal = input.signal;
    signal.throwIfAborted();
    const saved = await this.storage.remoteWorkerNativeFileTransfers.appendPageForAssignment({ ...authority, page });
    signal.throwIfAborted();
    const bytes = Buffer.from(page.bytesHex, "hex");
    try {
      if (saved.fileIndex !== page.fileIndex || saved.pageIndex !== page.pageIndex || saved.pageSha256 !== hash(bytes)) throw invalid();
    } finally { bytes.fill(0); }
    return saved;
  }

  public async complete(input: Lookup) {
    const authority = snapshotRemoteWorkerCellCapacityAuthority(input), signal = input.signal;
    const request = normalizeRemoteWorkerRuntimeResultSubmission({ kind: "runtime.result.lookup", nonce: input.nonce, requestSha256: input.requestSha256 });
    const lookup = { ...authority, nonce: request.nonce, requestSha256: request.requestSha256 };
    signal.throwIfAborted();
    const state = await this.storage.remoteWorkerNativeFileTransfers.readForAssignment(lookup);
    signal.throwIfAborted(); if (!state) return null;
    const declaration = normalizeRemoteWorkerNativeFileReceipt(state.transfer.declaration), transferSha256 = remoteWorkerNativeFileReceiptSha256(declaration);
    if (state.transfer.transferSha256 !== transferSha256 || declaration.disclosure.nonce !== request.nonce || declaration.disclosure.requestSha256 !== request.requestSha256 ||
        declaration.disclosure.registryWorkspaceId !== authority.registryWorkspaceId || declaration.disclosure.assignmentId !== authority.assignmentId ||
        declaration.disclosure.assignmentGeneration !== authority.assignmentGeneration) throw invalid();
    let retained = await this.storage.remoteWorkerNativeFileReceipts.findForAssignment(lookup);
    signal.throwIfAborted();
    if (!retained) {
      if (state.pages.length < nativeFileTransferExpectedPages(declaration)) return null;
      const files: { selection: typeof declaration.files[number]["selection"]; recordHex: string }[] = [];
      let cursor = 0;
      for (const [fileIndex, file] of declaration.files.entries()) {
        const record = Buffer.alloc(file.selection.logicalFileBytes + 200);
        try {
          for (let offset = 0, pageIndex = 0; offset < record.length; offset += REMOTE_WORKER_NATIVE_FILE_PAGE_BYTES, pageIndex++) {
            const saved = state.pages[cursor++]; if (!saved || saved.fileIndex !== fileIndex || saved.pageIndex !== pageIndex) throw invalid();
            const page = nativeFileTransferPageForDeclaration({ kind: "runtime.files.page", nonce: request.nonce, requestSha256: request.requestSha256, transferSha256,
              fileIndex, pageIndex, bytesHex: saved.bytesHex }, declaration);
            const bytes = Buffer.from(page.bytesHex, "hex");
            try { if (hash(bytes) !== saved.pageSha256) throw invalid(); bytes.copy(record, offset); } finally { bytes.fill(0); }
          }
          if (hash(record) !== file.recordSha256) throw invalid();
          const recordHex = record.toString("hex"), content = readRemoteWorkerNativeFileContent(recordHex, file.selection);
          if (content.recordSha256 !== file.recordSha256 || content.contentSha256 !== file.contentSha256) throw invalid();
          files.push({ selection: file.selection, recordHex });
        } finally { record.fill(0); }
      }
      if (cursor !== state.pages.length) throw invalid();
      signal.throwIfAborted();
      retained = await this.artifacts.stage({ ...authority, fileStaging: declaration.fileStaging, files, signal });
    }
    signal.throwIfAborted();
    if (retained.receiptSha256 !== transferSha256 || remoteWorkerNativeFileReceiptSha256(retained.receipt) !== transferSha256) throw invalid();
    const settled = await this.settlement.settle({ ...lookup, signal });
    signal.throwIfAborted();
    if (settled.receiptSha256 !== transferSha256) throw invalid();
    // Canonical storage independently requires the same retained receipt and
    // verified manifest before deleting any temporary raw pages.
    await this.storage.remoteWorkerNativeFileTransfers.releasePagesForAssignment(lookup);
    signal.throwIfAborted(); return settled;
  }
}
