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
const WORKS_ONCE_FINISHED = "This address works once you finish and the connection is on.";

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
  // A new setup has no connection yet, but it keeps its draft's id when it is finished, so the address is known now.
  const create = { lifecycleMode: "create" as const, draftId: "draft-1" };
  const draftAddress = (key: string, draftId = "draft-1") =>
    `https://<your public address>/api/v1/integrations/connections/${draftId}/${key}/webhook`;
  const worksOnceNotes = () =>
    [...container.querySelectorAll("p")].filter((item) => item.textContent === WORKS_ONCE_FINISHED);

  it("shows a new setup of a webhook channel its real address, built from the draft's id, and says it works once the setup is finished", async () => {
    await show(<ChannelFirstMessageWebhook definition={slackLike} draft={create} values={{}} />);
    expect(container.querySelector("code")?.textContent).toBe(draftAddress("slack"));
    expect(worksOnceNotes()).toHaveLength(1);
    expect(container.textContent).not.toContain("after you finish");
    expect(copyButton()?.textContent).toBe("Copy");
    expect(announces()).toBeNull();
  });

  it("copies the draft's address", async () => {
    const writeText = vi.fn(async () => undefined);
    withClipboard(writeText);
    await show(<ChannelFirstMessageWebhook definition={slackLike} draft={create} values={{}} />);

    await act(async () => copyButton()!.click());

    expect(writeText).toHaveBeenCalledExactlyOnceWith(draftAddress("slack"));
  });

  it("still gives no public address of its own: the placeholder and the note stand", async () => {
    await show(<ChannelFirstMessageWebhook definition={slackLike} draft={create} values={{}} />);
    expect(container.querySelector("code")?.textContent).toMatch(/^https:\/\/<your public address>\//u);
    expect([...container.querySelectorAll("p")].map((item) => item.textContent)).toContain(NOTE);
  });

  it("escapes the draft's id once", async () => {
    await show(
      <ChannelFirstMessageWebhook
        definition={slackLike}
        draft={{ lifecycleMode: "create", draftId: "d 1/2" }}
        values={{}}
      />,
    );
    expect(container.querySelector("code")?.textContent).toBe(draftAddress("slack", "d%201%2F2"));
    expect(container.querySelector("code")?.textContent).not.toContain("%25");
  });

  it("says nothing for a channel that doesn't receive on a webhook", async () => {
    await show(<ChannelFirstMessageWebhook definition={webhookDefinition()} draft={create} values={{}} />);
    expect(container.textContent).toBe("");
  });

  it("follows the condition for Telegram: poll says nothing, webhook shows the address", async () => {
    await show(<ChannelFirstMessageWebhook definition={telegramLike} draft={create} values={{}} />);
    expect(container.textContent).toBe("");
    await show(
      <ChannelFirstMessageWebhook definition={telegramLike} draft={create} values={{ receiveMode: "poll" }} />,
    );
    expect(container.textContent).toBe("");
    await show(
      <ChannelFirstMessageWebhook definition={telegramLike} draft={create} values={{ receiveMode: "webhook" }} />,
    );
    expect(container.querySelector("code")?.textContent).toBe(draftAddress("telegram"));
    expect(worksOnceNotes()).toHaveLength(1);
  });

  it("shows the address itself for a saved connection that is being changed, with no wait to mention", async () => {
    await show(
      <ChannelFirstMessageWebhook
        definition={slackLike}
        draft={{ lifecycleMode: "edit", draftId: "draft-9", connectionId: "conn-1" }}
        values={{}}
      />,
    );
    expect(container.querySelector("code")?.textContent).toBe(SLACK_ADDRESS);
    expect(worksOnceNotes()).toHaveLength(0);
    expect(container.textContent).not.toContain("once you finish");
  });

  it("builds a change's address from the saved connection's id, never from the change's own draft id", async () => {
    await show(
      <ChannelFirstMessageWebhook
        definition={slackLike}
        draft={{ lifecycleMode: "repair", draftId: "draft-9", connectionId: "conn-1" }}
        values={{}}
      />,
    );
    expect(container.querySelector("code")?.textContent).toBe(SLACK_ADDRESS);
    expect(container.textContent).not.toContain("draft-9");
  });

  it("shows no address for a change without a connection id, or whose condition fails", async () => {
    await show(
      <ChannelFirstMessageWebhook
        definition={slackLike}
        draft={{ lifecycleMode: "edit", draftId: "draft-9" }}
        values={{}}
      />,
    );
    expect(container.textContent).toBe("");
    await show(
      <ChannelFirstMessageWebhook
        definition={telegramLike}
        draft={{ lifecycleMode: "edit", draftId: "draft-9", connectionId: "conn-1" }}
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

  it("shows nothing for a Telegram connection set to poll or with no receive mode saved (this fixture defaults it to poll), and the address on a webhook", async () => {
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
