import { exchangeRemoteWorkerRuntimeResult, type RemoteWorkerRuntimeResultExchangePort } from "./remote-worker-runtime-result-exchange.js";
import { type RemoteWorkerRuntimeResultSubmission, type RemoteWorkerRuntimeResultExchange } from "@goatcitadel/contracts";
import { type RemoteWorkerRuntimeAuthorizationSubmission, type RemoteWorkerRuntimeAuthorizationReceipt } from "@goatcitadel/contracts";
import { authorizeRemoteWorkerRuntime, type RemoteWorkerRuntimeAuthorizationPort } from "./remote-worker-runtime-authorization.js";
import { type RemoteWorkerRuntimeRequestPageSubmission, type RemoteWorkerRuntimeRequestPage } from "@goatcitadel/contracts";
import { readRemoteWorkerRuntimeRequestPage, type RemoteWorkerRuntimeRequestSelectionPort } from "./remote-worker-runtime-request-pages.js";
import { type RemoteWorkerRuntimeOutcomeSubmission, type RemoteWorkerRuntimeOutcomeExchange } from "@goatcitadel/contracts";
import { type RemoteWorkerRuntimeOutcomePort } from "./remote-worker-runtime-outcome.js";
import { type RemoteWorkerRuntimeOutputSubmission, type RemoteWorkerRuntimeOutputReceipt } from "@goatcitadel/contracts";
import { retainRemoteWorkerRuntimeOutput, type RemoteWorkerRuntimeOutputPort } from "./remote-worker-runtime-output.js";
import { exchangeRemoteWorkerRuntimeInstall, selectRemoteWorkerRuntimeInstall, type RemoteWorkerRuntimeInstallExchangePort } from "./remote-worker-runtime-install-exchange.js";
import type { RemoteWorkerRuntimeInstallSubmission, RemoteWorkerRuntimeInstallExchange, RemoteWorkerRuntimeInstallSelectionSubmission, RemoteWorkerRuntimeInstallSelection } from "@goatcitadel/contracts";
import { snapshotRemoteWorkerCellCapacityAuthority } from "@goatcitadel/storage";
import type { RemoteWorkerRuntimeCleanupSubmission, RemoteWorkerRuntimeCleanupExchange } from "@goatcitadel/contracts";
import { dispatchRemoteWorkerRuntimeRead, type RemoteWorkerRuntimeCleanupPort } from "./remote-worker-runtime-cleanup.js";
import type { RemoteWorkerInstallationSubmission, RemoteWorkerInstallationReply } from "@goatcitadel/contracts";
import type { RemoteWorkerInstallationRpc } from "./remote-worker-installation-rpc.js";
export interface NativeRuntimeSubmissionOwners {
  readonly installationSessions?: Pick<RemoteWorkerInstallationRpc, "exchange">;
  readonly runtimeCleanup?: RemoteWorkerRuntimeCleanupPort;
  readonly runtimeResults?: RemoteWorkerRuntimeResultExchangePort;
  readonly runtimeAuthorization?: RemoteWorkerRuntimeAuthorizationPort;
  readonly runtimeRequests?: RemoteWorkerRuntimeRequestSelectionPort;
  readonly runtimeOutcomes?: RemoteWorkerRuntimeOutcomePort;
  readonly runtimeOutputs?: RemoteWorkerRuntimeOutputPort;
  readonly runtimeInstalls?: RemoteWorkerRuntimeInstallExchangePort;
}
export type NativeRuntimeSubmission = RemoteWorkerInstallationSubmission | RemoteWorkerRuntimeCleanupSubmission | RemoteWorkerRuntimeResultSubmission | RemoteWorkerRuntimeAuthorizationSubmission | RemoteWorkerRuntimeRequestPageSubmission | RemoteWorkerRuntimeOutcomeSubmission | RemoteWorkerRuntimeOutputSubmission | RemoteWorkerRuntimeInstallSubmission | RemoteWorkerRuntimeInstallSelectionSubmission;
export type NativeRuntimeSubmissionResult =
  | Readonly<{ disposition: "installation_session"; installationSession: RemoteWorkerInstallationReply }>
  | Readonly<{ disposition: "runtime_cleanup"; runtimeCleanup: RemoteWorkerRuntimeCleanupExchange }>
  | Readonly<{ disposition: "runtime_install_selection"; runtimeInstallSelection: RemoteWorkerRuntimeInstallSelection }>
  | Readonly<{ disposition: "runtime_result"; runtimeResult: RemoteWorkerRuntimeResultExchange }>
  | Readonly<{ disposition: "runtime_authorization"; runtimeAuthorization: RemoteWorkerRuntimeAuthorizationReceipt }>
  | Readonly<{ disposition: "runtime_request_page"; runtimeRequestPage: RemoteWorkerRuntimeRequestPage }>
  | Readonly<{ disposition: "runtime_outcome"; runtimeOutcome: RemoteWorkerRuntimeOutcomeExchange }>
  | Readonly<{ disposition: "runtime_output"; runtimeOutput: RemoteWorkerRuntimeOutputReceipt }>
  | Readonly<{ disposition: "runtime_install"; runtimeInstall: RemoteWorkerRuntimeInstallExchange }>;
