// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type {
  ChannelSetupDefinition,
  ChannelSetupDraft,
  WhatsAppSetupCheckResult,
  WhatsAppSetupCodeSender,
} from "@goatcitadel/contracts";
import { ApiRequestError } from "@goatcitadel/mission-control-shared/api/http-internal";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __resetCredentialInputsForTests } from "../../../../features/native-routes/settings/credential-input-owner";
import { CockpitNavigationProvider } from "../../../app/CockpitNavigationProvider";
import { SETUP_CODE_TTL_MS } from "./setup-code";
import {
  WHATSAPP_ADDRESS_CHECKED,
  WHATSAPP_ADDRESS_CHECKED_EARLIER,
  WHATSAPP_ADDRESS_NOT_CHECKED,
  WHATSAPP_ADDRESS_WAITING,
  WHATSAPP_CHECK_FAILED,
  WHATSAPP_CODE_EXPIRED,
  WHATSAPP_LISTEN_POLL_MS,
  WHATSAPP_META_APP_STEPS,
  WHATSAPP_NOT_SUBSCRIBED,
  WHATSAPP_POINT_META_TEXT,
  WHATSAPP_PUBLIC_ADDRESS_TEXT,
  WHATSAPP_SAY_HI_TEXT,
  WHATSAPP_VERIFY_TOKEN_HIDDEN,
  WHATSAPP_WAITING_FOR_HI,
  waMeLink,
  whatsAppDraftWithSender,
} from "./whatsapp-setup-model";
import { WhatsAppSetupPage } from "./WhatsAppSetupPage";

const api = vi.hoisted(() => ({
  fetchChannelSetupDrafts: vi.fn(),
  fetchChannelSetupDraft: vi.fn(),
  fetchChannelSetupDefinitions: vi.fn(),
  createChannelSetupDraft: vi.fn(),
  submitChannelSetupDraftSecrets: vi.fn(),
  checkWhatsAppSetup: vi.fn(),
  subscribeWhatsAppSetupApp: vi.fn(),
  updateChannelSetupDraft: vi.fn(),
  discardChannelSetupDraft: vi.fn(),
  fetchSettings: vi.fn(),
  patchSettings: vi.fn(),
  fetchChangePlan: vi.fn(),
}));
vi.mock("@goatcitadel/mission-control-shared/api/client", () => ({
  ...api,
  isApiRequestError: (value: unknown) => Boolean(value && typeof value === "object" && "status" in value),
}));

const turnOnApi = vi.hoisted(() => ({
  turnOnChannelDraft: vi.fn(),
  acknowledgeCleanupAndTurnOn: vi.fn(),
}));
vi.mock("./turn-on-channel", () => turnOnApi);

const ACCESS_TOKEN = "EAAB-SECRET-ACCESS-TOKEN";
const APP_SECRET = "SECRET-APP-SECRET-0123";
const IDS = { phoneNumberId: "106540352242922", businessAccountId: "102290129340398", appId: "1234567890123456" };
const NUMBER = { displayNumber: "+1 555-078-3881", verifiedName: "Goat Shop" };
const ADDRESS = "https://goat.example.com";
const CALLBACK = `${ADDRESS}/api/v1/integrations/connections/draft-1/whatsapp/webhook`;
const CHECKED_AT = "2026-10-29T10:00:00.000Z";
const SHEENA: WhatsAppSetupCodeSender = { actorId: "16505551234", displayName: "Sheena" };
const VERIFY_TOKEN = /^[A-HJ-NP-Za-km-z2-9]{32}$/;
const DONE = "WhatsApp is on.";

const TWO_SECRETS = {
  accessToken: { configured: true, custody: "temporary" as const },
  appSecret: { configured: true, custody: "temporary" as const },
};
const ALL_SECRETS = { ...TWO_SECRETS, webhookVerifyToken: { configured: true, custody: "temporary" as const } };

function draft(overrides: Partial<ChannelSetupDraft> = {}): ChannelSetupDraft {
  return {
    draftId: "draft-1",
    revision: 1,
    catalogId: "channel.whatsapp",
    lifecycleMode: "create",
    enabled: true,
    draft: {},
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

/** A setup made on this page whose five details are stored, with a verify token the page has lost. */
function savedSetup(values: Record<string, unknown> = {}) {
  return draft({ revision: 5, draft: { setupPage: "messaging", ...IDS, ...values }, secretState: ALL_SECRETS });
}

/** The catalogue as the gateway sends it: WhatsApp needs `graph.facebook.com` reached. */
function whatsappDefinition(): ChannelSetupDefinition {
  return {
    catalog: { catalogId: "channel.whatsapp", key: "whatsapp", label: "WhatsApp" },
    wizard: {
      estimatedMinutes: 25,
      steps: [],
      requiredHosts: ["graph.facebook.com"],
      picker: { group: "phone_apps", order: 0 },
    },
  } as unknown as ChannelSetupDefinition;
}

/** The public web address, the allowed hosts, what Meta says when asked, and what GoatCitadel has heard from Meta. */
let settings: { revision: number; networkAllowlist: string[]; publicWebAddress?: string };
let meta: WhatsAppSetupCheckResult;
let heard: { addressCheckedAt?: string; codeSender?: WhatsAppSetupCodeSender };

let root: Root;
let container: HTMLDivElement;
let client: QueryClient;

async function settle() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
}

/** Lets fake time pass, with every question that falls due asked and answered. */
async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
  await settle();
}

async function mount(props: { resumeDraftId?: string } = {}) {
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <CockpitNavigationProvider>
          <WhatsAppSetupPage workspaceId="default" {...props} />
        </CockpitNavigationProvider>
      </QueryClientProvider>,
    );
  });
  await settle();
}

async function unmount() {
  await act(async () => {
    root.render(<QueryClientProvider client={client} />);
  });
}

/** The public web address changed somewhere else, and the page reads the settings again. */
async function settingsChange(next: typeof settings) {
  settings = next;
  await act(async () => {
    await client.invalidateQueries({ queryKey: ["system", "settings-web-search"] });
  });
  await settle();
}

