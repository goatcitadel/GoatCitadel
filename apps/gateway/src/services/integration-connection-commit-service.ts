import type { RealtimeEvent } from "@goatcitadel/contracts";

interface IntegrationConnectionCommitPort {
  publishRealtime(eventType: RealtimeEvent["eventType"], source: string, payload: Record<string, unknown>): Promise<unknown>;
  syncDiscordRuntime(): Promise<void>;
  syncSignalInboundRuntime(): Promise<void>;
}

/** Called only after canonical storage has committed the connection mutation. */
export async function publishIntegrationConnectionCommit(
  port: IntegrationConnectionCommitPort,
  payload: Record<string, unknown>,
  onCommitted?: () => Promise<void>,
): Promise<void> {
  try {
    await onCommitted?.();
    await port.publishRealtime("system", "integrations", payload);
    await port.syncDiscordRuntime();
    await port.syncSignalInboundRuntime();
  } catch (cause) {
    throw Object.assign(new Error("The connection change was saved, but runtime synchronization or acknowledgement failed. Review its current state before retrying.", { cause }), { mutationCommitted: true });
  }
}