export function isNativeRuntimeSubmission(value: { kind: string }): value is NativeRuntimeSubmission {
  return ["runtime.install.session", "runtime.cleanup.read", "runtime.output.retain", "runtime.outcome.read", "runtime.request.page", "runtime.authorize", "runtime.result.page", "runtime.result.lookup", "runtime.install.retain", "runtime.install.lookup", "runtime.install.select"].includes(value.kind);
}
export async function dispatchNativeRuntimeSubmission(owners: NativeRuntimeSubmissionOwners,
  input: ReturnType<typeof snapshotRemoteWorkerCellCapacityAuthority> & { submission: NativeRuntimeSubmission; signal: AbortSignal }): Promise<NativeRuntimeSubmissionResult> {
  const authority = snapshotRemoteWorkerCellCapacityAuthority(input), submission = input.submission;
  input.signal.throwIfAborted();
  if (submission.kind === "runtime.install.session") {
    if (!owners.installationSessions) throw new Error("Installation session owner is unavailable.");
    return { disposition: "installation_session", installationSession: await owners.installationSessions.exchange({ ...authority, submission, signal: input.signal }) };
  }
  if (submission.kind === "runtime.cleanup.read" || submission.kind === "runtime.outcome.read") {
    return dispatchRemoteWorkerRuntimeRead(owners, { ...authority, submission, signal: input.signal });
  }
  if (submission.kind === "runtime.output.retain") {
    const runtimeOutput = await retainRemoteWorkerRuntimeOutput(owners.runtimeOutputs,
      { ...authority, submission, signal: input.signal });
    return { disposition: "runtime_output", runtimeOutput };
  }
  if (submission.kind === "runtime.request.page") {
    const runtimeRequestPage = await readRemoteWorkerRuntimeRequestPage(owners.runtimeRequests,
      { ...authority, submission, signal: input.signal });
    return { disposition: "runtime_request_page", runtimeRequestPage };
  }
  if (submission.kind === "runtime.authorize") {
    const runtimeAuthorization = await authorizeRemoteWorkerRuntime(owners.runtimeAuthorization,
      { ...authority, submission, signal: input.signal });
    return { disposition: "runtime_authorization", runtimeAuthorization };
  }
  if (submission.kind === "runtime.result.page" || submission.kind === "runtime.result.lookup") {
    const runtimeResult = await exchangeRemoteWorkerRuntimeResult(owners.runtimeResults,
      { ...authority, submission, signal: input.signal });
    return { disposition: "runtime_result", runtimeResult };
  }
  const installations = owners.runtimeInstalls;
  if (submission.kind === "runtime.install.select") return { disposition: "runtime_install_selection",
    runtimeInstallSelection: await selectRemoteWorkerRuntimeInstall(installations, { ...authority, submission, signal: input.signal }) };
  return { disposition: "runtime_install", runtimeInstall: await exchangeRemoteWorkerRuntimeInstall(installations,
    { ...authority, submission, signal: input.signal }) };
}