const steps = () => [...container.querySelectorAll<HTMLLIElement>("ol > li[data-state]")];
const states = () => steps().map((step) => step.getAttribute("data-state"));
/** What turning on lists, line by line. */
const changes = () => [...steps()[5]!.querySelectorAll("li")].map((item) => item.textContent);
const liveRegions = () => container.querySelectorAll('[role="status"], [role="alert"], [aria-live]');
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

async function click(target: HTMLElement | null | undefined) {
  if (!target) throw new Error("Nothing to click");
  await act(async () => {
    target.click();
  });
  await settle();
}

async function typeDetails(overrides: Partial<Record<string, string>> = {}) {
  const values = { ...IDS, appSecret: APP_SECRET, accessToken: ACCESS_TOKEN, ...overrides };
  await type("Phone number ID", values.phoneNumberId);
  await type("WhatsApp Business Account ID", values.businessAccountId);
  await type("App ID", values.appId);
  await type("App secret", values.appSecret);
  await type("Access token", values.accessToken);
}

async function checkDetails() {
  await typeDetails();
  await click(button("Check"));
}

/** The code the page last saved on the draft, which is the one it shows. */
const sentCode = () =>
  api.updateChannelSetupDraft.mock.calls
    .map(([, input]) => input.draft.setupCode as string | undefined)
    .filter(Boolean)
    .at(-1) as string;

/** The verify token the page stored, as the secret write carried it. */
const storedVerifyToken = () =>
  api.submitChannelSetupDraftSecrets.mock.calls.find(([, input]) => input.values.webhookVerifyToken)![1].values
    .webhookVerifyToken as string;

/** The five details have checked out and the page waits for Meta to check the address. */
async function mountAtAddress(result: Partial<WhatsAppSetupCheckResult> = {}) {
  meta = { number: NUMBER, appSubscribed: true, ...result };
  await mount();
  await checkDetails();
}

/** Meta checks the address at the next question. */
async function metaChecksAddress() {
  heard.addressCheckedAt = CHECKED_AT;
  await advance(WHATSAPP_LISTEN_POLL_MS);
  await settle();
}

/** Meta has checked the address, the app is subscribed, and the page waits for the code to arrive. */
async function mountAtCode() {
  await mountAtAddress();
  await metaChecksAddress();
}

/** Sheena has sent the code, and Turn on is open. */
async function mountAtHi() {
  await mountAtCode();
  heard.codeSender = SHEENA;
  await advance(WHATSAPP_LISTEN_POLL_MS);
  await settle();
}

function httpError(status: number, body?: unknown): ApiRequestError {
  return new ApiRequestError(`API error ${status}`, { kind: "http", method: "POST", path: "/x", status, body });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-29T10:00:00.000Z"));
  for (const fn of [...Object.values(api), ...Object.values(turnOnApi)]) fn.mockReset();
  settings = { revision: 1, networkAllowlist: [], publicWebAddress: ADDRESS };
  meta = { number: NUMBER, appSubscribed: true };
  heard = {};
  api.fetchSettings.mockImplementation(async () => ({ ...settings }));
  api.fetchChannelSetupDrafts.mockResolvedValue({ items: [] });
  api.fetchChannelSetupDraft.mockResolvedValue(draft());
  api.fetchChannelSetupDefinitions.mockResolvedValue({ items: [whatsappDefinition()] });
  api.discardChannelSetupDraft.mockResolvedValue({ draftId: "draft-1", deleted: true });
  // A new draft at version 1, marked as made here at 2, the secrets stored at 3, the three IDs saved at 4.
  api.createChannelSetupDraft.mockResolvedValue(draft({ revision: 1 }));
  api.submitChannelSetupDraftSecrets.mockImplementation(
    async (_id: string, input: { expectedRevision: number; values: Record<string, string> }) =>
      draft({
        revision: input.expectedRevision + 1,
        draft: { setupPage: "messaging" },
        secretState: input.values.webhookVerifyToken ? ALL_SECRETS : TWO_SECRETS,
      }),
  );
  api.updateChannelSetupDraft.mockImplementation(
    async (_id: string, input: { expectedRevision: number; draft: Record<string, unknown> }) =>
      draft({ revision: input.expectedRevision + 1, draft: input.draft, secretState: ALL_SECRETS }),
  );
  api.subscribeWhatsAppSetupApp.mockResolvedValue({ appSubscribed: true });
  api.checkWhatsAppSetup.mockImplementation(async (input: { askMeta?: true; setupCode?: string }) => {
    const address = heard.addressCheckedAt ? { addressCheckedAt: heard.addressCheckedAt } : {};
    if (input.askMeta) return { ...meta, ...address };
    return { ...address, ...(input.setupCode && heard.codeSender ? { codeSender: heard.codeSender } : {}) };
  });
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  // Unmounted while the fake timers are still installed, so what the page scheduled is cleared from them.
  act(() => root.unmount());
  vi.useRealTimers();
  container.remove();
  client.clear();
  __resetCredentialInputsForTests();
  Reflect.deleteProperty(navigator, "clipboard");
});

