// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ChannelSetupDefinition } from "@goatcitadel/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChannelConnectionWebhook, ChannelFirstMessageWebhook, ChannelWebhookAddress } from "./ChannelWebhookAddress";

const SLACK_PATH = "/api/v1/integrations/connections/conn-1/slack/webhook";
const SLACK_ADDRESS = `https://<your public address>${SLACK_PATH}`;
const NOTE =
  "GoatCitadel doesn't provide a public address. Put your own HTTPS address (a reverse proxy or tunnel) in front of GoatCitadel, then give the vendor this address.";
const AFTER_FINISH = "You get this address after you finish: Settings › Channels › this connection.";

let root: Root;
let container: HTMLDivElement;

async function show(element: React.ReactElement) {
  await act(async () => root.render(element));
}

const copyButton = () =>
  [...container.querySelectorAll<HTMLButtonElement>("button")].find((item) =>
    ["Copy", "Copied"].includes(item.textContent ?? ""),
  );
const announces = () => container.querySelector('[role="status"], [role="alert"], [aria-live]');

function withClipboard(writeText: (text: string) => Promise<void>) {
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
}

/** A definition that only says where its vendor posts; the model reads nothing else. */
function webhookDefinition(
  inboundWebhook?: NonNullable<ChannelSetupDefinition["wizard"]["inboundWebhook"]>,
  fieldDefault?: string,
): ChannelSetupDefinition {
  return {
    catalog: { catalogId: "channel.fixture", key: "fixture", label: "Fixture" },
    wizard: {
      steps: fieldDefault
        ? [
            {
              id: "values",
              kind: "field-collection",
              title: "Values",
              fields: [{ key: "receiveMode", label: "Receive mode", type: "select", defaultValue: fieldDefault }],
            },
          ]
        : [],
      ...(inboundWebhook ? { inboundWebhook } : {}),
    },
  } as unknown as ChannelSetupDefinition;
}

const slackLike = webhookDefinition({ pathTemplate: "/api/v1/integrations/connections/{connectionId}/slack/webhook" });
const telegramLike = webhookDefinition(
  {
    pathTemplate: "/api/v1/integrations/connections/{connectionId}/telegram/webhook",
    whenFieldEquals: { fieldKey: "receiveMode", value: "webhook" },
  },
  "poll",
);

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  Reflect.deleteProperty(navigator, "clipboard");
});

describe("ChannelWebhookAddress", () => {
  it("labels the address, shows it as a placeholder plus the path, and says GoatCitadel gives no public address", async () => {
    await show(<ChannelWebhookAddress path={SLACK_PATH} />);
    const section = container.querySelector('section[aria-label="Webhook address"]')!;
    expect(section).not.toBeNull();
    expect(section.textContent).toContain("Webhook address");
    const code = section.querySelectorAll("code");
    expect(code).toHaveLength(1);
    expect(code[0]!.textContent).toBe(SLACK_ADDRESS);
    expect(copyButton()?.textContent).toBe("Copy");
    expect([...section.querySelectorAll("p")].map((item) => item.textContent)).toContain(NOTE);
    expect(announces()).toBeNull();
  });

  it("names the address to a screen reader as the button's description", async () => {
    await show(<ChannelWebhookAddress path={SLACK_PATH} />);
    const code = container.querySelector("code")!;
    expect(code.id).not.toBe("");
    expect(copyButton()?.getAttribute("aria-describedby")).toBe(code.id);
  });

  it("copies the whole address and then reads Copied, without a live region", async () => {
    const writeText = vi.fn(async () => undefined);
    withClipboard(writeText);
    await show(<ChannelWebhookAddress path={SLACK_PATH} />);

    await act(async () => copyButton()!.click());

    expect(writeText).toHaveBeenCalledExactlyOnceWith(SLACK_ADDRESS);
    expect(copyButton()?.textContent).toBe("Copied");
    expect(announces()).toBeNull();
  });

  it("starts over when the address changes", async () => {
    withClipboard(vi.fn(async () => undefined));
    await show(<ChannelWebhookAddress path={SLACK_PATH} />);
    await act(async () => copyButton()!.click());
    expect(copyButton()?.textContent).toBe("Copied");

    await show(<ChannelWebhookAddress path="/api/v1/integrations/connections/conn-2/slack/webhook" />);

    expect(copyButton()?.textContent).toBe("Copy");
  });

  it("stays on Copy, and doesn't throw, when the browser has no clipboard", async () => {
    // happy-dom has its own clipboard on the prototype; shadow it the way an insecure page has none.
    Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true });
    await show(<ChannelWebhookAddress path={SLACK_PATH} />);

    await act(async () => copyButton()!.click());

    expect(copyButton()?.textContent).toBe("Copy");
    expect(container.querySelector("code")?.textContent).toBe(SLACK_ADDRESS);
  });

  it("stays on Copy, and doesn't throw, when the clipboard refuses the write", async () => {
    const writeText = vi.fn(async () => {
      throw new Error("denied");
    });
    withClipboard(writeText);
    await show(<ChannelWebhookAddress path={SLACK_PATH} />);

    await act(async () => copyButton()!.click());

    expect(writeText).toHaveBeenCalledOnce();
    expect(copyButton()?.textContent).toBe("Copy");
    expect(announces()).toBeNull();
  });
});

