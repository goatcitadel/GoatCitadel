import { isAuthoritativeModelUsageAccountingError } from "@goatcitadel/gateway-core";
import { observePromptSettlement } from "./prompt-settlement.js";

const UTILITY_MODEL_TIMEOUT = Symbol("utility-model-timeout");

type Settled<T> = { ok: true; value: T } | { ok: false; error: unknown };

/**
 * Bounds a utility provider call without orphaning its accounting settlement.
 * On timeout the provider signal is aborted, then the exact call is drained to
 * its terminal result before a fallback may be selected. An authoritative
 * accounting failure always wins over the ordinary timeout error.
 */
export async function runBoundedUtilityModelCall<T>(input: {
  start(signal: AbortSignal): Promise<T>;
  timeoutMs: number;
  timeoutMessage: string;
  parentSignal?: AbortSignal;
}): Promise<T> {
  const timeoutController = new AbortController();
  const signal = input.parentSignal
    ? AbortSignal.any([input.parentSignal, timeoutController.signal])
    : timeoutController.signal;
  const operation = Promise.resolve()
    .then(() => input.start(signal))
    .then<Settled<T>, Settled<T>>(
      (value) => ({ ok: true, value }),
      (error) => ({ ok: false, error }),
    );
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<typeof UTILITY_MODEL_TIMEOUT>((resolve) => {
    timer = setTimeout(() => resolve(UTILITY_MODEL_TIMEOUT), input.timeoutMs);
  });

  try {
    const first = await Promise.race([operation, timeout]);
    if (first === UTILITY_MODEL_TIMEOUT) {
      timeoutController.abort(new Error(input.timeoutMessage));
      const terminal = await observePromptSettlement(operation);
      if (
        terminal.status === "fulfilled" &&
        !terminal.value.ok &&
        isAuthoritativeModelUsageAccountingError(terminal.value.error)
      ) {
        throw terminal.value.error;
      }
      if (terminal.status === "pending") {
        void operation.then(() => undefined);
        const uncertain = new Error(`${input.timeoutMessage}; provider abort was not acknowledged`);
        uncertain.name = "ModelUsageDispatchUncertainError";
        throw uncertain;
      }
      throw new Error(input.timeoutMessage, {
        ...(terminal.status === "fulfilled" && !terminal.value.ok ? { cause: terminal.value.error } : {}),
      });
    }
    if (!first.ok) {
      throw first.error;
    }
    return first.value;
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}
