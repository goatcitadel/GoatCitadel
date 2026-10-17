import type { ChannelActivityInput, IntegrationConnection } from "@goatcitadel/contracts";
import { describe, expect, it, vi } from "vitest";
import { emitChannelActivityImpl } from "./integration-channel-activity.js";
import type { IntegrationChannelPort } from "./integration-channel-service.js";

function connection(key: string, config: Record<string, unknown>): IntegrationConnection {
  return {
    connectionId: `${key}-1`,
    kind: "channel",
    key,
    catalogId: `channel.${key}`,
    label: key,
    config,
  } as unknown as IntegrationConnection;
}

function deps(fetchImpl: (url: string, init?: RequestInit) => Promise<Response>) {
  const fetch = vi.fn(fetchImpl);
  const sendTyping = vi.fn(async () => ({
    channelKey: "discord",
    connectionId: "discord-1",
    target: "t",
    supported: true,
    status: "sent" as const,
  }));
  const port = {
    publishRealtime: vi.fn(async () => undefined),
    resolveConnectionSecret: (config: Record<string, unknown>, direct: string) =>
      typeof config[direct] === "string" ? (config[direct] as string) : undefined,
    isConnectionUrlAllowlisted: () => true,
    fetchWithDiagnosticsTimeout: fetch,
    discordRuntimeService: { sendTyping },
  } as unknown as IntegrationChannelPort;
  return { port, fetch, sendTyping };
}

const input: ChannelActivityInput = {
  connectionId: "x",
  target: "123456789012345678",
  messageId: "wamid.ABC",
  phase: "thinking",
} as ChannelActivityInput;

describe("WhatsApp activity typing", () => {
  const whatsapp = connection("whatsapp", { accessToken: "tok", phoneNumberId: "555" });

  it("reports typing as failed when the read receipt that carries it fails", async () => {
    const { port } = deps(
      async () => new Response(JSON.stringify({ error: { message: "Invalid wamid" } }), { status: 400 }),
    );
    const effects = await emitChannelActivityImpl(port, whatsapp, input, { activityReactions: [], typing: true });
    const typing = effects.find((effect) => effect.effect === "typing");
    const receipt = effects.find((effect) => effect.effect === "read_receipt");
    expect(receipt).toMatchObject({ status: "failed" });
    expect(typing).toMatchObject({ effect: "typing", status: "failed", supported: true });
    expect(typing?.detail).toMatch(/read receipt that carries the typing indicator did not send: .*Invalid wamid/);
    expect(effects.filter((effect) => effect.effect === "typing")).toHaveLength(1);
  });

  it("reports typing as sent only when the read receipt succeeds", async () => {
    const { port, fetch } = deps(async () => new Response(JSON.stringify({ success: true }), { status: 200 }));
    const effects = await emitChannelActivityImpl(port, whatsapp, input, { activityReactions: [], typing: true });
    expect(effects.find((effect) => effect.effect === "typing")).toMatchObject({ status: "sent" });
    expect(effects.find((effect) => effect.effect === "read_receipt")).toMatchObject({ status: "sent" });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toMatchObject({ typing_indicator: { type: "text" } });
  });

  it("emits no typing effect for a seen phase without typing", async () => {
    const { port } = deps(async () => new Response("{}", { status: 200 }));
    const effects = await emitChannelActivityImpl(
      port,
      whatsapp,
      { ...input, phase: "seen" },
      {
        activityReactions: [],
        typing: false,
      },
    );
    expect(effects.some((effect) => effect.effect === "typing")).toBe(false);
    expect(effects.find((effect) => effect.effect === "read_receipt")).toMatchObject({ status: "sent" });
  });
});

describe("Discord activity typing by runtime mode", () => {
  it("uses the gateway runtime in gateway mode", async () => {
    const { port, fetch, sendTyping } = deps(async () => new Response(null, { status: 204 }));
    const effects = await emitChannelActivityImpl(
      port,
      connection("discord", { runtimeMode: "gateway", botToken: "tok" }),
      input,
      { activityReactions: [], typing: true },
    );
    expect(sendTyping).toHaveBeenCalledTimes(1);
    expect(fetch).not.toHaveBeenCalled();
    expect(effects.find((effect) => effect.effect === "typing")).toMatchObject({ status: "sent" });
  });

  it("uses the REST typing endpoint in bridge mode", async () => {
    const { port, fetch, sendTyping } = deps(async () => new Response(null, { status: 204 }));
    const effects = await emitChannelActivityImpl(
      port,
      connection("discord", { runtimeMode: "bridge", botToken: "tok" }),
      input,
      { activityReactions: [], typing: true },
    );
    expect(sendTyping).not.toHaveBeenCalled();
    expect(fetch.mock.calls.map((call) => call[0])).toContain(
      "https://discord.com/api/v10/channels/123456789012345678/typing",
    );
    expect(effects.find((effect) => effect.effect === "typing")).toMatchObject({ status: "sent", supported: true });
  });
});
