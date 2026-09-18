import { expect, it } from "vitest";
import { publishIntegrationConnectionCommit } from "./integration-connection-commit-service.js";

it.each([undefined, "acknowledge", "publish", "discord", "signal"])(
  "preserves committed state and ordered follow-up when failure is %s", async (failure) => {
    const calls: string[] = [];
    const cause = new Error("follow-up unavailable");
    const step = async (name: string) => {
      calls.push(name);
      if (failure === name) throw cause;
    };
    const payload = { type: "integration_connection_updated", connectionId: "connection-1" };
    const result = publishIntegrationConnectionCommit({
      publishRealtime: async (type, source, value) => {
        expect([type, source, value]).toEqual(["system", "integrations", payload]);
        await step("publish");
      },
      syncDiscordRuntime: () => step("discord"),
      syncSignalInboundRuntime: () => step("signal"),
    }, payload, () => step("acknowledge"));
    const order = ["acknowledge", "publish", "discord", "signal"];
    if (failure) {
      await expect(result).rejects.toMatchObject({ mutationCommitted: true, cause });
      expect(calls).toEqual(order.slice(0, order.indexOf(failure) + 1));
    } else {
      await expect(result).resolves.toBeUndefined();
      expect(calls).toEqual(order);
    }
  },
);
