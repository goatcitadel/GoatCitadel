import { ModelUsageDispatchUncertainError, ModelUsageSettlementError,
  type ModelUsageAccountingService, type ModelUsageAttemptHandle } from "@goatcitadel/gateway-core";
import type { Dispatcher } from "undici";

type Reservation = Awaited<ReturnType<ModelUsageAccountingService["prepareDispatch"]>> | undefined;
interface DispatchDependencies {
  prepare(): Promise<Reservation>;
  authorize(reservation: Reservation): Promise<void>;
  retainNoDispatchEvidence(): boolean;
  rethrowNetworkError(error: unknown): void;
}

/** Track a single multipart attempt. Provider selection and credentials stay
 * with LlmService; uncertain accounting never authorizes another dispatch. */
export async function dispatchTrackedMultipartRequest(input: {
  target: { url: string; headers: RequestInit["headers"]; dispatcher?: Dispatcher };
  formData: FormData;
  timeoutMs: number;
  signal?: AbortSignal;
}, deps: DispatchDependencies): Promise<{ response: Response; usage?: ModelUsageAttemptHandle }> {
  const timeoutSignal = AbortSignal.timeout(input.timeoutMs);
  const dispatchAbort = new AbortController();
  const signal = input.signal
    ? AbortSignal.any([timeoutSignal, input.signal, dispatchAbort.signal])
    : AbortSignal.any([timeoutSignal, dispatchAbort.signal]);
  const requestInit: RequestInit & { dispatcher?: Dispatcher } = {
    method: "POST", headers: input.target.headers, body: input.formData,
    signal, redirect: "manual", dispatcher: input.target.dispatcher,
  };
  const reservation = await deps.prepare();
  const retainNoDispatchEvidence = deps.retainNoDispatchEvidence();
  let pending: Promise<Response>;
  try {
    await deps.authorize(reservation);
    signal.throwIfAborted();
    pending = fetch(input.target.url, requestInit);
    // Observe transport immediately while canonical acceptance is pending.
    void pending.catch(() => undefined);
  } catch (error) {
    await reservation?.abandon({ retainNoDispatchEvidence });
    deps.rethrowNetworkError(error);
    throw error;
  }
  let usage: ModelUsageAttemptHandle | undefined;
  try {
    usage = await reservation?.accept();
  } catch (cause) {
    dispatchAbort.abort();
    await reservation?.markDispatchUnknown();
    throw new ModelUsageDispatchUncertainError(
      "Provider dispatch outcome is uncertain; same-generation retry is blocked pending reconciliation",
      { eventId: reservation?.eventId, cause },
    );
  }
  try {
    return { response: await pending, usage };
  } catch (error) {
    if (error instanceof ModelUsageSettlementError) throw error;
    await usage?.fail(error);
    deps.rethrowNetworkError(error);
    throw error;
  }
}
