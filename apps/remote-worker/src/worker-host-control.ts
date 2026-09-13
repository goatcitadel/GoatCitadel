import type { Readable } from "node:stream";
import { CONNECTED_WORKER_ENV, WORKER_HOST_CONTROL_PROTOCOL } from "./worker-environment.js";

/** The native host owns the pipe writer; EOF requests an ordinary durable shutdown. */
export function attachWorkerHostControl(
  env: Readonly<Record<string, string | undefined>>,
  input: Readable & { readonly isTTY?: boolean },
  stop: () => void,
): () => void {
  const protocol = env[CONNECTED_WORKER_ENV.hostControl];
  if (protocol === undefined) return () => {};
  if (protocol !== WORKER_HOST_CONTROL_PROTOCOL || input.isTTY)
    throw new Error("Connected-worker host control requires its bounded pipe protocol.");
  let stopped = false;
  const requestStop = () => {
    if (stopped) return;
    stopped = true;
    stop();
  };
  // Unexpected data or a broken read is also a stop request, never a command.
  input.on("data", requestStop);
  input.once("end", requestStop);
  input.once("close", requestStop);
  input.once("error", requestStop);
  if (input.destroyed || input.readableEnded) requestStop();
  else input.resume();
  return () => {
    input.off("data", requestStop);
    input.off("end", requestStop);
    input.off("close", requestStop);
    input.off("error", requestStop);
    input.pause();
  };
}
