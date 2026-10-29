// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ChannelSetupDraft, WhatsAppSetupCheckResult } from "@goatcitadel/contracts";
import { ApiRequestError } from "@goatcitadel/mission-control-shared/api/http-internal";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SETUP_CODE_TTL_MS } from "./setup-code";
import {
  WHATSAPP_ADDRESS_NOT_CHECKED,
  WHATSAPP_CHECK_FAILED,
  WHATSAPP_LISTEN_POLL_MS,
  whatsAppDraftWithSender,
  type WhatsAppDetails,
} from "./whatsapp-setup-model";
import { WHATSAPP_CATALOG_ID, useWhatsAppSetup, type WhatsAppSetupState } from "./use-whatsapp-setup";

const api = vi.hoisted(() => ({
  fetchChannelSetupDrafts: vi.fn(),
  fetchChannelSetupDraft: vi.fn(),
  createChannelSetupDraft: vi.fn(),
  submitChannelSetupDraftSecrets: vi.fn(),
  checkWhatsAppSetup: vi.fn(),
  subscribeWhatsAppSetupApp: vi.fn(),
  updateChannelSetupDraft: vi.fn(),
  discardChannelSetupDraft: vi.fn(),
}));
vi.mock("@goatcitadel/mission-control-shared/api/client", () => api);

const ACCESS_TOKEN = "EAAB-SECRET-ACCESS-TOKEN";
const APP_SECRET = "SECRET-APP-SECRET-0123";
const DETAILS: WhatsAppDetails = {
  accessToken: ACCESS_TOKEN,
  phoneNumberId: "106540352242922",
  businessAccountId: "102290129340398",
  appId: "1234567890123456",
  appSecret: APP_SECRET,
};
const IDS = {
  phoneNumberId: DETAILS.phoneNumberId,
  businessAccountId: DETAILS.businessAccountId,
  appId: DETAILS.appId,
};
const NUMBER = { displayNumber: "+1 555-078-3881", verifiedName: "Goat Shop" };
const CHECKED_AT = "2026-10-29T10:00:00.000Z";
const SHEENA = { actorId: "16505551234", displayName: "Sheena" };
const VERIFY_TOKEN = /^[A-HJ-NP-Za-km-z2-9]{32}$/;
const CODE = /^[A-HJ-NP-Za-km-z2-9]{10}$/;

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

/** A draft made on the WhatsApp page in Chat, with all five details stored and a verify token the page has lost. */
function pageDraft(overrides: Partial<ChannelSetupDraft> = {}): ChannelSetupDraft {
  return draft({
    revision: 4,
    draft: { setupPage: "messaging", ...IDS },
    secretState: ALL_SECRETS,
    ...overrides,
  });
}

function checkResult(overrides: Partial<WhatsAppSetupCheckResult> = {}): WhatsAppSetupCheckResult {
  return { number: NUMBER, appSubscribed: true, ...overrides };
}

function httpError(status: number, body?: unknown): ApiRequestError {
  return new ApiRequestError(`API error ${status}`, { kind: "http", method: "POST", path: "/x", status, body });
}

let root: Root;
let container: HTMLDivElement;
let current: WhatsAppSetupState;

function Probe({ workspaceId, resumeDraftId }: { workspaceId: string; resumeDraftId?: string }) {
  current = useWhatsAppSetup(workspaceId, resumeDraftId);
  return null;
}

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

async function mount(workspaceId = "default", resumeDraftId?: string) {
  await act(async () => {
    root.render(createElement(Probe, { workspaceId, resumeDraftId }));
  });
  await settle();
}

async function run(action: () => Promise<void>) {
  await act(async () => {
    await action();
  });
}

/**
 * The calls a successful first check makes: a new draft at version 1, marked as made here at 2, the secrets stored at
 * 3, the three IDs saved at 4, and Meta asked.
 */
function arrangeCheck(result: WhatsAppSetupCheckResult = checkResult()) {
  api.createChannelSetupDraft.mockResolvedValue(draft({ revision: 1, draft: { label: "kept" } }));
  api.submitChannelSetupDraftSecrets.mockImplementation(
    async (_id: string, input: { expectedRevision: number; values: Record<string, string> }) =>
      draft({
        revision: input.expectedRevision + 1,
        draft: { label: "kept", setupPage: "messaging" },
        secretState: {
          ...TWO_SECRETS,
          ...(input.values.webhookVerifyToken ? { webhookVerifyToken: ALL_SECRETS.webhookVerifyToken } : {}),
        },
      }),
  );
  api.updateChannelSetupDraft.mockImplementation(
    async (_id: string, input: { expectedRevision: number; draft: Record<string, unknown> }) =>
      draft({ revision: input.expectedRevision + 1, draft: input.draft, secretState: ALL_SECRETS }),
  );
  api.checkWhatsAppSetup.mockResolvedValue(result);
}

beforeEach(() => {
  vi.useFakeTimers();
  for (const fn of Object.values(api)) fn.mockReset();
  api.fetchChannelSetupDrafts.mockResolvedValue({ items: [] });
  api.fetchChannelSetupDraft.mockResolvedValue(draft());
  api.discardChannelSetupDraft.mockResolvedValue({ draftId: "draft-1", deleted: true });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  // Unmounted while the fake timers are still installed, so what the hook scheduled is cleared from them.
  act(() => root.unmount());
  vi.useRealTimers();
  container.remove();
});

/** The verify token the page stored, as the secret write carried it. */
function storedVerifyToken(): string {
  const call = api.submitChannelSetupDraftSecrets.mock.calls.find(([, input]) => input.values.webhookVerifyToken);
  return call![1].values.webhookVerifyToken;
}

/** A page whose details have checked out, on a draft at version 4, with the address still to be checked by Meta. */
async function mountReady(result: WhatsAppSetupCheckResult = checkResult()) {
  arrangeCheck(result);
  await mount();
  await run(() => current.checkDetails(DETAILS));
  // From here on every question is the plain one the listening asks: nothing heard yet.
  api.checkWhatsAppSetup.mockReset();
  api.checkWhatsAppSetup.mockResolvedValue({});
}

/** Has Meta check the address at the next question. The draft is then at version 5. */
async function metaChecksAddress() {
  api.checkWhatsAppSetup.mockResolvedValue({ addressCheckedAt: CHECKED_AT });
  await advance(WHATSAPP_LISTEN_POLL_MS);
  api.checkWhatsAppSetup.mockResolvedValue({});
}

