// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type {
  ChannelSetupDefinition,
  ChannelSetupDraft,
  IntegrationConnection,
  WhatsAppSetupCheckResult,
} from "@goatcitadel/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __resetCredentialInputsForTests } from "../../../../features/native-routes/settings/credential-input-owner";
import { ChannelTokenChange } from "./ChannelTokenChange";
import { WHATSAPP_CHECK_FAILED } from "./whatsapp-setup-model";

const api = vi.hoisted(() => ({
  fetchChannelSetupDefinitions: vi.fn(),
  fetchChannelSetupDrafts: vi.fn(),
  fetchChannelSetupDraft: vi.fn(),
  createChannelRotateSecretDraft: vi.fn(),
  submitChannelSetupDraftSecrets: vi.fn(),
  checkDiscordSetup: vi.fn(),
  checkSlackSetup: vi.fn(),
  checkWhatsAppSetup: vi.fn(),
  updateChannelSetupDraft: vi.fn(),
  fetchChannelRuntimeStatus: vi.fn(),
  fetchSettings: vi.fn(),
}));
vi.mock("@goatcitadel/mission-control-shared/api/client", () => api);

const turnOnApi = vi.hoisted(() => ({
  turnOnChannelDraft: vi.fn(),
  acknowledgeCleanupAndTurnOn: vi.fn(),
}));
vi.mock("./turn-on-channel", () => turnOnApi);

const ACCESS_TOKEN = "EAAG-NEW-SECRET-ACCESS-TOKEN";
const PHONE_NUMBER_ID = "106540352242922";
const CONNECTION_REVISION = "a".repeat(64);
const STORED = { accessToken: { configured: true, custody: "temporary" as const } };
const TEST_MESSAGE =
  "GoatCitadel sends a test message where your bot posts. WhatsApp delivers it only within 24 hours of that person's last message to your number, so have them message it first. WhatsApp can't remove it afterwards.";
const WORKS = "Token works for +1 555-078-3881 (Goat Shop).";

function connection(config: Record<string, unknown> = {}): IntegrationConnection {
  return {
    connectionId: "conn-1",
    revision: CONNECTION_REVISION,
    catalogId: "channel.whatsapp",
    kind: "channel",
    key: "whatsapp",
    label: "WhatsApp",
    enabled: true,
    status: "connected",
    config: {
      phoneNumberId: PHONE_NUMBER_ID,
      businessAccountId: "102290129340398",
      appId: "670843887433847",
      appSecret: "[REDACTED]",
      ...config,
    },
    createdAt: "2026-10-01T09:00:00.000Z",
    updatedAt: "2026-10-01T09:00:00.000Z",
  } as IntegrationConnection;
}

function rotateDraft(overrides: Partial<ChannelSetupDraft> = {}): ChannelSetupDraft {
  return {
    draftId: "rotate-1",
    revision: 1,
    catalogId: "channel.whatsapp",
    connectionId: "conn-1",
    connectionRevision: CONNECTION_REVISION,
    lifecycleMode: "rotate_secret",
    enabled: true,
    draft: { label: "kept", phoneNumberId: PHONE_NUMBER_ID },
    secretState: {},
    contentVersion: "content",
    adapterVersion: "adapter",
    validationVersion: "validation",
    testVersion: "test",
    createdAt: "2026-10-29T09:00:00.000Z",
    updatedAt: "2026-10-29T09:00:00.000Z",
    ...overrides,
  };
}

const whatsAppCheck = (overrides: Partial<WhatsAppSetupCheckResult> = {}): WhatsAppSetupCheckResult => ({
  number: { displayNumber: "+1 555-078-3881", verifiedName: "Goat Shop" },
  appSubscribed: true,
  ...overrides,
});

const definition = {
  catalog: { catalogId: "channel.whatsapp", key: "whatsapp", label: "WhatsApp" },
  wizard: {
    estimatedMinutes: 8,
    steps: [],
    requiredHosts: ["graph.facebook.com"],
    picker: { group: "quickest", order: 1 },
  },
} as unknown as ChannelSetupDefinition;

let root: Root;
let container: HTMLDivElement;
let client: QueryClient;

async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function mount(saved: IntegrationConnection) {
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <ChannelTokenChange connection={saved} workspaceId="default" />
      </QueryClientProvider>,
    );
  });
  await settle();
}

const steps = () => [...container.querySelectorAll<HTMLLIElement>("ol > li[data-state]")];
const states = () => steps().map((step) => step.getAttribute("data-state"));
const status = () => container.querySelector('[role="status"]')?.textContent;

function button(text: string): HTMLButtonElement | undefined {
  return [...container.querySelectorAll<HTMLButtonElement>("button")].find(
    (candidate) => candidate.textContent?.trim() === text,
  );
}

function link(text: string): HTMLAnchorElement | undefined {
  return [...container.querySelectorAll<HTMLAnchorElement>("a")].find((candidate) =>
    candidate.textContent?.includes(text),
  );
}

