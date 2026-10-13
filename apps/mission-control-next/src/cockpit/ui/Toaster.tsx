import { lazy, Suspense, useSyncExternalStore } from "react";
import { AreaErrorBoundary } from "./AreaErrorBoundary";
import { cockpitToastRuntimeRequested, subscribeCockpitToastRuntime } from "./toast-runtime";
const ToastRuntime = lazy(async () => ({ default: (await import("./ToasterRuntime")).CockpitToastRuntime }));
export function CockpitToaster() {
  const requested = useSyncExternalStore(subscribeCockpitToastRuntime, cockpitToastRuntimeRequested, () => false);
  return requested ? <AreaErrorBoundary label="Notifications" resetKey="toast-runtime"><Suspense fallback={null}><ToastRuntime /></Suspense></AreaErrorBoundary> : null;
}