describe("useWhatsAppSetup, checking the details", () => {
  it("starts with nothing: no draft, no number, not busy", async () => {
    await mount();
    expect(api.fetchChannelSetupDrafts).toHaveBeenCalledWith({ catalogId: WHATSAPP_CATALOG_ID });
    expect(WHATSAPP_CATALOG_ID).toBe("channel.whatsapp");
    expect(current).toMatchObject({
      draft: null,
      number: null,
      verifyToken: null,
      appSubscribed: false,
      sender: null,
      code: null,
      codeExpired: false,
      addressExpired: false,
      busy: false,
    });
    expect(current.tokenExpiresAt).toBeUndefined();
    expect(current.addressCheckedAt).toBeUndefined();
    expect(current.error).toBeUndefined();
  });

  it("marks a new draft before storing anything, then stores the details in one write", async () => {
    arrangeCheck();
    await mount();
    await run(() => current.checkDetails(DETAILS));

    expect(api.createChannelSetupDraft).toHaveBeenCalledExactlyOnceWith({
      catalogId: "channel.whatsapp",
      lifecycleMode: "create",
    });
    // The new draft is marked as made here before any secret is stored on it.
    expect(api.updateChannelSetupDraft).toHaveBeenNthCalledWith(1, "draft-1", {
      expectedRevision: 1,
      draft: { label: "kept", setupPage: "messaging" },
    });
    // One write holds the access token, the app secret and a fresh verify token, so one version moves on.
    expect(api.submitChannelSetupDraftSecrets).toHaveBeenCalledExactlyOnceWith("draft-1", {
      expectedRevision: 2,
      values: {
        accessToken: ACCESS_TOKEN,
        appSecret: APP_SECRET,
        webhookVerifyToken: expect.stringMatching(VERIFY_TOKEN),
      },
    });
    // One write holds the three IDs, which are not secret, with the version the secret write returned.
    expect(api.updateChannelSetupDraft).toHaveBeenCalledTimes(2);
    expect(api.updateChannelSetupDraft).toHaveBeenNthCalledWith(2, "draft-1", {
      expectedRevision: 3,
      draft: { label: "kept", setupPage: "messaging", ...IDS },
    });
    expect(api.checkWhatsAppSetup).toHaveBeenCalledExactlyOnceWith({
      draftId: "draft-1",
      expectedRevision: 4,
      askMeta: true,
    });

    // The order is the point: made, marked, secrets, IDs, then Meta asked.
    const order = [
      api.createChannelSetupDraft.mock.invocationCallOrder[0],
      api.updateChannelSetupDraft.mock.invocationCallOrder[0],
      api.submitChannelSetupDraftSecrets.mock.invocationCallOrder[0],
      api.updateChannelSetupDraft.mock.invocationCallOrder[1],
      api.checkWhatsAppSetup.mock.invocationCallOrder[0],
    ] as number[];
    expect([...order].sort((a, b) => a - b)).toEqual(order);

    expect(current.draft?.revision).toBe(4);
    expect(current.draft?.draft).toEqual({ label: "kept", setupPage: "messaging", ...IDS });
    expect(current.number).toEqual(NUMBER);
    expect(current.busy).toBe(false);
    expect(current.error).toBeUndefined();
  });

  it("holds the verify token it stored, and no other secret, in what it returns", async () => {
    arrangeCheck();
    await mount();
    await run(() => current.checkDetails(DETAILS));

    const token = storedVerifyToken();
    expect(current.verifyToken).toBe(token);
    const elsewhere = JSON.stringify({ ...current, verifyToken: null });
    expect(elsewhere).not.toContain(token);
    expect(elsewhere).not.toContain("SECRET");
    expect(elsewhere).not.toContain(ACCESS_TOKEN);
    expect(elsewhere).not.toContain(APP_SECRET);
  });

  it("trims the details on the way in", async () => {
    arrangeCheck();
    await mount();
    await run(() =>
      current.checkDetails({
        accessToken: `  ${ACCESS_TOKEN}\n`,
        phoneNumberId: ` ${DETAILS.phoneNumberId} `,
        businessAccountId: `\t${DETAILS.businessAccountId}`,
        appId: `${DETAILS.appId}  `,
        appSecret: `\n${APP_SECRET}\t`,
      }),
    );
    expect(api.submitChannelSetupDraftSecrets).toHaveBeenCalledWith("draft-1", {
      expectedRevision: 2,
      values: expect.objectContaining({ accessToken: ACCESS_TOKEN, appSecret: APP_SECRET }),
    });
    expect(api.updateChannelSetupDraft).toHaveBeenLastCalledWith("draft-1", {
      expectedRevision: 3,
      draft: expect.objectContaining(IDS),
    });
  });

  it("shows the number and the token's end", async () => {
    arrangeCheck(checkResult({ tokenExpiresAt: "2026-10-29T18:00:00.000Z", appSubscribed: false }));
    await mount();
    await run(() => current.checkDetails(DETAILS));
    expect(current.number).toEqual(NUMBER);
    expect(current.tokenExpiresAt).toBe("2026-10-29T18:00:00.000Z");
    expect(current.appSubscribed).toBe(false);

    arrangeCheck(checkResult({ appSubscribed: true }));
    await run(() => current.checkDetails(DETAILS));
    expect(current.tokenExpiresAt).toBeUndefined();
    expect(current.appSubscribed).toBe(true);
  });

  it("says what is missing without asking anyone", async () => {
    arrangeCheck();
    await mount();
    await run(() => current.checkDetails({ ...DETAILS, businessAccountId: "" }));
    expect(current.error).toBe("Paste the WhatsApp Business Account ID first.");
    await run(() => current.checkDetails({ ...DETAILS, phoneNumberId: "10654 235" }));
    expect(current.error).toBe("Phone number ID is digits only.");
    expect(api.createChannelSetupDraft).not.toHaveBeenCalled();
    expect(api.submitChannelSetupDraftSecrets).not.toHaveBeenCalled();
    expect(api.checkWhatsAppSetup).not.toHaveBeenCalled();
    expect(current.busy).toBe(false);
    expect(current.draft).toBeNull();

    await run(() => current.checkDetails(DETAILS));
    expect(current.error).toBeUndefined();
    expect(current.number).toEqual(NUMBER);
  });

  it("does nothing while another check runs", async () => {
    arrangeCheck();
    await mount();
    let finish: (value: ChannelSetupDraft) => void = () => undefined;
    api.createChannelSetupDraft.mockReturnValue(new Promise<ChannelSetupDraft>((resolve) => (finish = resolve)));
    let first: Promise<void> = Promise.resolve();
    await act(async () => {
      first = current.checkDetails(DETAILS);
      await Promise.resolve();
    });
    expect(current.busy).toBe(true);
    await run(() => current.checkDetails(DETAILS));
    expect(api.createChannelSetupDraft).toHaveBeenCalledTimes(1);
    finish(draft({ revision: 1 }));
    await run(() => first);
  });

  it("says the sentence GoatCitadel sent when Meta refuses a detail, and stores nothing more", async () => {
    arrangeCheck();
    api.checkWhatsAppSetup.mockRejectedValue(httpError(400, { error: "Meta didn't accept the access token." }));
    api.fetchChannelSetupDraft.mockResolvedValue(
      draft({ revision: 4, draft: { setupPage: "messaging", ...IDS }, secretState: ALL_SECRETS }),
    );
    await mount();
    await run(() => current.checkDetails(DETAILS));

    expect(current.error).toBe("Meta didn't accept the access token.");
    expect(current.number).toBeNull();
    expect(current.busy).toBe(false);
    // The details were stored before Meta was asked, which moved the draft on: the next try carries the latest version.
    expect(api.fetchChannelSetupDraft).toHaveBeenCalledWith("draft-1");
    expect(current.draft?.revision).toBe(4);
    // Nothing waits for an address while the details do not work.
    expect(vi.getTimerCount()).toBe(0);
  });

  it("says the fixed sentence for any other failure, never what it carried", async () => {
    arrangeCheck();
    api.checkWhatsAppSetup.mockRejectedValue(new Error(`HTTP 401 Authorization: Bearer ${ACCESS_TOKEN}`));
    await mount();
    await run(() => current.checkDetails(DETAILS));
    expect(current.error).toBe(WHATSAPP_CHECK_FAILED);
    expect(JSON.stringify(current)).not.toContain("HTTP 401");
    expect(JSON.stringify(current)).not.toContain("SECRET");

    arrangeCheck();
    api.checkWhatsAppSetup.mockRejectedValue(httpError(500, { error: `Bearer ${ACCESS_TOKEN}.` }));
    await run(() => current.checkDetails(DETAILS));
    expect(current.error).toBe(WHATSAPP_CHECK_FAILED);
    expect(JSON.stringify(current)).not.toContain("SECRET");
  });

  it("says the fixed sentence when the details cannot be stored, and does not ask Meta", async () => {
    arrangeCheck();
    api.submitChannelSetupDraftSecrets.mockRejectedValueOnce(new Error("Authorization: Bearer leaked"));
    await mount();
    await run(() => current.checkDetails(DETAILS));
    expect(current.error).toBe(WHATSAPP_CHECK_FAILED);
    expect(api.checkWhatsAppSetup).not.toHaveBeenCalled();

    api.updateChannelSetupDraft.mockRejectedValueOnce(new Error("conflict"));
    await run(() => current.checkDetails(DETAILS));
    expect(current.error).toBe(WHATSAPP_CHECK_FAILED);
    expect(current.number).toBeNull();
  });

  it("goes on with the same draft and the same verify token after a failure", async () => {
    arrangeCheck();
    api.checkWhatsAppSetup.mockRejectedValueOnce(new Error("offline"));
    // The draft as GoatCitadel has it after the failed try: marked, secrets stored, IDs saved, one version on each.
    api.fetchChannelSetupDraft.mockResolvedValue(
      draft({ revision: 4, draft: { label: "kept", setupPage: "messaging", ...IDS }, secretState: ALL_SECRETS }),
    );
    await mount();
    await run(() => current.checkDetails(DETAILS));
    expect(current.error).toBe(WHATSAPP_CHECK_FAILED);
    const first = storedVerifyToken();
    expect(current.verifyToken).toBe(first);

    api.checkWhatsAppSetup.mockResolvedValue(checkResult());
    await run(() => current.checkDetails({ ...DETAILS, appSecret: "SECRET-FIXED-APP-SECRET" }));

    // No second draft and no second mark. A typo does not make a new verify token, so a Callback URL Meta has already
    // checked keeps working: only the access token and the app secret go again.
    expect(api.createChannelSetupDraft).toHaveBeenCalledTimes(1);
    expect(api.submitChannelSetupDraftSecrets).toHaveBeenCalledTimes(2);
    expect(api.submitChannelSetupDraftSecrets).toHaveBeenLastCalledWith("draft-1", {
      expectedRevision: 4,
      values: { accessToken: ACCESS_TOKEN, appSecret: "SECRET-FIXED-APP-SECRET" },
    });
    expect(current.verifyToken).toBe(first);
    expect(current.error).toBeUndefined();
    expect(current.number).toEqual(NUMBER);
  });

  it("sends no verify token for a draft that already stores one the page no longer holds", async () => {
    api.fetchChannelSetupDrafts.mockResolvedValue({ items: [pageDraft()] });
    api.checkWhatsAppSetup.mockRejectedValueOnce(httpError(400, { error: "Meta didn't accept the access token." }));
    await mount();
    expect(current.error).toBe("Meta didn't accept the access token.");
    expect(current.verifyToken).toBeNull();

    arrangeCheck();
    api.fetchChannelSetupDraft.mockResolvedValue(pageDraft());
    api.updateChannelSetupDraft.mockImplementation(
      async (_id: string, input: { expectedRevision: number; draft: Record<string, unknown> }) =>
        pageDraft({ revision: input.expectedRevision + 1, draft: input.draft }),
    );
    api.submitChannelSetupDraftSecrets.mockImplementation(async (_id: string, input: { expectedRevision: number }) =>
      pageDraft({ revision: input.expectedRevision + 1 }),
    );
    await run(() => current.checkDetails(DETAILS));
    expect(api.submitChannelSetupDraftSecrets).toHaveBeenCalledExactlyOnceWith("draft-1", {
      expectedRevision: 4,
      values: { accessToken: ACCESS_TOKEN, appSecret: APP_SECRET },
    });
    expect(current.verifyToken).toBeNull();
    expect(current.number).toEqual(NUMBER);
  });

  it("makes a verify token for a draft that stores none", async () => {
    api.fetchChannelSetupDrafts.mockResolvedValue({
      items: [pageDraft({ secretState: TWO_SECRETS, draft: { setupPage: "messaging" } })],
    });
    arrangeCheck();
    await mount();
    expect(api.checkWhatsAppSetup).not.toHaveBeenCalled();
    api.updateChannelSetupDraft.mockImplementation(
      async (_id: string, input: { expectedRevision: number; draft: Record<string, unknown> }) =>
        pageDraft({ revision: input.expectedRevision + 1, draft: input.draft }),
    );
    await run(() => current.checkDetails(DETAILS));
    expect(api.createChannelSetupDraft).not.toHaveBeenCalled();
    expect(api.submitChannelSetupDraftSecrets).toHaveBeenCalledExactlyOnceWith("draft-1", {
      expectedRevision: 4,
      values: {
        accessToken: ACCESS_TOKEN,
        appSecret: APP_SECRET,
        webhookVerifyToken: expect.stringMatching(VERIFY_TOKEN),
      },
    });
    expect(current.verifyToken).toBe(storedVerifyToken());
  });

  it("forgets the number and the hi when the details are checked anew, but keeps the verify token", async () => {
    await mountReady();
    await metaChecksAddress();
    await run(() => current.newCode());
    api.checkWhatsAppSetup.mockResolvedValue({ codeSender: SHEENA });
    await advance(WHATSAPP_LISTEN_POLL_MS);
    expect(current.sender).toEqual(SHEENA);
    const token = current.verifyToken;

    api.checkWhatsAppSetup.mockResolvedValue(
      checkResult({ number: { displayNumber: "+1 555-000-1111", verifiedName: "Other" } }),
    );
    await run(() => current.checkDetails(DETAILS));
    expect(current.number).toEqual({ displayNumber: "+1 555-000-1111", verifiedName: "Other" });
    expect(current.sender).toBeNull();
    expect(current.code).toBeNull();
    expect(current.codeExpired).toBe(false);
    expect(current.verifyToken).toBe(token);
    // Meta has checked the address; that does not depend on the details, so it is not asked for again.
    expect(current.addressCheckedAt).toBe(CHECKED_AT);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("useWhatsAppSetup, waiting for Meta to check the address", () => {
  it("listens for Meta's check, notes it on the draft once, and stops", async () => {
    await mountReady();
    expect(WHATSAPP_LISTEN_POLL_MS).toBe(6_000);
    await advance(WHATSAPP_LISTEN_POLL_MS - 1);
    expect(api.checkWhatsAppSetup).not.toHaveBeenCalled();
    await advance(1);
    // Only what GoatCitadel heard is asked for: nothing is sent to Meta.
    expect(api.checkWhatsAppSetup).toHaveBeenCalledExactlyOnceWith({ draftId: "draft-1", expectedRevision: 4 });
    await advance(WHATSAPP_LISTEN_POLL_MS * 2);
    expect(api.checkWhatsAppSetup).toHaveBeenCalledTimes(3);
    for (const [input] of api.checkWhatsAppSetup.mock.calls) {
      expect(input).not.toHaveProperty("askMeta");
      expect(input).not.toHaveProperty("setupCode");
    }
    expect(current.addressCheckedAt).toBeUndefined();
    expect(api.updateChannelSetupDraft).toHaveBeenCalledTimes(2);

    api.checkWhatsAppSetup.mockResolvedValue({ addressCheckedAt: CHECKED_AT });
    await advance(WHATSAPP_LISTEN_POLL_MS);
    expect(api.updateChannelSetupDraft).toHaveBeenCalledTimes(3);
    expect(api.updateChannelSetupDraft).toHaveBeenLastCalledWith("draft-1", {
      expectedRevision: 4,
      draft: { label: "kept", setupPage: "messaging", ...IDS, webhookCheckedAt: CHECKED_AT },
    });
    expect(current.addressCheckedAt).toBe(CHECKED_AT);
    expect(current.draft?.revision).toBe(5);
    expect(current.error).toBeUndefined();

    // Nobody is asked after that, and nothing is left scheduled.
    const asked = api.checkWhatsAppSetup.mock.calls.length;
    await advance(SETUP_CODE_TTL_MS);
    expect(api.checkWhatsAppSetup).toHaveBeenCalledTimes(asked);
    expect(api.updateChannelSetupDraft).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(0);
    expect(current.addressExpired).toBe(false);
  });

  it("notes a check Meta made before the details finished, without waiting", async () => {
    arrangeCheck(checkResult({ addressCheckedAt: CHECKED_AT }));
    await mount();
    await run(() => current.checkDetails(DETAILS));
    expect(api.updateChannelSetupDraft).toHaveBeenCalledTimes(3);
    expect(api.updateChannelSetupDraft).toHaveBeenLastCalledWith("draft-1", {
      expectedRevision: 4,
      draft: expect.objectContaining({ webhookCheckedAt: CHECKED_AT }),
    });
    expect(current.addressCheckedAt).toBe(CHECKED_AT);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("stops after 10 minutes, says Meta has not checked yet, and asks again when told to", async () => {
    await mountReady();
    await advance(SETUP_CODE_TTL_MS);

    expect(current.addressExpired).toBe(true);
    expect(current.error).toBe(WHATSAPP_ADDRESS_NOT_CHECKED);
    expect(vi.getTimerCount()).toBe(0);
    const asked = api.checkWhatsAppSetup.mock.calls.length;
    expect(asked).toBeGreaterThan(50);
    await advance(WHATSAPP_LISTEN_POLL_MS * 5);
    expect(api.checkWhatsAppSetup).toHaveBeenCalledTimes(asked);

    act(() => current.checkAddressAgain());
    expect(current.addressExpired).toBe(false);
    expect(current.error).toBeUndefined();
    await advance(WHATSAPP_LISTEN_POLL_MS);
    expect(api.checkWhatsAppSetup).toHaveBeenCalledTimes(asked + 1);

    api.checkWhatsAppSetup.mockResolvedValue({ addressCheckedAt: CHECKED_AT });
    await advance(WHATSAPP_LISTEN_POLL_MS);
    expect(current.addressCheckedAt).toBe(CHECKED_AT);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("asks again only while it is waiting on a number whose address has not been checked", async () => {
    await mount();
    act(() => current.checkAddressAgain());
    expect(vi.getTimerCount()).toBe(0);

    await mountReady();
    await metaChecksAddress();
    expect(vi.getTimerCount()).toBe(0);
    act(() => current.checkAddressAgain());
    expect(vi.getTimerCount()).toBe(0);
  });

  it("ignores a question that fails and asks again with the next one", async () => {
    await mountReady();
    api.checkWhatsAppSetup.mockRejectedValueOnce(new Error(`Bearer ${ACCESS_TOKEN} rate limited`));
    await advance(WHATSAPP_LISTEN_POLL_MS);
    expect(current.error).toBeUndefined();
    expect(current.addressCheckedAt).toBeUndefined();

    api.checkWhatsAppSetup.mockResolvedValue({ addressCheckedAt: CHECKED_AT });
    await advance(WHATSAPP_LISTEN_POLL_MS);
    expect(current.addressCheckedAt).toBe(CHECKED_AT);
    expect(JSON.stringify(current)).not.toContain("SECRET");
  });

  it("tries to note the same check again, with the draft as it is now, when noting it failed", async () => {
    await mountReady();
    api.checkWhatsAppSetup.mockResolvedValue({ addressCheckedAt: CHECKED_AT });
    api.updateChannelSetupDraft.mockRejectedValueOnce(new Error("This changed somewhere else."));
    api.fetchChannelSetupDraft.mockResolvedValue(
      draft({ revision: 6, draft: { setupPage: "messaging", ...IDS }, secretState: ALL_SECRETS }),
    );
    await advance(WHATSAPP_LISTEN_POLL_MS);
    expect(current.addressCheckedAt).toBeUndefined();
    expect(current.error).toBeTruthy();
    expect(current.draft?.revision).toBe(6);

    await advance(WHATSAPP_LISTEN_POLL_MS);
    expect(api.updateChannelSetupDraft).toHaveBeenLastCalledWith(
      "draft-1",
      expect.objectContaining({ expectedRevision: 6 }),
    );
    expect(current.addressCheckedAt).toBe(CHECKED_AT);
    expect(current.error).toBeUndefined();
  });

  it("stops when the page closes, and drops a check that arrives after", async () => {
    await mountReady();
    await advance(WHATSAPP_LISTEN_POLL_MS);
    expect(api.checkWhatsAppSetup).toHaveBeenCalledTimes(1);

    let answer!: (result: WhatsAppSetupCheckResult) => void;
    api.checkWhatsAppSetup.mockReturnValue(new Promise<WhatsAppSetupCheckResult>((resolve) => (answer = resolve)));
    await advance(WHATSAPP_LISTEN_POLL_MS);
    expect(api.checkWhatsAppSetup).toHaveBeenCalledTimes(2);

    await act(async () => root.unmount());
    expect(vi.getTimerCount()).toBe(0);
    const writes = api.updateChannelSetupDraft.mock.calls.length;
    await act(async () => {
      answer({ addressCheckedAt: CHECKED_AT });
    });
    await settle();
    expect(api.updateChannelSetupDraft).toHaveBeenCalledTimes(writes);
    await advance(SETUP_CODE_TTL_MS);
    expect(api.checkWhatsAppSetup).toHaveBeenCalledTimes(2);
  });

  it("asks nothing while the details are being checked", async () => {
    await mountReady();
    let finish!: (result: WhatsAppSetupCheckResult) => void;
    api.checkWhatsAppSetup.mockReturnValue(new Promise<WhatsAppSetupCheckResult>((resolve) => (finish = resolve)));
    let checking: Promise<void> = Promise.resolve();
    await act(async () => {
      checking = current.checkDetails(DETAILS);
      await Promise.resolve();
    });
    // The wait for the old check is over: only the new check is out.
    await advance(WHATSAPP_LISTEN_POLL_MS * 3);
    expect(api.checkWhatsAppSetup).toHaveBeenCalledTimes(1);
    expect(api.checkWhatsAppSetup).toHaveBeenLastCalledWith(expect.objectContaining({ askMeta: true }));
    finish(checkResult());
    await run(() => checking);
    expect(current.number).toEqual(NUMBER);
  });
});

describe("useWhatsAppSetup, subscribing the app", () => {
  it("subscribes nothing when Meta says the app is subscribed already", async () => {
    await mountReady(checkResult({ appSubscribed: true }));
    expect(current.appSubscribed).toBe(true);
    await run(() => current.subscribeApp());
    expect(api.subscribeWhatsAppSetupApp).not.toHaveBeenCalled();
  });

  it("subscribes the app when Meta says it isn't, once", async () => {
    await mountReady(checkResult({ appSubscribed: false }));
    expect(current.appSubscribed).toBe(false);
    api.subscribeWhatsAppSetupApp.mockResolvedValue({ appSubscribed: true });
    await run(() => current.subscribeApp());
    expect(api.subscribeWhatsAppSetupApp).toHaveBeenCalledExactlyOnceWith({ draftId: "draft-1", expectedRevision: 4 });
    expect(current.appSubscribed).toBe(true);
    expect(current.busy).toBe(false);
    expect(current.error).toBeUndefined();

    await run(() => current.subscribeApp());
    expect(api.subscribeWhatsAppSetupApp).toHaveBeenCalledTimes(1);
  });

  it("keeps waiting for Meta's check while the app is subscribed", async () => {
    await mountReady(checkResult({ appSubscribed: false }));
    api.subscribeWhatsAppSetupApp.mockResolvedValue({ appSubscribed: true });
    await run(() => current.subscribeApp());
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    await advance(WHATSAPP_LISTEN_POLL_MS);
    expect(api.checkWhatsAppSetup).toHaveBeenCalledTimes(1);
  });

  it("says the sentence GoatCitadel sent when Meta won't subscribe the app, and leaves it unsubscribed", async () => {
    await mountReady(checkResult({ appSubscribed: false }));
    api.subscribeWhatsAppSetupApp.mockRejectedValue(
      httpError(400, { error: "Meta didn't let this app receive the account's messages." }),
    );
    await run(() => current.subscribeApp());
    expect(current.error).toBe("Meta didn't let this app receive the account's messages.");
    expect(current.appSubscribed).toBe(false);
    expect(current.busy).toBe(false);

    api.subscribeWhatsAppSetupApp.mockRejectedValue(new Error(`Bearer ${ACCESS_TOKEN}`));
    await run(() => current.subscribeApp());
    expect(current.error).toBe(WHATSAPP_CHECK_FAILED);
    expect(JSON.stringify(current)).not.toContain("SECRET");
  });

  it("subscribes nothing before the details have checked out", async () => {
    await mount();
    await run(() => current.subscribeApp());
    expect(api.subscribeWhatsAppSetupApp).not.toHaveBeenCalled();
  });
});

describe("useWhatsAppSetup, the verify token", () => {
  it("makes and stores a new verify token on request, and shows it", async () => {
    await mountReady();
    const before = current.draft!;
    api.submitChannelSetupDraftSecrets.mockImplementation(async (_id: string, input: { expectedRevision: number }) =>
      draft({ ...before, revision: input.expectedRevision + 1 }),
    );
    const first = current.verifyToken;
    await run(() => current.newVerifyToken());

    expect(api.submitChannelSetupDraftSecrets).toHaveBeenLastCalledWith("draft-1", {
      expectedRevision: before.revision,
      values: { webhookVerifyToken: expect.stringMatching(VERIFY_TOKEN) },
    });
    const stored = api.submitChannelSetupDraftSecrets.mock.lastCall![1].values.webhookVerifyToken;
    expect(current.verifyToken).toBe(stored);
    expect(stored).not.toBe(first);
    expect(current.draft?.revision).toBe(before.revision + 1);
    expect(current.error).toBeUndefined();
    expect(current.busy).toBe(false);
    // Meta is asked about the new token: the wait starts over.
    await advance(WHATSAPP_LISTEN_POLL_MS);
    expect(api.checkWhatsAppSetup).toHaveBeenCalledTimes(1);
  });

  it("says why when the new verify token cannot be stored, and keeps the old one", async () => {
    await mountReady();
    const first = current.verifyToken;
    api.submitChannelSetupDraftSecrets.mockRejectedValueOnce(
      httpError(400, { error: "Choose a WhatsApp setup draft." }),
    );
    api.fetchChannelSetupDraft.mockResolvedValue(draft({ revision: 7 }));
    await run(() => current.newVerifyToken());
    expect(current.error).toBe("Choose a WhatsApp setup draft.");
    expect(current.verifyToken).toBe(first);
    expect(current.draft?.revision).toBe(7);
    expect(current.busy).toBe(false);
  });

  it("keeps the token once Meta has checked the address", async () => {
    await mountReady();
    await metaChecksAddress();
    const token = current.verifyToken;
    api.submitChannelSetupDraftSecrets.mockClear();
    await run(() => current.newVerifyToken());
    expect(api.submitChannelSetupDraftSecrets).not.toHaveBeenCalled();
    expect(current.verifyToken).toBe(token);
  });

  it("makes nothing before there is a draft", async () => {
    await mount();
    await run(() => current.newVerifyToken());
    expect(api.submitChannelSetupDraftSecrets).not.toHaveBeenCalled();
    expect(current.verifyToken).toBeNull();
  });
});

describe("useWhatsAppSetup, saying hi", () => {
  it("saves a fresh code and asks for it every 6 seconds", async () => {
    await mountReady();
    await metaChecksAddress();
    expect(current.code).toBeNull();
    await run(() => current.newCode());

    const code = current.code!;
    expect(code).toMatch(CODE);
    expect(api.updateChannelSetupDraft).toHaveBeenLastCalledWith("draft-1", {
      expectedRevision: 5,
      draft: expect.objectContaining({ setupCode: code, setupPage: "messaging", webhookCheckedAt: CHECKED_AT }),
    });
    expect(current.draft?.revision).toBe(6);
    expect(current.codeExpired).toBe(false);
    expect(current.sender).toBeNull();

    api.checkWhatsAppSetup.mockClear();
    await advance(WHATSAPP_LISTEN_POLL_MS - 1);
    expect(api.checkWhatsAppSetup).not.toHaveBeenCalled();
    await advance(1);
    // Nothing is sent to Meta: only what GoatCitadel heard is asked for.
    expect(api.checkWhatsAppSetup).toHaveBeenCalledExactlyOnceWith({
      draftId: "draft-1",
      expectedRevision: 6,
      setupCode: code,
    });
    await advance(WHATSAPP_LISTEN_POLL_MS * 2);
    expect(api.checkWhatsAppSetup).toHaveBeenCalledTimes(3);
    for (const [input] of api.checkWhatsAppSetup.mock.calls) expect(input).not.toHaveProperty("askMeta");
  });

  it("hears the code, saves the sender, and stops asking", async () => {
    await mountReady();
    await metaChecksAddress();
    await run(() => current.newCode());
    const before = current.draft!;
    api.checkWhatsAppSetup.mockResolvedValue({ codeSender: SHEENA });
    await advance(WHATSAPP_LISTEN_POLL_MS);

    expect(api.updateChannelSetupDraft).toHaveBeenLastCalledWith("draft-1", {
      expectedRevision: before.revision,
      draft: whatsAppDraftWithSender(before.draft, SHEENA),
    });
    expect(api.updateChannelSetupDraft.mock.lastCall![1].draft).toMatchObject({
      allowedSenders: ["16505551234"],
      ownerActorIds: ["16505551234"],
      inboundAccessMode: "allowlist",
      defaultTarget: "16505551234",
    });
    expect(current.sender).toEqual(SHEENA);
    expect(current.draft?.revision).toBe(before.revision + 1);
    expect(current.error).toBeUndefined();

    // Nobody is asked after that, and nothing is left scheduled.
    const asked = api.checkWhatsAppSetup.mock.calls.length;
    await advance(SETUP_CODE_TTL_MS);
    expect(api.checkWhatsAppSetup).toHaveBeenCalledTimes(asked);
    expect(vi.getTimerCount()).toBe(0);
    expect(current.codeExpired).toBe(false);
  });

  it("stops after 10 minutes and offers a new code", async () => {
    await mountReady();
    await metaChecksAddress();
    await run(() => current.newCode());
    const first = current.code!;
    await advance(SETUP_CODE_TTL_MS);

    expect(current.codeExpired).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    const asked = api.checkWhatsAppSetup.mock.calls.length;
    await advance(WHATSAPP_LISTEN_POLL_MS * 5);
    expect(api.checkWhatsAppSetup).toHaveBeenCalledTimes(asked);

    // A new code replaces the old one, is saved, and is listened for.
    await run(() => current.newCode());
    expect(current.code).not.toBe(first);
    expect(current.codeExpired).toBe(false);
    expect(api.updateChannelSetupDraft).toHaveBeenLastCalledWith(
      "draft-1",
      expect.objectContaining({ draft: expect.objectContaining({ setupCode: current.code }) }),
    );
    await advance(WHATSAPP_LISTEN_POLL_MS);
    expect(api.checkWhatsAppSetup).toHaveBeenCalledTimes(asked + 1);
    expect(api.checkWhatsAppSetup).toHaveBeenLastCalledWith(expect.objectContaining({ setupCode: current.code }));
  });

  it("asks for no code before Meta has checked the address", async () => {
    await mountReady();
    const writes = api.updateChannelSetupDraft.mock.calls.length;
    await run(() => current.newCode());
    expect(api.updateChannelSetupDraft).toHaveBeenCalledTimes(writes);
    expect(current.code).toBeNull();
    // The wait for Meta goes on undisturbed.
    expect(vi.getTimerCount()).toBeGreaterThan(0);
  });

  it("asks for no code before the details work", async () => {
    await mount();
    await run(() => current.newCode());
    expect(api.updateChannelSetupDraft).not.toHaveBeenCalled();
    expect(current.code).toBeNull();
  });

  it("says why when the code cannot be saved, and offers no code", async () => {
    await mountReady();
    await metaChecksAddress();
    api.updateChannelSetupDraft.mockRejectedValueOnce(new Error("This changed somewhere else."));
    api.fetchChannelSetupDraft.mockResolvedValue(draft({ revision: 5 }));
    await run(() => current.newCode());
    expect(current.code).toBeNull();
    expect(current.error).toBeTruthy();
    expect(current.busy).toBe(false);
    api.checkWhatsAppSetup.mockClear();
    await advance(WHATSAPP_LISTEN_POLL_MS * 3);
    expect(api.checkWhatsAppSetup).not.toHaveBeenCalled();

    await run(() => current.newCode());
    expect(current.code).not.toBeNull();
    expect(current.error).toBeUndefined();
  });

  it("ignores a question that fails and asks again with the next one", async () => {
    await mountReady();
    await metaChecksAddress();
    await run(() => current.newCode());
    api.checkWhatsAppSetup.mockRejectedValueOnce(new Error(`Bearer ${ACCESS_TOKEN} rate limited`));
    await advance(WHATSAPP_LISTEN_POLL_MS);
    expect(current.error).toBeUndefined();
    expect(current.sender).toBeNull();

    api.checkWhatsAppSetup.mockResolvedValue({ codeSender: SHEENA });
    await advance(WHATSAPP_LISTEN_POLL_MS);
    expect(current.sender).toEqual(SHEENA);
    expect(JSON.stringify(current)).not.toContain("SECRET");
  });

  it("tries to save the same hi again, with the draft as it is now, when saving it failed", async () => {
    await mountReady();
    await metaChecksAddress();
    await run(() => current.newCode());
    api.checkWhatsAppSetup.mockResolvedValue({ codeSender: SHEENA });
    api.updateChannelSetupDraft.mockRejectedValueOnce(new Error("This changed somewhere else."));
    api.fetchChannelSetupDraft.mockResolvedValue(draft({ revision: 8, draft: { setupCode: "x" } }));
    await advance(WHATSAPP_LISTEN_POLL_MS);
    expect(current.sender).toBeNull();
    expect(current.error).toBeTruthy();
    expect(current.draft?.revision).toBe(8);

    await advance(WHATSAPP_LISTEN_POLL_MS);
    expect(api.updateChannelSetupDraft).toHaveBeenLastCalledWith(
      "draft-1",
      expect.objectContaining({ expectedRevision: 8 }),
    );
    expect(current.sender).toEqual(SHEENA);
    expect(current.error).toBeUndefined();
  });

  it("stops when the page closes, and drops a hi that arrives after", async () => {
    await mountReady();
    await metaChecksAddress();
    await run(() => current.newCode());
    let answer!: (result: WhatsAppSetupCheckResult) => void;
    api.checkWhatsAppSetup.mockReturnValue(new Promise<WhatsAppSetupCheckResult>((resolve) => (answer = resolve)));
    await advance(WHATSAPP_LISTEN_POLL_MS);

    await act(async () => root.unmount());
    expect(vi.getTimerCount()).toBe(0);
    const writes = api.updateChannelSetupDraft.mock.calls.length;
    await act(async () => {
      answer({ codeSender: SHEENA });
    });
    await settle();
    expect(api.updateChannelSetupDraft).toHaveBeenCalledTimes(writes);
  });
});

describe("useWhatsAppSetup, coming back to a setup", () => {
  it("checks a setup with all five details stored again with Meta, and writes nothing", async () => {
    api.fetchChannelSetupDrafts.mockResolvedValue({ items: [pageDraft({ draftId: "page-1", revision: 7 })] });
    api.checkWhatsAppSetup.mockResolvedValue(checkResult({ tokenExpiresAt: "2026-10-29T18:00:00.000Z" }));
    await mount();

    expect(current.draft?.draftId).toBe("page-1");
    expect(api.checkWhatsAppSetup).toHaveBeenCalledExactlyOnceWith({
      draftId: "page-1",
      expectedRevision: 7,
      askMeta: true,
    });
    expect(current.number).toEqual(NUMBER);
    expect(current.tokenExpiresAt).toBe("2026-10-29T18:00:00.000Z");
    expect(current.appSubscribed).toBe(true);
    expect(current.verifyToken).toBeNull();
    expect(current.busy).toBe(false);
    expect(current.error).toBeUndefined();
    // Reading only: nothing is stored and nothing is saved.
    expect(api.submitChannelSetupDraftSecrets).not.toHaveBeenCalled();
    expect(api.updateChannelSetupDraft).not.toHaveBeenCalled();
    expect(api.createChannelSetupDraft).not.toHaveBeenCalled();
  });

  it("waits again for Meta's check when the setup had none yet, and notes it when it comes", async () => {
    api.fetchChannelSetupDrafts.mockResolvedValue({ items: [pageDraft()] });
    api.checkWhatsAppSetup.mockResolvedValue(checkResult());
    await mount();
    expect(current.addressCheckedAt).toBeUndefined();
    expect(vi.getTimerCount()).toBeGreaterThan(0);

    api.checkWhatsAppSetup.mockResolvedValue({ addressCheckedAt: CHECKED_AT });
    api.updateChannelSetupDraft.mockImplementation(
      async (_id: string, input: { expectedRevision: number; draft: Record<string, unknown> }) =>
        pageDraft({ revision: input.expectedRevision + 1, draft: input.draft }),
    );
    await advance(WHATSAPP_LISTEN_POLL_MS);
    expect(api.updateChannelSetupDraft).toHaveBeenCalledExactlyOnceWith("draft-1", {
      expectedRevision: 4,
      draft: expect.objectContaining({ webhookCheckedAt: CHECKED_AT }),
    });
    expect(current.addressCheckedAt).toBe(CHECKED_AT);
  });

  it("notes a check Meta made while the page was away, when the first question already carries it", async () => {
    api.fetchChannelSetupDrafts.mockResolvedValue({ items: [pageDraft()] });
    api.checkWhatsAppSetup.mockResolvedValue(checkResult({ addressCheckedAt: CHECKED_AT }));
    api.updateChannelSetupDraft.mockImplementation(
      async (_id: string, input: { expectedRevision: number; draft: Record<string, unknown> }) =>
        pageDraft({ revision: input.expectedRevision + 1, draft: input.draft }),
    );
    await mount();
    expect(api.updateChannelSetupDraft).toHaveBeenCalledExactlyOnceWith("draft-1", {
      expectedRevision: 4,
      draft: expect.objectContaining({ webhookCheckedAt: CHECKED_AT }),
    });
    expect(current.addressCheckedAt).toBe(CHECKED_AT);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("goes on at saying hi when Meta had already checked the address, with no verify token to show", async () => {
    api.fetchChannelSetupDrafts.mockResolvedValue({
      items: [pageDraft({ draft: { setupPage: "messaging", ...IDS, webhookCheckedAt: CHECKED_AT } })],
    });
    api.checkWhatsAppSetup.mockResolvedValue(checkResult());
    await mount();

    expect(current.addressCheckedAt).toBe(CHECKED_AT);
    expect(current.verifyToken).toBeNull();
    expect(current.sender).toBeNull();
    expect(current.code).toBeNull();
    expect(current.number).toEqual(NUMBER);
    // Nothing waits for Meta again.
    expect(vi.getTimerCount()).toBe(0);
    expect(api.updateChannelSetupDraft).not.toHaveBeenCalled();

    // The hi opens: a code can be made and is listened for.
    api.updateChannelSetupDraft.mockImplementation(
      async (_id: string, input: { expectedRevision: number; draft: Record<string, unknown> }) =>
        pageDraft({ revision: input.expectedRevision + 1, draft: input.draft }),
    );
    await run(() => current.newCode());
    expect(current.code).toMatch(CODE);
    expect(api.updateChannelSetupDraft).toHaveBeenCalledExactlyOnceWith("draft-1", {
      expectedRevision: 4,
      draft: expect.objectContaining({ setupCode: current.code }),
    });
  });

  it("goes on past the hi when the sender was saved", async () => {
    const saved = whatsAppDraftWithSender({ setupPage: "messaging", ...IDS, webhookCheckedAt: CHECKED_AT }, SHEENA);
    api.fetchChannelSetupDrafts.mockResolvedValue({ items: [pageDraft({ draft: saved })] });
    api.checkWhatsAppSetup.mockResolvedValue(checkResult());
    await mount();
    expect(current.sender).toEqual({ actorId: "16505551234" });
    expect(current.addressCheckedAt).toBe(CHECKED_AT);
    expect(vi.getTimerCount()).toBe(0);
    expect(api.updateChannelSetupDraft).not.toHaveBeenCalled();
  });

  it("makes a new verify token for a setup whose address Meta has not checked, and shows it", async () => {
    api.fetchChannelSetupDrafts.mockResolvedValue({ items: [pageDraft({ revision: 6 })] });
    api.checkWhatsAppSetup.mockResolvedValue(checkResult());
    await mount();
    expect(current.verifyToken).toBeNull();

    api.submitChannelSetupDraftSecrets.mockImplementation(async (_id: string, input: { expectedRevision: number }) =>
      pageDraft({ revision: input.expectedRevision + 1 }),
    );
    await run(() => current.newVerifyToken());
    expect(api.submitChannelSetupDraftSecrets).toHaveBeenCalledExactlyOnceWith("draft-1", {
      expectedRevision: 6,
      values: { webhookVerifyToken: expect.stringMatching(VERIFY_TOKEN) },
    });
    expect(current.verifyToken).toBe(storedVerifyToken());
    expect(current.draft?.revision).toBe(7);
  });

  it("leaves a setup unchecked unless all five details are stored", async () => {
    const without: Array<Partial<ChannelSetupDraft>> = [
      { secretState: {} },
      { secretState: { accessToken: TWO_SECRETS.accessToken } },
      { secretState: { appSecret: TWO_SECRETS.appSecret } },
      { draft: { setupPage: "messaging", businessAccountId: IDS.businessAccountId, appId: IDS.appId } },
      { draft: { setupPage: "messaging", phoneNumberId: IDS.phoneNumberId, appId: IDS.appId } },
      { draft: { setupPage: "messaging", phoneNumberId: IDS.phoneNumberId, businessAccountId: IDS.businessAccountId } },
    ];
    for (const overrides of without) {
      // A fresh page each time: the same one would not look for the setup again.
      act(() => root.unmount());
      root = createRoot(container);
      api.fetchChannelSetupDrafts.mockResolvedValue({ items: [pageDraft(overrides)] });
      await mount();
      expect(current.draft?.draftId).toBe("draft-1");
      expect(current.number).toBeNull();
      expect(current.error).toBeUndefined();
      expect(current.busy).toBe(false);
    }
    expect(api.checkWhatsAppSetup).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("puts the fields back, with the sentence GoatCitadel sent, when a saved detail is no longer accepted", async () => {
    api.fetchChannelSetupDrafts.mockResolvedValue({ items: [pageDraft()] });
    api.checkWhatsAppSetup.mockRejectedValue(httpError(400, { error: "Meta didn't accept the access token." }));
    await mount();
    expect(current.draft?.draftId).toBe("draft-1");
    expect(current.number).toBeNull();
    expect(current.error).toBe("Meta didn't accept the access token.");
    expect(current.busy).toBe(false);
    expect(api.updateChannelSetupDraft).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("says the fixed sentence when Meta cannot be asked about a saved setup", async () => {
    api.fetchChannelSetupDrafts.mockResolvedValue({ items: [pageDraft()] });
    api.checkWhatsAppSetup.mockRejectedValue(new Error(`Bearer ${ACCESS_TOKEN}`));
    await mount();
    expect(current.error).toBe(WHATSAPP_CHECK_FAILED);
    expect(JSON.stringify(current)).not.toContain("SECRET");
  });

  it("resumes only a setup made on this page", async () => {
    const elsewhere = pageDraft({ draftId: "settings-1", updatedAt: "2026-10-29T11:00:00.000Z", draft: {} });
    const here = pageDraft({ draftId: "page-1", updatedAt: "2026-10-29T10:00:00.000Z" });
    api.fetchChannelSetupDrafts.mockResolvedValue({ items: [elsewhere, here] });
    api.checkWhatsAppSetup.mockResolvedValue(checkResult());
    await mount();
    // The newer one belongs to Settings, so the page does not take it over.
    expect(current.draft?.draftId).toBe("page-1");

    // A draft the address names that was not made here is not gone on with either: the page starts fresh.
    api.checkWhatsAppSetup.mockClear();
    await mount("default", "settings-1");
    expect(current.draft).toBeNull();
    expect(current.number).toBeNull();
    expect(api.checkWhatsAppSetup).not.toHaveBeenCalled();
  });

  it("resumes the draft the address names", async () => {
    api.fetchChannelSetupDrafts.mockResolvedValue({
      items: [pageDraft({ draftId: "page-1" }), pageDraft({ draftId: "page-2", revision: 9 })],
    });
    api.checkWhatsAppSetup.mockResolvedValue(checkResult());
    await mount("default", "page-2");
    expect(current.draft?.draftId).toBe("page-2");
    expect(api.checkWhatsAppSetup).toHaveBeenCalledExactlyOnceWith({
      draftId: "page-2",
      expectedRevision: 9,
      askMeta: true,
    });
  });

  it("starts fresh when the drafts cannot be read", async () => {
    api.fetchChannelSetupDrafts.mockRejectedValue(new Error("offline"));
    await mount();
    expect(current).toMatchObject({ draft: null, number: null, busy: false });
    expect(current.error).toBeUndefined();
  });

  it("drops a slow reply once the workspace has changed", async () => {
    let finish: (value: { items: ChannelSetupDraft[] }) => void = () => undefined;
    api.fetchChannelSetupDrafts.mockReturnValueOnce(new Promise((resolve) => (finish = resolve)));
    await mount("one");
    expect(current.busy).toBe(true);

    api.fetchChannelSetupDrafts.mockResolvedValue({ items: [] });
    await mount("two");
    await act(async () => {
      finish({ items: [pageDraft({ draftId: "old-workspace" })] });
      await Promise.resolve();
    });
    await settle();
    expect(current.draft).toBeNull();
    expect(api.checkWhatsAppSetup).not.toHaveBeenCalled();
  });
});

describe("useWhatsAppSetup, starting over", () => {
  it("starts over by discarding the draft, and forgets everything, the verify token too", async () => {
    await mountReady();
    await metaChecksAddress();
    await run(() => current.newCode());
    await run(() => current.startOver());

    expect(api.discardChannelSetupDraft).toHaveBeenCalledExactlyOnceWith("draft-1", 6);
    expect(current).toMatchObject({
      draft: null,
      number: null,
      verifyToken: null,
      sender: null,
      code: null,
      busy: false,
    });
    expect(current.addressCheckedAt).toBeUndefined();
    expect(current.error).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
    const asked = api.checkWhatsAppSetup.mock.calls.length;
    await advance(SETUP_CODE_TTL_MS);
    expect(api.checkWhatsAppSetup).toHaveBeenCalledTimes(asked);

    // The next check begins a new draft, with a new verify token.
    arrangeCheck();
    api.createChannelSetupDraft.mockResolvedValue(draft({ draftId: "draft-2" }));
    api.submitChannelSetupDraftSecrets.mockClear();
    await run(() => current.checkDetails(DETAILS));
    expect(api.createChannelSetupDraft).toHaveBeenCalledTimes(2);
    expect(api.submitChannelSetupDraftSecrets.mock.calls[0]![1].values.webhookVerifyToken).toMatch(VERIFY_TOKEN);
  });

  it("keeps the setup, and keeps listening, when it cannot be discarded", async () => {
    await mountReady();
    api.discardChannelSetupDraft.mockRejectedValue(new Error("This changed somewhere else."));
    await run(() => current.startOver());
    expect(current.error).toBeTruthy();
    expect(current.draft?.draftId).toBe("draft-1");
    expect(current.number).not.toBeNull();
    expect(current.busy).toBe(false);
    await advance(WHATSAPP_LISTEN_POLL_MS);
    expect(api.checkWhatsAppSetup).toHaveBeenCalledTimes(1);
  });

  it("starts over with nothing to discard by only clearing", async () => {
    await mount();
    await run(() => current.startOver());
    expect(api.discardChannelSetupDraft).not.toHaveBeenCalled();
    expect(current).toMatchObject({ draft: null, number: null, busy: false });
  });

  it("asks nothing while the setup is being discarded", async () => {
    await mountReady();
    let finish!: (result: unknown) => void;
    api.discardChannelSetupDraft.mockReturnValue(new Promise((resolve) => (finish = resolve)));
    let discarding: Promise<void> = Promise.resolve();
    await act(async () => {
      discarding = current.startOver();
      await Promise.resolve();
    });
    expect(current.busy).toBe(true);
    await advance(WHATSAPP_LISTEN_POLL_MS * 2);
    expect(api.checkWhatsAppSetup).not.toHaveBeenCalled();

    finish({ draftId: "draft-1", deleted: true });
    await run(() => discarding);
    expect(current.draft).toBeNull();
  });
});