describe("WhatsAppSetupPage, the steps before Meta checks the address", () => {
  it("is titled and shows the six steps in order, each saying where it is done", async () => {
    await mount();
    expect(container.querySelector("h1")?.textContent).toBe("Set up WhatsApp");
    expect(steps().map((step) => step.querySelector("h2")?.textContent)).toEqual([
      "1. Give GoatCitadel a public web address",
      "2. Make your Meta app",
      "3. Paste your WhatsApp details",
      "4. Point Meta at GoatCitadel",
      "5. Say hi from your phone",
      "6. Turn on",
    ]);
    expect(steps().map((step) => step.querySelector("[data-place]")?.textContent)).toEqual([
      "On this page",
      "In Meta",
      "In Meta, then on this page",
      "In Meta",
      "On your phone",
      "On this page",
    ]);
  });

  it("asks for a public web address first and opens the rest once it is set", async () => {
    settings = { revision: 1, networkAllowlist: [] };
    await mount();
    // The Meta app can be made meanwhile, so that step is open; everything that needs the address waits.
    expect(states()).toEqual(["current", "current", "locked", "locked", "locked", "locked"]);
    expect(steps()[0]!.textContent).toContain(WHATSAPP_PUBLIC_ADDRESS_TEXT);
    expect(steps()[0]!.contains(field("Public web address"))).toBe(true);
    expect(steps()[2]!.textContent).toContain("Opens when your public web address is set.");
    expect(field("Phone number ID")).toBeNull();

    await settingsChange({ ...settings, publicWebAddress: ADDRESS });
    expect(states()).toEqual(["done", "current", "current", "locked", "locked", "locked"]);
    expect(steps()[0]!.textContent).toContain(ADDRESS);
    expect(field("Public web address")).toBeNull();
    expect(steps()[2]!.contains(field("Phone number ID"))).toBe(true);
  });

  it("shows a loading line, not a live region, until the settings are read", async () => {
    api.fetchSettings.mockReturnValue(new Promise(() => undefined));
    await mount();
    expect(steps()[0]!.textContent).toContain("Loading the public web address…");
    expect(liveRegions()).toHaveLength(1);
  });

  it("tells how to make the Meta app, and opens Meta's apps in a new tab", async () => {
    await mount();
    const second = steps()[1]!;
    expect([...second.querySelectorAll("li")].map((item) => item.textContent)).toEqual([...WHATSAPP_META_APP_STEPS]);
    const open = link("Open Meta for Developers");
    expect(open?.getAttribute("href")).toBe("https://developers.facebook.com/apps");
    expect(open?.getAttribute("target")).toBe("_blank");
    expect(open?.getAttribute("rel")).toContain("noopener");
    expect(second.contains(open ?? null)).toBe(true);
  });

  it("asks for the five details in their own fields, masks the two secrets and checks all with one button", async () => {
    await mount();
    const third = steps()[2]!;
    for (const label of ["Phone number ID", "WhatsApp Business Account ID", "App ID"]) {
      expect(field(label)?.getAttribute("type"), label).toBe("text");
      expect(field(label)?.getAttribute("inputmode"), label).toBe("numeric");
      expect(third.contains(field(label)), label).toBe(true);
    }
    for (const label of ["App secret", "Access token"]) {
      expect(field(label)?.getAttribute("type"), label).toBe("password");
      // Browsers ignore "off" on a password field and offer "Save password?" when the form goes away on success.
      expect(field(label)?.getAttribute("autocomplete"), label).toBe("new-password");
      expect(third.contains(field(label)), label).toBe(true);
    }
    expect(container.querySelectorAll("button[type=submit]")).toHaveLength(1);
    // The button waits for all five.
    expect(button("Check")?.disabled).toBe(true);
    await type("Phone number ID", IDS.phoneNumberId);
    await type("WhatsApp Business Account ID", IDS.businessAccountId);
    await type("App ID", IDS.appId);
    await type("App secret", APP_SECRET);
    expect(button("Check")?.disabled).toBe(true);
    await type("Access token", ACCESS_TOKEN);
    expect(button("Check")?.disabled).toBe(false);
  });

  it("checks the five details and names the number and the name Meta verified", async () => {
    await mount();
    await checkDetails();

    // Stored after the page marked the new draft as its own: secrets first (with a verify token), then the IDs.
    expect(api.updateChannelSetupDraft).toHaveBeenNthCalledWith(1, "draft-1", {
      expectedRevision: 1,
      draft: { setupPage: "messaging" },
    });
    expect(api.submitChannelSetupDraftSecrets).toHaveBeenCalledExactlyOnceWith("draft-1", {
      expectedRevision: 2,
      values: {
        accessToken: ACCESS_TOKEN,
        appSecret: APP_SECRET,
        webhookVerifyToken: expect.stringMatching(VERIFY_TOKEN),
      },
    });
    expect(api.updateChannelSetupDraft).toHaveBeenNthCalledWith(2, "draft-1", {
      expectedRevision: 3,
      draft: { setupPage: "messaging", ...IDS },
    });
    expect(api.checkWhatsAppSetup).toHaveBeenCalledWith({ draftId: "draft-1", expectedRevision: 4, askMeta: true });
    expect(steps()[2]!.textContent).toContain("Works. Your number is +1 555-078-3881 (Goat Shop).");
    expect(states()).toEqual(["done", "done", "done", "current", "locked", "locked"]);
    expect(status()).toBe(WHATSAPP_ADDRESS_WAITING);
    // What was typed goes once it is stored.
    expect(field("Access token")).toBeNull();
    expect(field("App secret")).toBeNull();
  });

  it("also checks the details when the operator presses Enter in a field", async () => {
    await mount();
    await typeDetails();
    const form = field("Access token")!.closest("form");
    expect(form?.contains(field("Phone number ID"))).toBe(true);
    await act(async () => {
      form!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    await settle();
    expect(api.checkWhatsAppSetup).toHaveBeenCalledTimes(1);
  });

  it("says an ID is digits only without asking Meta", async () => {
    await mount();
    await typeDetails({ phoneNumberId: "10654a352" });
    await click(button("Check"));
    expect(steps()[2]!.textContent).toContain("Phone number ID is digits only.");
    expect(status()).toBe("Phone number ID is digits only.");
    expect(api.createChannelSetupDraft).not.toHaveBeenCalled();
    expect(api.checkWhatsAppSetup).not.toHaveBeenCalled();
  });

  it("says in one plain sentence when Meta can't be asked, and keeps what was typed to fix", async () => {
    api.checkWhatsAppSetup.mockRejectedValue(new Error(`HTTP 401 Authorization: Bearer ${ACCESS_TOKEN}`));
    await mount();
    await checkDetails();

    const third = steps()[2]!;
    expect(third.textContent).toContain(WHATSAPP_CHECK_FAILED);
    expect(container.textContent).not.toContain("HTTP 401");
    expect(container.textContent).not.toContain("SECRET");
    expect(states()).toEqual(["done", "current", "current", "locked", "locked", "locked"]);
    // Still there to correct, and masked.
    expect(field("Access token")?.value).toBe(ACCESS_TOKEN);
    expect(field("App secret")?.value).toBe(APP_SECRET);
    expect(status()).toBe(WHATSAPP_CHECK_FAILED);
    // Shown once, in the step that has the fields.
    const callouts = container.querySelectorAll('[data-tone="error"]');
    expect(callouts).toHaveLength(1);
    expect(third.contains(callouts[0]!)).toBe(true);
  });

  it("says Meta's own plain sentence when the gateway gives one", async () => {
    api.checkWhatsAppSetup.mockRejectedValue(httpError(400, { error: "Meta didn't accept the access token." }));
    await mount();
    await checkDetails();
    expect(steps()[2]!.textContent).toContain("Meta didn't accept the access token.");
    expect(status()).toBe("Meta didn't accept the access token.");
  });

  it("shows the token's end as a calm note", async () => {
    await mountAtAddress({ tokenExpiresAt: "2026-10-29T13:00:00.000Z" });
    const third = steps()[2]!;
    expect(third.textContent).toContain(
      "This token stops working in 3 hours. Make a system user's token in Business Settings so WhatsApp keeps working, then change the key from WhatsApp's page once it's on.",
    );
    expect(third.querySelector("time")?.getAttribute("datetime")).toBe("2026-10-29T13:00:00.000Z");
    const note = third.querySelector("[data-tone]");
    expect(note?.getAttribute("data-tone")).not.toBe("error");
    // A note on the step, not an announcement.
    expect(note?.getAttribute("role")).toBeNull();
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(status()).toBe(WHATSAPP_ADDRESS_WAITING);
  });

  it("says nothing about the token's end when it never runs out", async () => {
    await mountAtAddress();
    expect(steps()[2]!.textContent).not.toContain("stops working");
    expect(steps()[2]!.querySelector("[data-tone]")).toBeNull();
  });
});

describe("WhatsAppSetupPage, pointing Meta at GoatCitadel", () => {
  it("shows the Callback URL built from the public web address and the draft", async () => {
    await mountAtAddress();
    const fourth = steps()[3]!;
    expect(fourth.getAttribute("data-state")).toBe("current");
    expect(fourth.textContent).toContain(WHATSAPP_POINT_META_TEXT);
    const callback = field("Callback URL");
    expect(fourth.contains(callback)).toBe(true);
    expect(callback?.value).toBe(CALLBACK);
    expect(callback?.readOnly).toBe(true);
    // The verify token is the one stored with the details, shown to copy and nowhere else.
    const token = field("Verify token");
    expect(token?.value).toBe(storedVerifyToken());
    expect(token?.value).toMatch(VERIFY_TOKEN);
    expect(token?.readOnly).toBe(true);
    expect(container.textContent).not.toContain(token!.value);
    expect(steps()[3]!.textContent).not.toContain(WHATSAPP_VERIFY_TOKEN_HIDDEN);
    expect(button("Make a new verify token")).toBeUndefined();
  });

  it("builds the Callback URL behind a path prefix of the public web address", async () => {
    settings = { ...settings, publicWebAddress: `${ADDRESS}/goat` };
    await mountAtAddress();
    expect(field("Callback URL")?.value).toBe(
      `${ADDRESS}/goat/api/v1/integrations/connections/draft-1/whatsapp/webhook`,
    );
  });

  it("copies the Callback URL and the verify token, each from its own button", async () => {
    const writeText = vi.fn(async (_text: string) => undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    await mountAtAddress();
    const copyUrl = () => container.querySelector<HTMLButtonElement>('button[aria-label$="Callback URL"]');
    const copyToken = () => container.querySelector<HTMLButtonElement>('button[aria-label$="Verify token"]');
    expect(copyUrl()?.textContent).toBe("Copy");

    await click(copyUrl());
    expect(writeText).toHaveBeenCalledExactlyOnceWith(CALLBACK);
    expect(copyUrl()?.textContent).toBe("Copied");
    expect(copyToken()?.textContent).toBe("Copy");

    await click(copyToken());
    expect(writeText).toHaveBeenLastCalledWith(storedVerifyToken());
  });

  it("stays on Copy when the browser has no clipboard", async () => {
    Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true });
    await mountAtAddress();
    await click(container.querySelector<HTMLButtonElement>('button[aria-label$="Callback URL"]'));
    expect(container.querySelector('button[aria-label$="Callback URL"]')?.textContent).toBe("Copy");
    expect(field("Callback URL")?.value).toBe(CALLBACK);
  });

  it("waits for Meta, and says so when it has checked", async () => {
    await mountAtAddress();
    expect(steps()[3]!.textContent).toContain(WHATSAPP_ADDRESS_WAITING);
    expect(status()).toBe(WHATSAPP_ADDRESS_WAITING);

    await metaChecksAddress();
    // The app is subscribed, so the step is done and the next one has asked for its code.
    expect(states()).toEqual(["done", "done", "done", "done", "current", "locked"]);
    // What stays on screen carries no time, because it stays.
    expect(steps()[3]!.textContent).toContain(WHATSAPP_ADDRESS_CHECKED_EARLIER);
    expect(steps()[3]!.textContent).not.toContain("just now");
    expect(steps()[3]!.textContent).not.toContain(WHATSAPP_ADDRESS_WAITING);
  });

  it("announces a check it saw arrive as just now, and shows it with no time on screen", async () => {
    await mountAtAddress({ appSubscribed: false });
    expect(status()).toBe(WHATSAPP_ADDRESS_WAITING);

    await metaChecksAddress();
    // The app still has to be subscribed, so nothing else has taken the status line yet.
    expect(status()).toBe(WHATSAPP_ADDRESS_CHECKED);
    expect(WHATSAPP_ADDRESS_CHECKED).toBe("Meta checked your address just now.");
    expect(steps()[3]!.textContent).toContain(WHATSAPP_ADDRESS_CHECKED_EARLIER);
    expect(steps()[3]!.textContent).not.toContain("just now");
    expect(container.querySelectorAll('[role="status"]')).toHaveLength(1);
  });

  it("offers to subscribe the app only when Meta says it isn't", async () => {
    await mountAtAddress({ appSubscribed: false });
    const fourth = steps()[3]!;
    const subscribe = button("Let this app receive your number's messages");
    expect(fourth.contains(subscribe ?? null)).toBe(true);
    expect(fourth.textContent).toContain(WHATSAPP_NOT_SUBSCRIBED);

    await click(subscribe);
    expect(api.subscribeWhatsAppSetupApp).toHaveBeenCalledExactlyOnceWith({ draftId: "draft-1", expectedRevision: 4 });
    expect(button("Let this app receive your number's messages")).toBeUndefined();
    expect(steps()[3]!.textContent).not.toContain(WHATSAPP_NOT_SUBSCRIBED);
  });

  it("offers nothing to subscribe when the app already is", async () => {
    await mountAtAddress({ appSubscribed: true });
    expect(button("Let this app receive your number's messages")).toBeUndefined();
    expect(steps()[3]!.textContent).not.toContain(WHATSAPP_NOT_SUBSCRIBED);
    expect(api.subscribeWhatsAppSetupApp).not.toHaveBeenCalled();
  });

  it("keeps the step open after Meta's check until the app is subscribed, then goes on", async () => {
    await mountAtAddress({ appSubscribed: false });
    await metaChecksAddress();
    expect(states()).toEqual(["done", "done", "done", "current", "locked", "locked"]);
    expect(steps()[3]!.textContent).toContain(WHATSAPP_ADDRESS_CHECKED_EARLIER);
    // No code is asked for before the step is done.
    expect(api.updateChannelSetupDraft.mock.calls.some(([, input]) => input.draft.setupCode)).toBe(false);

    await click(button("Let this app receive your number's messages"));
    expect(states()).toEqual(["done", "done", "done", "done", "current", "locked"]);
    expect(sentCode()).toMatch(/^[A-Za-z0-9]{10}$/);
  });

  it("says why the app couldn't be subscribed, below the steps", async () => {
    api.subscribeWhatsAppSetupApp.mockRejectedValue(new Error(`HTTP 500 Bearer ${ACCESS_TOKEN}`));
    await mountAtAddress({ appSubscribed: false });
    await click(button("Let this app receive your number's messages"));
    expect(container.textContent).toContain(WHATSAPP_CHECK_FAILED);
    expect(container.textContent).not.toContain("HTTP 500");
    expect(container.textContent).not.toContain("SECRET");
    expect(status()).toBe(WHATSAPP_CHECK_FAILED);
    // Heard and seen: once, outside the steps, because the step with the fields is done.
    const callouts = container.querySelectorAll('[data-tone="error"]');
    expect(callouts).toHaveLength(1);
    expect(steps().some((step) => step.contains(callouts[0]!))).toBe(false);
  });

  it("says Meta hasn't checked the address after ten minutes, and checks again when asked", async () => {
    await mountAtAddress();
    await advance(SETUP_CODE_TTL_MS);

    const fourth = steps()[3]!;
    expect(fourth.textContent).toContain(WHATSAPP_ADDRESS_NOT_CHECKED);
    expect(fourth.textContent).not.toContain(WHATSAPP_ADDRESS_WAITING);
    expect(status()).toBe(WHATSAPP_ADDRESS_NOT_CHECKED);
    // Said in the step, with its button, and not a second time below the steps.
    expect(steps().filter((step) => step.textContent?.includes(WHATSAPP_ADDRESS_NOT_CHECKED))).toHaveLength(1);
    expect(container.querySelector('[data-tone="error"]')).toBeNull();

    await click(button("Check again"));
    expect(steps()[3]!.textContent).toContain(WHATSAPP_ADDRESS_WAITING);
    expect(steps()[3]!.textContent).not.toContain(WHATSAPP_ADDRESS_NOT_CHECKED);
    expect(button("Check again")).toBeUndefined();

    await metaChecksAddress();
    expect(steps()[3]!.getAttribute("data-state")).toBe("done");
  });

  it("offers a new verify token when the page no longer holds the one it made", async () => {
    api.fetchChannelSetupDrafts.mockResolvedValue({ items: [savedSetup()] });
    await mount();

    const fourth = steps()[3]!;
    expect(api.checkWhatsAppSetup).toHaveBeenCalledWith({ draftId: "draft-1", expectedRevision: 5, askMeta: true });
    expect(field("Verify token")).toBeNull();
    expect(fourth.textContent).toContain(WHATSAPP_VERIFY_TOKEN_HIDDEN);
    expect(field("Callback URL")?.value).toBe(CALLBACK);

    await click(button("Make a new verify token"));
    expect(api.submitChannelSetupDraftSecrets).toHaveBeenCalledExactlyOnceWith("draft-1", {
      expectedRevision: 5,
      values: { webhookVerifyToken: expect.stringMatching(VERIFY_TOKEN) },
    });
    expect(field("Verify token")?.value).toBe(storedVerifyToken());
    expect(button("Make a new verify token")).toBeUndefined();
    expect(container.textContent).not.toContain(WHATSAPP_VERIFY_TOKEN_HIDDEN);
  });
});

describe("WhatsAppSetupPage, saying hi", () => {
  it("shows the code, the QR code and the wa.me link", async () => {
    await mountAtCode();
    const code = sentCode();
    expect(code).toMatch(/^[A-Za-z0-9]{10}$/);
    const fifth = steps()[4]!;
    expect(fifth.getAttribute("data-state")).toBe("current");
    expect(fifth.textContent).toContain(WHATSAPP_SAY_HI_TEXT);
    expect(fifth.textContent).toContain(code);
    expect(fifth.textContent).toContain(WHATSAPP_WAITING_FOR_HI);
    expect(status()).toBe(WHATSAPP_WAITING_FOR_HI);

    const open = link("Open WhatsApp");
    expect(open?.getAttribute("href")).toBe(`https://wa.me/15550783881?text=${code}`);
    expect(open?.getAttribute("href")).toBe(waMeLink(NUMBER.displayNumber, code));
    expect(open?.getAttribute("target")).toBe("_blank");
    expect(open?.getAttribute("rel")).toContain("noopener");
    expect(fifth.contains(open ?? null)).toBe(true);
    const qr = fifth.querySelector('svg[role="img"]');
    expect(qr?.getAttribute("aria-label")).toBe("QR code that opens WhatsApp with your message");
    expect(qr?.querySelector("path")?.getAttribute("d")).toBeTruthy();
  });

  it("asks for the code once however often the page draws, and listens every 6 seconds", async () => {
    await mountAtCode();
    // The mark, the secrets, the IDs, Meta's check, then the code.
    expect(api.updateChannelSetupDraft.mock.calls.filter(([, input]) => input.draft.setupCode)).toHaveLength(1);
    api.checkWhatsAppSetup.mockClear();
    await advance(WHATSAPP_LISTEN_POLL_MS * 3);
    expect(api.checkWhatsAppSetup).toHaveBeenCalledTimes(3);
    for (const [input] of api.checkWhatsAppSetup.mock.calls) {
      expect(input).toEqual({ draftId: "draft-1", expectedRevision: 6, setupCode: sentCode() });
    }
  });

  it("offers a new code once the first has run out, and listens for that one", async () => {
    await mountAtCode();
    const first = sentCode();
    await advance(SETUP_CODE_TTL_MS);

    const fifth = steps()[4]!;
    expect(fifth.textContent).toContain(WHATSAPP_CODE_EXPIRED);
    expect(fifth.textContent).not.toContain(first);
    expect(status()).toBe(WHATSAPP_CODE_EXPIRED);
    expect(states()).toEqual(["done", "done", "done", "done", "current", "locked"]);

    api.checkWhatsAppSetup.mockClear();
    await click(button("New code"));
    const second = sentCode();
    expect(second).not.toBe(first);
    expect(steps()[4]!.textContent).toContain(second);
    expect(steps()[4]!.textContent).not.toContain(WHATSAPP_CODE_EXPIRED);
    await advance(WHATSAPP_LISTEN_POLL_MS);
    expect(api.checkWhatsAppSetup).toHaveBeenCalledWith(expect.objectContaining({ setupCode: second }));
  });

  it("offers a button, and says why, when the code could not be saved; it does not try again by itself", async () => {
    await mountAtAddress();
    const write = api.updateChannelSetupDraft.getMockImplementation()!;
    api.updateChannelSetupDraft.mockImplementation(async (id: string, input: { draft: Record<string, unknown> }) => {
      if (input.draft.setupCode) throw new Error("This changed somewhere else.");
      return write(id, input);
    });
    await metaChecksAddress();

    const fifth = steps()[4]!;
    expect(fifth.getAttribute("data-state")).toBe("current");
    expect(fifth.textContent).toContain("New code");
    expect(status()).toBe("This changed somewhere else.");
    // Heard and seen: once, outside the steps, because the step with the fields is done.
    const callouts = container.querySelectorAll('[data-tone="error"]');
    expect(callouts).toHaveLength(1);
    expect(steps().some((step) => step.contains(callouts[0]!))).toBe(false);
    expect(api.checkWhatsAppSetup).not.toHaveBeenCalledWith(expect.objectContaining({ setupCode: expect.anything() }));

    api.updateChannelSetupDraft.mockClear();
    await advance(WHATSAPP_LISTEN_POLL_MS * 3);
    expect(api.updateChannelSetupDraft).not.toHaveBeenCalled();

    api.updateChannelSetupDraft.mockImplementation(write);
    await click(button("New code"));
    expect(steps()[4]!.textContent).toContain(sentCode());
    expect(container.querySelector('[data-tone="error"]')).toBeNull();
  });

  it("says who sent the code and that only they can message the bot", async () => {
    await mountAtHi();
    const fifth = steps()[4]!;
    expect(fifth.getAttribute("data-state")).toBe("done");
    expect(fifth.textContent).toContain("Sheena can message your bot.");
    expect(fifth.textContent).not.toContain(WHATSAPP_WAITING_FOR_HI);
    expect(status()).toBe("Sheena can message your bot.");
    const saved = api.updateChannelSetupDraft.mock.calls.find(([, input]) => input.draft.allowedSenders)![1];
    expect(saved.draft).toMatchObject({
      allowedSenders: ["16505551234"],
      ownerActorIds: ["16505551234"],
      inboundAccessMode: "allowlist",
      defaultTarget: "16505551234",
    });
    expect(states()).toEqual(["done", "done", "done", "done", "done", "current"]);
  });

  it("names the person by their number when WhatsApp gave no name", async () => {
    await mountAtCode();
    heard.codeSender = { actorId: "16505551234" };
    await advance(WHATSAPP_LISTEN_POLL_MS);
    expect(steps()[4]!.textContent).toContain("+16505551234 can message your bot.");
    expect(changes()[0]).toBe("Only +16505551234 can message your WhatsApp bot.");
  });
});

describe("WhatsAppSetupPage, turning it on", () => {
  const plan = { planId: "plan-1" };

  it("lists what Turn on changes, including graph.facebook.com when it is missing", async () => {
    await mountAtHi();
    expect(steps()[5]!.getAttribute("data-state")).toBe("current");
    expect(changes()).toEqual([
      "Only Sheena can message your WhatsApp bot.",
      "Replies go to Sheena on WhatsApp.",
      "GoatCitadel sends Sheena a test message. WhatsApp can't remove it afterwards.",
      "graph.facebook.com is added to the hosts GoatCitadel may reach",
    ]);
    expect(button("Turn on WhatsApp")?.disabled).toBe(false);
  });

  it("names no host when Meta's is already allowed", async () => {
    settings = { ...settings, networkAllowlist: ["graph.facebook.com"] };
    await mountAtHi();
    expect(changes()).toEqual([
      "Only Sheena can message your WhatsApp bot.",
      "Replies go to Sheena on WhatsApp.",
      "GoatCitadel sends Sheena a test message. WhatsApp can't remove it afterwards.",
    ]);
  });

  it("keeps Turn on off until it knows which hosts it would add", async () => {
    let answer!: (value: unknown) => void;
    api.fetchChannelSetupDefinitions.mockReturnValue(new Promise((resolve) => (answer = resolve)));
    await mountAtHi();
    expect(button("Turn on WhatsApp")?.disabled).toBe(true);
    expect(changes()).toHaveLength(3);

    await act(async () => {
      answer({ items: [whatsappDefinition()] });
    });
    await settle();
    expect(button("Turn on WhatsApp")?.disabled).toBe(false);
    expect(changes()).toHaveLength(4);
  });

  it("turns on with WhatsApp and the host it needs, and says what it is doing", async () => {
    let finish!: (outcome: unknown) => void;
    turnOnApi.turnOnChannelDraft.mockReturnValue(new Promise((resolve) => (finish = resolve)));
    await mountAtHi();
    await click(button("Turn on WhatsApp"));

    expect(turnOnApi.turnOnChannelDraft).toHaveBeenCalledExactlyOnceWith({
      workspaceId: "default",
      draftId: "draft-1",
      catalogId: "channel.whatsapp",
      requiredHosts: ["graph.facebook.com"],
      // The host the step listed, so Turn on adds no host the operator never saw.
      shownHosts: ["graph.facebook.com"],
    });
    expect(button("Turning on WhatsApp…")).toBeDefined();
    expect(status()).toBe("Turning on WhatsApp…");
    expect(button("Start over")?.disabled).toBe(true);

    await act(async () => {
      finish({ kind: "completed", plan });
    });
    await settle();
    expect(steps()[5]!.getAttribute("data-state")).toBe("done");
  });

  it("is not asked about the code once turning on has started", async () => {
    turnOnApi.turnOnChannelDraft.mockResolvedValue({ kind: "completed", plan });
    await mountAtHi();
    await click(button("Turn on WhatsApp"));
    api.checkWhatsAppSetup.mockClear();
    await advance(SETUP_CODE_TTL_MS);
    expect(api.checkWhatsAppSetup).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("says WhatsApp is on and links to its page, which the draft's id names", async () => {
    turnOnApi.turnOnChannelDraft.mockResolvedValue({ kind: "completed", plan });
    await mountAtHi();
    await click(button("Turn on WhatsApp"));

    expect(states()).toEqual(["done", "done", "done", "done", "done", "done"]);
    expect(steps()[5]!.textContent).toContain(DONE);
    expect(status()).toBe(DONE);
    const page = link("Open WhatsApp's page");
    expect(new URL(page!.getAttribute("href")!, "http://cockpit.invalid").pathname).toBe("/chat/messaging/draft-1");
    // The Callback URL Meta was given is the connection's own, so it stays right.
    expect(CALLBACK).toContain("/connections/draft-1/");
    expect(button("Start over")).toBeUndefined();
    expect(button("Turn on WhatsApp")).toBeUndefined();
    expect(link("More options in Settings")).toBeDefined();
  });

  it("asks whether to carry on when the test message could not be removed, in WhatsApp's words", async () => {
    turnOnApi.turnOnChannelDraft.mockResolvedValue({ kind: "needs_cleanup_ack", evidenceId: "proof-1" });
    turnOnApi.acknowledgeCleanupAndTurnOn.mockResolvedValue({ kind: "completed", plan });
    await mountAtHi();
    await click(button("Turn on WhatsApp"));

    const cleanup = "GoatCitadel couldn't remove its test message. Delete it in WhatsApp if you like.";
    expect(steps()[5]!.textContent).toContain(cleanup);
    expect(status()).toBe(cleanup);
    expect(container.textContent).not.toContain("Delete it in Slack");

    await click(button("Continue"));
    expect(turnOnApi.acknowledgeCleanupAndTurnOn).toHaveBeenCalledWith({
      workspaceId: "default",
      draftId: "draft-1",
      catalogId: "channel.whatsapp",
      evidenceId: "proof-1",
    });
    expect(steps()[5]!.getAttribute("data-state")).toBe("done");
  });

  it("shows where it ended up when the change waits on an approval", async () => {
    turnOnApi.turnOnChannelDraft.mockResolvedValue({ kind: "elsewhere", plan, approvalId: "approval-9" });
    await mountAtHi();
    await click(button("Turn on WhatsApp"));
    expect(link("Approve it in Inbox")).toBeDefined();
    expect(steps()[5]!.getAttribute("data-state")).toBe("current");
  });
});

describe("WhatsAppSetupPage, coming back to a setup", () => {
  it("goes on from the hi already said, with no new code and Turn on open", async () => {
    const values = whatsAppDraftWithSender({ setupPage: "messaging", ...IDS, webhookCheckedAt: CHECKED_AT }, SHEENA);
    api.fetchChannelSetupDrafts.mockResolvedValue({ items: [savedSetup(values)] });
    await mount();
    expect(api.checkWhatsAppSetup).toHaveBeenCalledWith({ draftId: "draft-1", expectedRevision: 5, askMeta: true });
    expect(states()).toEqual(["done", "done", "done", "done", "done", "current"]);
    // The draft keeps no name, so the person who said hi is named by their number.
    expect(steps()[4]!.textContent).toContain("+16505551234 can message your bot.");
    expect(api.updateChannelSetupDraft).not.toHaveBeenCalled();
    // Nothing is waited for: neither Meta's check of the address nor the code.
    api.checkWhatsAppSetup.mockClear();
    await advance(SETUP_CODE_TTL_MS);
    expect(api.checkWhatsAppSetup).not.toHaveBeenCalled();
  });

  it("goes on at the code when Meta had checked the address but nobody has said hi", async () => {
    api.fetchChannelSetupDrafts.mockResolvedValue({ items: [savedSetup({ webhookCheckedAt: CHECKED_AT })] });
    await mount();
    expect(states()).toEqual(["done", "done", "done", "done", "current", "locked"]);
    expect(sentCode()).toMatch(/^[A-Za-z0-9]{10}$/);
    expect(status()).toBe(WHATSAPP_WAITING_FOR_HI);
    expect(steps()[3]!.textContent).toContain(WHATSAPP_ADDRESS_CHECKED_EARLIER);
    expect(container.textContent).not.toContain("just now");
  });

  it("says Meta has checked the address, never just now, when the check was noted on an earlier visit", async () => {
    meta = { number: NUMBER, appSubscribed: false };
    api.fetchChannelSetupDrafts.mockResolvedValue({ items: [savedSetup({ webhookCheckedAt: CHECKED_AT })] });
    await mount();

    // Step 4 is still open for the subscription, so the status line is the address's own.
    expect(states()).toEqual(["done", "done", "done", "current", "locked", "locked"]);
    expect(status()).toBe(WHATSAPP_ADDRESS_CHECKED_EARLIER);
    expect(status()).toBe("Meta has checked your address.");
    expect(steps()[3]!.textContent).toContain(WHATSAPP_ADDRESS_CHECKED_EARLIER);
    expect(container.textContent).not.toContain("just now");

    await click(button("Let this app receive your number's messages"));
    expect(steps()[3]!.getAttribute("data-state")).toBe("done");
    expect(steps()[3]!.textContent).toContain(WHATSAPP_ADDRESS_CHECKED_EARLIER);
    expect(container.textContent).not.toContain("just now");
  });

  it("shows the fields again when a saved token has stopped working", async () => {
    api.fetchChannelSetupDrafts.mockResolvedValue({ items: [savedSetup()] });
    api.checkWhatsAppSetup.mockRejectedValue(httpError(400, { error: "Meta didn't accept the access token." }));
    await mount();
    expect(steps()[2]!.textContent).toContain("Meta didn't accept the access token.");
    expect(steps()[2]!.contains(field("Access token"))).toBe(true);
    expect(states()).toEqual(["done", "current", "current", "locked", "locked", "locked"]);
  });

  it("does not go on with a setup made in Settings", async () => {
    api.fetchChannelSetupDrafts.mockResolvedValue({
      items: [draft({ revision: 5, draft: { ...IDS }, secretState: ALL_SECRETS })],
    });
    await mount();
    expect(api.checkWhatsAppSetup).not.toHaveBeenCalled();
    expect(field("Access token")).not.toBeNull();
  });

  it("starts over: discards the draft and shows the first steps again", async () => {
    await mountAtAddress();
    expect(field("Access token")).toBeNull();

    await click(button("Start over"));
    expect(api.discardChannelSetupDraft).toHaveBeenCalledExactlyOnceWith("draft-1", 4);
    expect(states()).toEqual(["done", "current", "current", "locked", "locked", "locked"]);
    for (const label of ["Phone number ID", "WhatsApp Business Account ID", "App ID", "App secret", "Access token"]) {
      expect(field(label)?.value, label).toBe("");
    }
  });

  it("clears what was typed when the operator starts over before checking", async () => {
    await mount();
    await typeDetails();
    await click(button("Start over"));
    expect(api.discardChannelSetupDraft).not.toHaveBeenCalled();
    expect(field("Access token")?.value).toBe("");
    expect(field("App secret")?.value).toBe("");
    expect(field("Phone number ID")?.value).toBe("");
  });

  it("drops half-typed secrets when the page goes", async () => {
    await mount();
    await type("Access token", ACCESS_TOKEN);
    await type("App secret", APP_SECRET);
    expect(field("Access token")?.value).toBe(ACCESS_TOKEN);
    await unmount();
    await mount();
    expect(field("Access token")?.value).toBe("");
    expect(field("App secret")?.value).toBe("");
  });
});

describe("WhatsAppSetupPage, secrets and live regions", () => {
  it("never renders the access token or the App secret", async () => {
    await mount();
    await typeDetails();
    // Typed into masked fields, which are read-only to the page's text.
    expect(container.textContent).not.toContain("SECRET");
    await click(button("Check"));
    expect(container.innerHTML).not.toContain("SECRET");
    await metaChecksAddress();
    expect(container.innerHTML).not.toContain("SECRET");
    heard.codeSender = SHEENA;
    await advance(WHATSAPP_LISTEN_POLL_MS);
    expect(container.innerHTML).not.toContain("SECRET");
  });

  it("never renders the access token or the App secret when Meta can't be asked either", async () => {
    api.checkWhatsAppSetup.mockRejectedValueOnce(new Error(`Bearer ${ACCESS_TOKEN} and ${APP_SECRET}`));
    await mount();
    await checkDetails();
    expect(container.textContent).not.toContain("SECRET");
    expect(status()).toBe(WHATSAPP_CHECK_FAILED);
  });

  it("shows the verify token in its copy field only", async () => {
    await mountAtCode();
    const token = storedVerifyToken();
    expect(field("Verify token")).toBeNull();
    expect(container.innerHTML).not.toContain(token);
    expect(status()).not.toContain(token);
  });

  it("has one status line", async () => {
    const onePerPage = () => {
      expect(container.querySelectorAll('[role="status"]')).toHaveLength(1);
      expect(container.querySelector('[role="alert"], [aria-live]')).toBeNull();
    };
    settings = { revision: 1, networkAllowlist: [] };
    await mount();
    onePerPage();
    await settingsChange({ ...settings, publicWebAddress: ADDRESS });
    onePerPage();
    await checkDetails();
    onePerPage();
    await advance(SETUP_CODE_TTL_MS);
    expect(status()).toBe(WHATSAPP_ADDRESS_NOT_CHECKED);
    onePerPage();
    await click(button("Check again"));
    await metaChecksAddress();
    onePerPage();
    await advance(SETUP_CODE_TTL_MS);
    expect(status()).toBe(WHATSAPP_CODE_EXPIRED);
    onePerPage();
    await click(button("New code"));
    heard.codeSender = SHEENA;
    await advance(WHATSAPP_LISTEN_POLL_MS);
    onePerPage();
    turnOnApi.turnOnChannelDraft.mockResolvedValue({ kind: "failed", message: "WhatsApp said no." });
    await click(button("Turn on WhatsApp"));
    expect(status()).toBe("WhatsApp said no.");
    onePerPage();
  });
});
