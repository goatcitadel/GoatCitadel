import { getGatewayApiBaseUrl } from "@goatcitadel/mission-control-shared/api/client-core";

export interface CitadelStructureAttempt {
  phase: "idle" | "checking" | "saving" | "uncertain";
  message?: string;
}
const idle: CitadelStructureAttempt = Object.freeze({ phase: "idle" });
const attempts = new Map<string, CitadelStructureAttempt>();
const listeners = new Set<() => void>();
export function citadelStructureKey(citadelId: string, installation = getGatewayApiBaseUrl()) {
  return JSON.stringify([installation, citadelId]);
}
export function citadelStructureAttempt(citadelId: string, installation = getGatewayApiBaseUrl()) {
  return attempts.get(citadelStructureKey(citadelId, installation)) ?? idle;
}
export function citadelStructureLocked(citadelId: string, installation = getGatewayApiBaseUrl()) {
  return citadelStructureAttempt(citadelId, installation).phase !== "idle";
}
export function setCitadelStructureAttempt(citadelId: string, attempt: CitadelStructureAttempt, installation = getGatewayApiBaseUrl()) {
  attempts.set(citadelStructureKey(citadelId, installation), attempt);
  for (const listener of listeners) listener();
}
export function subscribeCitadelStructureAttempts(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
export function __resetCitadelStructureAttemptsForTests() {
  attempts.clear();
  for (const listener of listeners) listener();
}
