// The Gateway and worker share one encoder; the native protocol bytes and
// existing worker imports remain unchanged.
export { WINDOWS_RUNTIME_DISPATCH_MAX_BYTES, encodeWindowsRuntimeDispatch, bindWindowsRuntimeDispatch,
  type WindowsRuntimeDispatchBinding } from "@goatcitadel/contracts/remote-worker-runtime-node";