describe("ChannelFirstMessageWebhook", () => {
  const create = { lifecycleMode: "create" as const };

  it("tells a new setup of a webhook channel where the address will be", async () => {
    await show(<ChannelFirstMessageWebhook definition={slackLike} draft={create} values={{}} />);
    expect(container.textContent).toBe(AFTER_FINISH);
    expect(container.querySelector("code")).toBeNull();
    expect(announces()).toBeNull();
  });

  it("says nothing for a channel that doesn't receive on a webhook", async () => {
    await show(<ChannelFirstMessageWebhook definition={webhookDefinition()} draft={create} values={{}} />);
    expect(container.textContent).toBe("");
  });

  it("follows the condition for Telegram: poll says nothing, webhook says where it will be", async () => {
    await show(<ChannelFirstMessageWebhook definition={telegramLike} draft={create} values={{}} />);
    expect(container.textContent).toBe("");
    await show(
      <ChannelFirstMessageWebhook definition={telegramLike} draft={create} values={{ receiveMode: "poll" }} />,
    );
    expect(container.textContent).toBe("");
    await show(
      <ChannelFirstMessageWebhook definition={telegramLike} draft={create} values={{ receiveMode: "webhook" }} />,
    );
    expect(container.textContent).toBe(AFTER_FINISH);
  });

  it("shows the address itself for a saved connection that is being changed", async () => {
    await show(
      <ChannelFirstMessageWebhook
        definition={slackLike}
        draft={{ lifecycleMode: "edit", connectionId: "conn-1" }}
        values={{}}
      />,
    );
    expect(container.querySelector("code")?.textContent).toBe(SLACK_ADDRESS);
    expect(container.textContent).not.toContain("after you finish");
  });

  it("shows no address for a change without a connection id, or whose condition fails", async () => {
    await show(<ChannelFirstMessageWebhook definition={slackLike} draft={{ lifecycleMode: "edit" }} values={{}} />);
    expect(container.textContent).toBe("");
    await show(
      <ChannelFirstMessageWebhook
        definition={telegramLike}
        draft={{ lifecycleMode: "edit", connectionId: "conn-1" }}
        values={{ receiveMode: "poll" }}
      />,
    );
    expect(container.textContent).toBe("");
  });
});

describe("ChannelConnectionWebhook", () => {
  const connection = (catalogId: string, config: Record<string, unknown> = {}) => ({
    catalogId,
    connectionId: "conn-1",
    config,
  });
  const slack = { ...slackLike, catalog: { ...slackLike.catalog, catalogId: "channel.slack" } };
  const telegram = { ...telegramLike, catalog: { ...telegramLike.catalog, catalogId: "channel.telegram" } };

  it("shows the saved connection's address, found through its catalog entry", async () => {
    await show(<ChannelConnectionWebhook connection={connection("channel.slack")} definitions={[telegram, slack]} />);
    expect(container.querySelector("code")?.textContent).toBe(SLACK_ADDRESS);
  });

  it("shows nothing when Telegram is polling, and the address when it is on a webhook", async () => {
    const definitions = [slack, telegram];
    await show(
      <ChannelConnectionWebhook
        connection={connection("channel.telegram", { receiveMode: "poll" })}
        definitions={definitions}
      />,
    );
    expect(container.textContent).toBe("");
    await show(<ChannelConnectionWebhook connection={connection("channel.telegram")} definitions={definitions} />);
    expect(container.textContent).toBe("");
    await show(
      <ChannelConnectionWebhook
        connection={connection("channel.telegram", { receiveMode: "webhook" })}
        definitions={definitions}
      />,
    );
    expect(container.querySelector("code")?.textContent).toBe(
      "https://<your public address>/api/v1/integrations/connections/conn-1/telegram/webhook",
    );
  });

  it("shows nothing without a definition for the connection, or without any definitions", async () => {
    await show(<ChannelConnectionWebhook connection={connection("channel.carrier-pigeon")} definitions={[slack]} />);
    expect(container.textContent).toBe("");
    await show(<ChannelConnectionWebhook connection={connection("channel.slack")} definitions={undefined} />);
    expect(container.textContent).toBe("");
  });
});
