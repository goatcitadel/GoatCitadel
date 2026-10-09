import { createHmac, randomBytes } from "node:crypto";
import type { ChannelProbeReport, ConnectorDiagnosticReport } from "@goatcitadel/contracts";
import { readBoundedResponseJson } from "./bounded-response-reader.js";
export async function runNextcloudTalkLiveChecks(input: { baseUrl: string; token: string; roomId: string; includeSandboxSend: boolean; fetcher: (url: string, init?: RequestInit) => Promise<Response> }): Promise<{ checks: ConnectorDiagnosticReport["checks"]; probe: ChannelProbeReport }> {
  const probe: ChannelProbeReport = { kind: "nextcloud_talk_bot", mode: "signed_api", checkedAt: new Date().toISOString(), steps: [] };
  if (!input.includeSandboxSend) { probe.steps.push({ key: "nextcloud_sandbox_send", label: "Signed room delivery", status: "skipped", disposition: "deferred", message: "Run the explicit guided test to verify signed room delivery." }); return { checks: [], probe }; }
  const message = "GoatCitadel channel setup verification.";
  const random = randomBytes(32).toString("hex");
  const signature = createHmac("sha256", input.token).update(random + message).digest("hex");
  try {
    const response = await input.fetcher(`${input.baseUrl.replace(/\/+$/, "")}/ocs/v2.php/apps/spreed/api/v1/bot/${encodeURIComponent(input.roomId)}/message`, { method: "POST", headers: { "Content-Type": "application/json", "OCS-APIRequest": "true", "X-Nextcloud-Talk-Bot-Random": random, "X-Nextcloud-Talk-Bot-Signature": signature }, body: JSON.stringify({ message }) });
    const payload = await readBoundedResponseJson(response, { maxBytes: 32 * 1024, timeoutMs: 5_000, label: "Nextcloud Talk setup probe" });
    const ocs = record(record(payload).ocs); const meta = record(ocs.meta); const data = record(ocs.data);
    if (!response.ok || (meta.status !== undefined && meta.status !== "ok")) probe.steps.push({ key: "nextcloud_sandbox_send", label: "Signed room delivery", status: "fail", disposition: "blocking", message: `Nextcloud Talk rejected the signed room send (HTTP ${response.status}). Verify bot registration, token and room membership.`, failureCategory: response.status === 401 || response.status === 403 ? "permission_mismatch" : "destination_mismatch" });
    else probe.steps.push({ key: "nextcloud_sandbox_send", label: "Signed room delivery", status: "pass", disposition: "blocking", ...(typeof data.id === "string" || typeof data.id === "number" ? { providerMessageId: String(data.id) } : {}), message: "The signed bot request was accepted by the selected Talk room. Confirm receipt manually." });
  } catch { probe.steps.push({ key: "nextcloud_sandbox_send", label: "Signed room delivery", status: "warn", disposition: "blocking", message: "Nextcloud Talk send outcome is uncertain. Inspect the room before running another send.", failureCategory: "platform_unavailable" }); }
  return { probe, checks: probe.steps.filter((step) => step.status !== "skipped").map((step) => ({ key: step.key, status: step.status === "pass" ? "pass" : step.status === "fail" ? "fail" : "warn", message: step.message })) };
}
function record(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
