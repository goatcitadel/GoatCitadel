import path from "node:path";
import { createInterface } from "node:readline/promises";
import { observeGoatComparisonDelivery } from "./lib/agent-comparison-goat-delivery.mjs";
import { readComparisonJson } from "./lib/agent-comparison-session.mjs";
import { assertNativeApprovalTerminal } from "./lib/agent-comparison-native-approval-console.mjs";

const [cellDirectory, settingsFile, ...extra] = process.argv.slice(2);
if (!cellDirectory || !settingsFile || extra.length)
  throw new Error("Usage: node agent-comparison-goat-delivery.mjs CELL OBSERVER_SETTINGS_JSON");
assertNativeApprovalTerminal();
const settings = await readComparisonJson(path.resolve(settingsFile));
if (Object.keys(settings).sort().join(",") !== "authorization,baseUrl,scheduleId")
  throw new Error("Observer settings contain baseUrl, scheduleId and authorization only.");
const controller = new AbortController();
const cancel = () => controller.abort(new Error("Operator cancelled native delivery observation."));
process.once("SIGINT", cancel);
process.once("SIGTERM", cancel);
try {
  const result = await observeGoatComparisonDelivery({
    ...settings,
    cellDirectory: path.resolve(cellDirectory),
    token: process.env.GOATCITADEL_COMPARISON_GATEWAY_TOKEN,
    signal: controller.signal,
    onReconnect: async ({ scheduleId, runId, deliveryId, signal }) => {
      const console = createInterface({ input: process.stdin, output: process.stdout });
      try {
        const response = await console.question(
          `Native reminder ${scheduleId} / ${runId} has acknowledged delivery ${deliveryId}.\nReconnect this test runtime/channel through its native controls, then type RECONNECTED. Do not create another reminder.\n> `,
          { signal },
        );
        if (response.trim() !== "RECONNECTED") throw new Error("Native reconnect was not confirmed.");
        return {
          kind: "operator_confirmed_reconnect",
          detail: "Operator typed RECONNECTED in the native delivery observer terminal.",
        };
      } finally {
        console.close();
      }
    },
  });
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
} finally {
  process.off("SIGINT", cancel);
  process.off("SIGTERM", cancel);
}
