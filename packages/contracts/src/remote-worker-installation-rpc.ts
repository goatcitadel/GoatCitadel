/** Bounded messages over the existing protected assignment settlement route.
 * A session identifier is correlation only; current mTLS/PoP/lease authority
 * and controller signatures remain mandatory on the Gateway. */
export const REMOTE_WORKER_INSTALLATION_PAGE_BYTES = 32768;
export const REMOTE_WORKER_INSTALLATION_BUFFER_BYTES = 32 * 1024 * 1024;
export type RemoteWorkerInstallationAction = "prepare" | "material" | "capture" | "start" | "proof" | "verify" | "finish" | "joined" | "cancel";
export type RemoteWorkerInstallationEvent = "material" | "uploaded" | "challenge" | "ready" | "finish" | "complete";
export interface RemoteWorkerInstallationSubmission {
  readonly kind: "runtime.install.session";
  readonly sessionId: string;
  readonly sequence: number;
  readonly action: RemoteWorkerInstallationAction;
  readonly payloadHex: string;
}
export interface RemoteWorkerInstallationReply {
  readonly sessionId: string;
  readonly sequence: number;
  readonly event: RemoteWorkerInstallationEvent;
  readonly payloadHex: string;
}
const refused = () => new TypeError("Invalid bounded installation session message.");
function record(input: unknown, keys: string[]): Record<string, unknown> {
  if (!input || typeof input !== "object" || ![Object.prototype, null].includes(Object.getPrototypeOf(input) as object | null)) throw refused();
  const fields = Object.getOwnPropertyDescriptors(input);
  if (Reflect.ownKeys(fields).length !== keys.length || keys.some(key => !fields[key]?.enumerable || !("value" in fields[key]!))) throw refused();
  return Object.fromEntries(keys.map(key => [key, fields[key]!.value]));
}
function common(value: Record<string, unknown>) {
  if (typeof value.sessionId !== "string" || !/^[a-f0-9]{64}$/u.test(value.sessionId) || /^0+$/u.test(value.sessionId) ||
      !Number.isSafeInteger(value.sequence) || (value.sequence as number) < 1 || (value.sequence as number) > 300000 ||
      typeof value.payloadHex !== "string" || value.payloadHex.length > 4 * REMOTE_WORKER_INSTALLATION_PAGE_BYTES + 2048 ||
      value.payloadHex.length % 2 || !/^[a-f0-9]*$/u.test(value.payloadHex)) throw refused();
}
export function normalizeRemoteWorkerInstallationSubmission(input: unknown): RemoteWorkerInstallationSubmission {
  const value = record(input, ["kind", "sessionId", "sequence", "action", "payloadHex"]);
  common(value);
  if (value.kind !== "runtime.install.session" || !["prepare", "material", "capture", "start", "proof", "verify", "finish", "joined", "cancel"].includes(value.action as string)) throw refused();
  return Object.freeze(value) as unknown as RemoteWorkerInstallationSubmission;
}
export function normalizeRemoteWorkerInstallationReply(input: unknown): RemoteWorkerInstallationReply {
  const value = record(input, ["sessionId", "sequence", "event", "payloadHex"]);
  common(value);
  if (!["material", "uploaded", "challenge", "ready", "finish", "complete"].includes(value.event as string)) throw refused();
  return Object.freeze(value) as unknown as RemoteWorkerInstallationReply;
}
