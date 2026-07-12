import { AsyncLocalStorage } from "node:async_hooks";

export interface RequestAttribution {
  correlationId?: string;
  traceId?: string;
  originSurface?: string;
  actorId?: string;
  deviceId?: string;
  grantId?: string;
  companionSessionId?: string;
}

const requestAttributionStorage = new AsyncLocalStorage<RequestAttribution>();

export function runWithRequestAttribution<T>(attribution: RequestAttribution, callback: () => T): T {
  return requestAttributionStorage.run(mergeAttribution(attribution), callback);
}

export function runWithIsolatedRequestAttribution<T>(attribution: RequestAttribution, callback: () => T): T {
  return requestAttributionStorage.run(normalizeAttribution(attribution), callback);
}

export function enterRequestAttribution(attribution: RequestAttribution): void {
  requestAttributionStorage.enterWith(mergeAttribution(attribution));
}

export function getRequestAttribution(): RequestAttribution | undefined {
  return requestAttributionStorage.getStore();
}

function mergeAttribution(next: RequestAttribution): RequestAttribution {
  const current = requestAttributionStorage.getStore() ?? {};
  return {
    ...current,
    ...normalizeAttribution(next),
  };
}

function normalizeAttribution(attribution: RequestAttribution): RequestAttribution {
  return Object.fromEntries(
    Object.entries(attribution).filter(([, value]) => typeof value === "string" && value.trim().length > 0),
  );
}