function field(label: string): HTMLInputElement | null {
  const found = [...container.querySelectorAll("label")].find((candidate) => candidate.textContent === label);
  return found ? container.querySelector<HTMLInputElement>(`#${CSS.escape(found.htmlFor)}`) : null;
}

async function type(label: string, value: string) {
  const input = field(label);
  if (!input) throw new Error(`No ${label} field`);
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function click(target: HTMLElement | undefined) {
  if (!target) throw new Error("Nothing to click");
  await act(async () => {
    target.click();
  });
  await settle();
}

async function checkToken(token = ACCESS_TOKEN) {
  await type("Access token", token);
  await click(button("Check token"));
}

/** What the gateway does: the token stored one version on, Meta asked about it, the draft read back. */
function arrange(
  result: WhatsAppSetupCheckResult = whatsAppCheck(),
  draftValues = { label: "kept", phoneNumberId: PHONE_NUMBER_ID },
) {
  api.createChannelRotateSecretDraft.mockResolvedValue(rotateDraft());
  api.submitChannelSetupDraftSecrets.mockImplementation(async (_id: string, input: { expectedRevision: number }) =>
    rotateDraft({ revision: input.expectedRevision + 1, secretState: STORED }),
  );
  api.checkWhatsAppSetup.mockResolvedValue(result);
  api.fetchChannelSetupDraft.mockResolvedValue(rotateDraft({ revision: 2, draft: draftValues, secretState: STORED }));
}

async function toChecked(saved = connection(), result?: WhatsAppSetupCheckResult) {
  arrange(result);
  await mount(saved);
  await checkToken();
}

beforeEach(() => {
  for (const fn of [...Object.values(api), ...Object.values(turnOnApi)]) fn.mockReset();
  api.fetchChannelSetupDefinitions.mockResolvedValue({ items: [definition] });
  api.fetchChannelSetupDrafts.mockResolvedValue({ items: [] });
  api.fetchChannelSetupDraft.mockResolvedValue(rotateDraft());
  api.fetchChannelRuntimeStatus.mockResolvedValue({});
  api.fetchSettings.mockResolvedValue({ revision: 1, networkAllowlist: ["graph.facebook.com"] });
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  client.clear();
  __resetCredentialInputsForTests();
});

describe("ChannelTokenChange for WhatsApp", () => {
  it("is titled, with two steps and a way back to the channel", async () => {
    await mount(connection());
    expect(container.querySelector("h1")?.textContent).toBe("Change WhatsApp's access token");
    expect(steps().map((step) => step.querySelector("h2")?.textContent)).toEqual([
      "1. Paste the new token",
      "2. Save the new token",
    ]);
    expect(states()).toEqual(["current", "locked"]);
    expect(new URL(link("Back to channel")!.getAttribute("href")!, "http://cockpit.invalid").pathname).toBe(
      "/chat/messaging/conn-1",
    );
  });

  it("asks for the access token alone, in a masked field, with a button that waits for it", async () => {
    await mount(connection());
    expect(field("Access token")?.getAttribute("type")).toBe("password");
    expect(field("Access token")?.getAttribute("autocomplete")).toBe("new-password");
    // The other four details come from the saved connection, so none of them is asked for again.
    for (const label of ["App secret", "App ID", "Phone number ID", "WhatsApp Business Account ID"]) {
      expect(field(label), label).toBeNull();
    }
    expect(button("Check token")?.disabled).toBe(true);
    await type("Access token", ACCESS_TOKEN);
    expect(button("Check token")?.disabled).toBe(false);
  });

  it("says where the token is made, and that it must be for the same app and number", async () => {
    await mount(connection());
    const help = steps()[0]!.textContent ?? "";
    expect(help).toContain("Business Settings › System users");
    expect(help).toContain("whatsapp_business_messaging");
    expect(help).toContain("same Meta app and phone number");
  });

  it("makes no draft by being visited", async () => {
    await mount(connection());
    expect(api.fetchChannelSetupDrafts).not.toHaveBeenCalled();
    expect(api.createChannelRotateSecretDraft).not.toHaveBeenCalled();
    expect(api.checkWhatsAppSetup).not.toHaveBeenCalled();
  });

  it("checks the token through a draft for changing the key, and names the number", async () => {
    await toChecked();
    expect(api.createChannelRotateSecretDraft).toHaveBeenCalledExactlyOnceWith("conn-1");
    expect(api.submitChannelSetupDraftSecrets).toHaveBeenCalledExactlyOnceWith("rotate-1", {
      expectedRevision: 1,
      values: { accessToken: ACCESS_TOKEN },
    });
    expect(api.checkWhatsAppSetup).toHaveBeenCalledExactlyOnceWith({
      draftId: "rotate-1",
      expectedRevision: 2,
      askMeta: true,
    });
    expect(steps()[0]!.textContent).toContain(WORKS);
    expect(status()).toBe(WORKS);
    expect(states()).toEqual(["done", "current"]);
    expect(field("Access token")).toBeNull();
    // The number is the same one, so nothing warns and nothing is written to the draft.
    expect(container.textContent).not.toContain("switches the bot");
    expect(api.updateChannelSetupDraft).not.toHaveBeenCalled();
  });

  it("never shows the token back", async () => {
    await toChecked();
    expect(container.innerHTML).not.toContain("SECRET");
    expect(container.innerHTML).not.toContain(ACCESS_TOKEN);
  });

  it("warns before saving when the draft follows a different number than the channel saved", async () => {
    await toChecked(connection({ phoneNumberId: "999999999999999" }));
    expect(steps()[1]!.querySelector('[data-tone="warning"]')?.textContent).toBe(
      "This token is for Goat Shop, not the bot this channel uses now. Saving it switches the bot people message.",
    );
    expect(button("Save key")?.disabled).toBe(false);
  });

  describe("when the token fails", () => {
    it("says one plain sentence, keeps the field to correct it, and shows no secret", async () => {
      arrange();
      api.checkWhatsAppSetup.mockRejectedValue(
        new Error(`GET /v23.0/${PHONE_NUMBER_ID} with Bearer ${ACCESS_TOKEN} failed`),
      );
      await mount(connection());
      await checkToken();

      expect(container.querySelectorAll('[data-tone="error"]')).toHaveLength(1);
      expect(steps()[0]!.querySelector('[data-tone="error"]')?.textContent).toBe(WHATSAPP_CHECK_FAILED);
      expect(status()).toBe(WHATSAPP_CHECK_FAILED);
      expect(container.textContent).not.toContain("SECRET");
      expect(states()).toEqual(["current", "locked"]);
      expect(field("Access token")?.getAttribute("type")).toBe("password");
    });

    it("says it when Meta gave no number", async () => {
      await toChecked(connection(), { appSubscribed: true });
      expect(steps()[0]!.querySelector('[data-tone="error"]')?.textContent).toBe(WHATSAPP_CHECK_FAILED);
      expect(states()).toEqual(["current", "locked"]);
    });
  });

  describe("saving the token", () => {
    const plan = { planId: "plan-1" };

    it("lists the test message as WhatsApp's: it cannot be removed", async () => {
      turnOnApi.turnOnChannelDraft.mockResolvedValue({ kind: "completed", plan });
      await toChecked();
      expect([...steps()[1]!.querySelectorAll("li")].map((item) => item.textContent)).toEqual([TEST_MESSAGE]);
      expect(steps()[1]!.textContent).not.toContain("removes it");
    });

    it("saves through the same turn-on call for the draft for changing the key", async () => {
      turnOnApi.turnOnChannelDraft.mockResolvedValue({ kind: "completed", plan });
      await toChecked();
      await click(button("Save key"));
      expect(turnOnApi.turnOnChannelDraft).toHaveBeenCalledExactlyOnceWith({
        workspaceId: "default",
        draftId: "rotate-1",
        catalogId: "channel.whatsapp",
        requiredHosts: ["graph.facebook.com"],
        // The host is allowed already, so the step listed none to add.
        shownHosts: [],
      });
    });

    it("says it is saved in WhatsApp's words and links back to WhatsApp's page", async () => {
      turnOnApi.turnOnChannelDraft.mockResolvedValue({ kind: "completed", plan });
      await toChecked();
      await click(button("Save key"));

      expect(states()).toEqual(["done", "done"]);
      expect(steps()[1]!.textContent).toContain("Saved. WhatsApp uses the new token now.");
      expect(status()).toBe("Saved. WhatsApp uses the new token now.");
      expect(new URL(link("Back to WhatsApp's page")!.getAttribute("href")!, "http://cockpit.invalid").pathname).toBe(
        "/chat/messaging/conn-1",
      );
      expect(container.textContent).not.toContain("Discord");
      expect(container.textContent).not.toContain("Slack");
    });

    it("says where to delete the test message when it could not be removed, and goes on without testing again", async () => {
      turnOnApi.turnOnChannelDraft.mockResolvedValue({ kind: "needs_cleanup_ack", evidenceId: "proof-1" });
      turnOnApi.acknowledgeCleanupAndTurnOn.mockResolvedValue({ kind: "completed", plan });
      await toChecked();
      await click(button("Save key"));
      expect(steps()[1]!.textContent).toContain(
        "GoatCitadel couldn't remove its test message. Delete it in WhatsApp if you like.",
      );
      await click(button("Continue"));
      expect(turnOnApi.turnOnChannelDraft).toHaveBeenCalledTimes(1);
      expect(turnOnApi.acknowledgeCleanupAndTurnOn).toHaveBeenCalledWith({
        workspaceId: "default",
        draftId: "rotate-1",
        catalogId: "channel.whatsapp",
        evidenceId: "proof-1",
      });
      expect(steps()[1]!.textContent).toContain("Saved. WhatsApp uses the new token now.");
    });
  });
});
