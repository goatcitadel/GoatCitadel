import { describe, expect, it, vi } from "vitest";
import type { ChannelSetupFieldDefinition, ChannelSetupStepDefinition } from "@goatcitadel/contracts";
import { requireChannelSetupDefinition } from "../channel-setup-definitions.js";
import { isPermittedIntegrationSecretEnvVarName } from "../gateway/integration-secret-envvar-guard.js";
import { buildIntegrationConnectionChecks } from "../integration-diagnostics-service.js";
import { guideFinish, type GuideFinishOptions } from "./guide-finish.test-support.js";

function guide() {
  return requireChannelSetupDefinition("channel.zalo");
}

function step(id: string): ChannelSetupStepDefinition {
  const found = guide().definition.wizard.steps.find((candidate) => candidate.id === id);
  if (!found) throw new Error(`Zalo guide has no step ${id}`);
  return found;
}

function field(key: string): ChannelSetupFieldDefinition {
  const found = guide()
    .definition.wizard.steps.flatMap((candidate) => candidate.fields ?? [])
    .find((candidate) => candidate.key === key);
  if (!found) throw new Error(`Zalo guide has no field ${key}`);
  return found;
}

function fieldKeys(id: string): string[] {
  return (step(id).fields ?? []).map((candidate) => candidate.key);
}

function paragraphs(id: string): string[] {
  return (step(id).body ?? []).flatMap((block) => (block.kind === "paragraph" ? [block.text] : []));
}

function stepIds(): string[] {
  return guide().definition.wizard.steps.map((candidate) => candidate.id);
}

/** Every string the guide shows, joined: values only, not the names of fields such as a placeholder's own key. */
function wizardText(): string {
  const strings: string[] = [];
  const walk = (value: unknown): void => {
    if (typeof value === "string") strings.push(value);
    else if (Array.isArray(value)) value.forEach(walk);
    else if (value && typeof value === "object") Object.values(value).forEach(walk);
  };
  walk(guide().definition.wizard);
  return strings.join("\n");
}

/** The saved config for the usual values, for the tests that run the real test against a fake Zalo. */
function savedValues(): Record<string, unknown> {
  return guide().normalize(draftOf(VALUES));
}

/** What validate() says for a few typical mistakes: messages, details and next steps. */
function issueText(): string {
  const drafts = [{}, { accessToken: ACCESS_TOKEN }, { defaultRecipientId: USER_ID }, { ...VALUES }];
  return drafts
    .flatMap((values) => guide().validate(draftOf(values)))
    .flatMap((issue) => [issue.message, issue.detail ?? "", ...(issue.nextSteps ?? [])])
    .join("\n");
}

const ACCESS_TOKEN = "zalo-oa-access-token-".padEnd(48, "x");
// The user_id in Zalo's own documentation for the send and user-list calls.
const USER_ID = "2512523625412515";
const VALUES = { accessToken: ACCESS_TOKEN, defaultRecipientId: USER_ID };
// Zalo documents the text send at v3.0/oa/message/cs and lists the old v2.0/oa/message call as shut down (error -240).
const ENDPOINT = "https://openapi.zalo.me/v3.0/oa/message/cs";
const SHUT_DOWN: Refusal = {
  error: -240,
  message:
    "MessageV2 API has been shut down, please switch to MessageV3. See instructions here https://go.zalo.me/api-v3",
};
const BAN = /posture|provenance|ingress|egress|sandbox|activation plan/iu;

type Fetcher = NonNullable<GuideFinishOptions["fetch"]>;
type Refusal = { error: number; message: string };

/** Zalo's own wording for the refusals the setup test can hit (developers.zalo.me, Official Account API error codes). */
const TOKEN_INVALID: Refusal = { error: -216, message: "Access token is invalid" };
const TOKEN_EXPIRED: Refusal = { error: -220, message: "access_token is expired or removed" };
const NOT_INTERACTED: Refusal = { error: -230, message: "User has not interacted with the OA in the past 7 days" };
const NOT_FOLLOWED: Refusal = { error: -213, message: "User has not followed OA" };
const INTERACTION_EXPIRED: Refusal = {
  error: -232,
  message: "User has not interacted with the OA, or the last interaction has expired",
};
const API_NOT_REGISTERED: Refusal = { error: -212, message: "App has not registed this api" };
const OA_NOT_AUTHORIZED: Refusal = { error: -223, message: "Official Account has not authorized this API" };
const USER_BLOCKED: Refusal = { error: -217, message: "User has blocked invitation from OA" };

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** A Zalo Official Account API that answers the message call the setup test makes. Zalo puts a refusal in a 200 reply. */
function zalo(refusal?: Refusal): Fetcher {
  return async (url) => {
    const { hostname, pathname } = new URL(url);
    if (hostname === "openapi.zalo.me" && pathname === "/v3.0/oa/message/cs") {
      return refusal ? json(refusal) : json({ error: 0, message: "Success", data: { message_id: "msg-1" } });
    }
    return json({}, 404);
  };
}

const { draftOf, connectionOf, continueBlockers, port } = guideFinish("channel.zalo");
const accepting = guideFinish("channel.zalo", { fetch: zalo() });
const refusedWith = (refusal: Refusal) => guideFinish("channel.zalo", { fetch: zalo(refusal) });
const unreachable = guideFinish("channel.zalo", {
  fetch: async () => {
    throw new Error("socket hang up");
  },
});

describe("Zalo OA setup copy", () => {
  it("uses no words the operator copy rules ban anywhere in the guide, the errors or the test's own words", async () => {
    expect(JSON.stringify(guide().definition.wizard)).not.toMatch(BAN);
    expect(issueText()).not.toMatch(BAN);

    const probeWords = (
      await Promise.all(
        [undefined, TOKEN_INVALID, NOT_INTERACTED, API_NOT_REGISTERED].map(async (refusal) =>
          (await guideFinish("channel.zalo", { fetch: zalo(refusal) }).verdictOf(savedValues())).live.probe?.steps.map(
            (candidate) => `${candidate.label} ${candidate.message}`,
          ),
        ),
      )
    )
      .flat()
      .join("\n");
    expect(probeWords).not.toMatch(BAN);
  });

  it("never claims a public web address for GoatCitadel", () => {
    expect(wizardText()).not.toMatch(/https:\/\/<your public address>/u);
  });

  it("states the token lifetime Zalo documents, and promises no refresh GoatCitadel doesn't do (R58)", () => {
    // Zalo's auth page (developers.zalo.me/docs/official-account/bat-dau/xac-thuc-va-uy-quyen-cho-ung-dung-new) says an
    // OA access token is valid for 25 hours. Its refresh token (3 months, single use) is not something GoatCitadel uses.
    expect(wizardText()).not.toMatch(/refresh|(?:will|automatically|auto-)\s*renew|every day|once a day|valid for/iu);
    // The hour figures in the guide: the lifetime in the overview note and in the token's help, and the one 48 hours
    // that is about what Zalo charges for a message, not about the token.
    expect(wizardText().match(/\b\d+\s*hours?\b/giu)).toEqual(["25 hours", "25 hours", "48 hours"]);
    expect(wizardText()).not.toMatch(/\b(?:24|26|1)\s*hours?\b/iu);
  });

  it("claims nothing about Zalo's apps or menus that Zalo's pages don't state (R46)", () => {
    // The audit's "Zalo doesn't show this ID in its apps" and "from your Zalo app's settings" are on no Zalo page.
    expect(wizardText()).not.toMatch(/in its apps|doesn't show this ID|app's settings|Official Account Manager/iu);
    // The audit's "follows your Official Account" is not a rule of the consultation message: the 7-day interaction is.
    expect(wizardText()).not.toMatch(/follows your Official Account/iu);
  });

  it("promises no screen that shows the user_id: none does (the guide says so instead)", () => {
    expect(wizardText()).not.toMatch(/Diagnostics/u);
    expect(issueText()).not.toMatch(/Diagnostics/u);
  });
});

describe("Zalo OA setup guide: what it says up front (items 3, 6, R46, R48, N11)", () => {
  it("opens with the intro and prerequisites from the audit, with the one Zalo rule it checked", () => {
    const wizard = guide().definition.wizard;

    expect(wizard.introSummary).toBe(
      "Send messages from a Zalo Official Account. Sends only: Zalo can't message GoatCitadel.",
    );
    // The audit's second line says "follows your Official Account and has messaged it recently". Zalo's overview page
    // (developers.zalo.me › Official Account API › Messages › Overview) states the rule as an interaction in the last
    // 7 days, such as a message to the Official Account, and says nothing about following, so the line says that.
    expect(wizard.prerequisites).toEqual([
      "A Zalo Official Account access token.",
      "The Zalo user_id of someone who has messaged your Official Account in the last 7 days.",
    ]);
  });

  it("ends with the audit's first message: the test sends one and doesn't delete it", () => {
    // Ruling R49: the probe sends the message and never deletes it, so asking the person to check it is true.
    expect(paragraphs("first-message")).toEqual(["Check the test message arrived in the recipient's Zalo."]);
    expect(step("first-message").title).toBe("Confirm delivery");
  });

  it("keeps the picker data: the one Zalo host and no inbound webhook (this channel only sends)", () => {
    const wizard = guide().definition.wizard;

    expect(wizard.requiredHosts).toEqual(["openapi.zalo.me"]);
    expect(wizard.conditionalHosts ?? []).toEqual([]);
    expect(wizard.inboundWebhook).toBeUndefined();
  });

  it("walks through the steps in order, with no sender step: nobody can message this channel", () => {
    expect(stepIds()).toEqual([
      "overview",
      "collect-values-identity",
      "collect-values-destinations",
      "test",
      "finish",
      "first-message",
    ]);
    expect(step("collect-values-destinations").title).toBe("Where should messages go?");
  });

  it("says in plain words that this channel only sends (item 6)", () => {
    expect(step("overview").body).toContainEqual({
      kind: "note",
      tone: "warning",
      text: "This channel only sends. It can't receive replies.",
    });
    expect(wizardText()).not.toMatch(/narrow outbound lane|parity|send path/iu);
  });

  it("says what the channel does, to one user, in plain words", () => {
    expect(paragraphs("overview")[0]).toBe(
      "GoatCitadel sends text messages from your Zalo Official Account to one Zalo user: the default OA user ID.",
    );
  });

  it("says in the intro that this channel sends text and does not support attachments (R48)", () => {
    expect(paragraphs("overview")).toContain("This channel sends text. Attachments aren't supported.");
  });

  it("says Zalo only lets an Official Account message people who interacted with it recently, and what to do first (item 3)", () => {
    expect(paragraphs("overview")).toContain(
      "Zalo lets an Official Account message only people who interacted with it in the last 7 days, for example by messaging it. Before you start, send your Official Account a message from the recipient's Zalo.",
    );
  });

  it("warns how long a token lasts, that GoatCitadel doesn't renew it, and where to replace it (N11, R58, item 2)", () => {
    expect(step("overview").body).toContainEqual({
      kind: "note",
      tone: "warning",
      text: "A Zalo access token lasts about 25 hours, and GoatCitadel doesn't renew it. When sending stops working, paste a new token in Edit setup.",
    });
  });

  it("tells the person where the Zalo host gets allowed, not just that it must be (items 4, A3)", () => {
    expect(step("overview").body).toContainEqual({
      kind: "note",
      tone: "info",
      text: "GoatCitadel can reach Zalo only once openapi.zalo.me is in the hosts GoatCitadel may reach. The setup test has an Allow these hosts button for that.",
    });
  });

  it("hides the setup-only intro when a saved connection is changed", () => {
    expect(step("overview").createOnly).toBe(true);
    expect(guide().definition.wizard.steps.filter((candidate) => candidate.createOnly)).toHaveLength(1);
  });
});

describe("Zalo OA setup guide: where each value comes from (items 1, 2, 6, A5)", () => {
  it("puts the pasted access token ahead of its variable name, then the recipient on the next step", () => {
    expect(fieldKeys("collect-values-identity")).toEqual(["accessToken", "accessTokenEnv"]);
    expect(fieldKeys("collect-values-destinations")).toEqual(["defaultRecipientId"]);
  });

  it("asks for the pasted access token first, with the shared wording (R39)", () => {
    const token = field("accessToken");

    expect(token.type).toBe("secret");
    expect(token.label).toBe("Access token");
    expect(token.required).toBe(false);
    expect(token.sensitive).toBe(true);
    expect(token.advanced).not.toBe(true);
    expect(token.explanation).toBe("Paste it here. GoatCitadel keeps it in this computer's secure storage.");
  });

  it("says where to get the access token, using the steps on Zalo's own page, and links it (item 2)", () => {
    expect(field("accessToken").whereToFind).toEqual([
      {
        kind: "paragraph",
        text: "On developers.zalo.me open API Explorer. Choose your app, set the token type to OA Access Token, choose your Official Account, allow the permissions it asks for, and copy the access token. You need to be an admin of the Official Account or of the app.",
      },
      {
        kind: "paragraph",
        text: "Your Zalo app needs permission to send messages and notifications through the Official Account.",
      },
      {
        kind: "paragraph",
        text: "A Zalo access token lasts about 25 hours, and GoatCitadel doesn't renew it. When sending stops working, paste a new one in Edit setup.",
      },
      {
        kind: "link",
        label: "Zalo docs: get an access token",
        href: "https://developers.zalo.me/docs/official-account/bat-dau/xac-thuc-va-uy-quyen-cho-ung-dung-new",
        external: true,
      },
    ]);
  });

  it("keeps the variable name under Advanced, with the shared name rule (A5)", () => {
    const env = field("accessTokenEnv");

    expect(env.advanced).toBe(true);
    expect(env.label).toBe("Access token from an environment variable (advanced)");
    expect(env.explanation).toBe(
      "Name of the env var that stores the Zalo access token. The variable's name must start with ZALO_ (for example ZALO_ACCESS_TOKEN). Set it where GoatCitadel starts, then restart GoatCitadel.",
    );
    expect(env.looksLike).toBe("ZALO_ACCESS_TOKEN");
  });

  it("gives an example variable name the Gateway really accepts, and the name rule is true", () => {
    // Zalo only sends, so no inbound-webhook suffix rule applies: the name only has to start with ZALO_.
    expect(isPermittedIntegrationSecretEnvVarName("ZALO_ACCESS_TOKEN", "channel.zalo")).toBe(true);
    expect(isPermittedIntegrationSecretEnvVarName("ACCESS_TOKEN", "channel.zalo")).toBe(false);
  });

  it("asks for the recipient, says what it is and that GoatCitadel can't look it up (item 1)", () => {
    const recipient = field("defaultRecipientId");

    expect(recipient.label).toBe("Default OA user ID");
    expect(recipient.required).toBe(true);
    expect(recipient.explanation).toBe("The user_id of the Zalo user who should get messages.");
    expect(recipient.whereToFind).toEqual([
      {
        kind: "paragraph",
        text: "This is the user_id Zalo's Official Account API gives for a person. Get it from the API's user list or user details call, with an access token that may manage user information. GoatCitadel can't look it up for you.",
      },
      {
        kind: "paragraph",
        text: "The person must have interacted with your Official Account in the last 7 days, for example by messaging it. A user_id belongs to one Official Account, so use one from the Official Account your token is for.",
      },
      { kind: "paragraph", text: "If you can't get this ID, this channel can't be finished." },
      {
        kind: "link",
        label: "Zalo docs: get the user list",
        href: "https://developers.zalo.me/docs/official-account/quan-ly/quan-ly-thong-tin-nguoi-dung/truy-xuat-danh-sach-nguoi-dung",
        external: true,
      },
    ]);
  });

  it("shows Zalo's own example user_id, not the made-up 'zalo-oa-user-id' (item 1)", () => {
    expect(field("defaultRecipientId").looksLike).toBe(USER_ID);
    expect(wizardText()).not.toMatch(/zalo-oa-user-id/u);
  });

  it("asks for an access token (either form) and the recipient, nothing else (Continue)", () => {
    expect(continueBlockers({})).toEqual(["Access token", "Default OA user ID"]);
  });
});

describe("Zalo OA setup guide: the test and finishing (items 3, 6, R49)", () => {
  it("says what the test sends, that it stays, and what Zalo requires of the recipient and charges", () => {
    expect(paragraphs("test")).toEqual([
      'The test sends one message to your default OA user ID. It starts with "[GoatCitadel Zalo probe". The test doesn\'t delete it, so check that it arrived in their Zalo.',
      "Zalo only lets an Official Account message people who interacted with it in the last 7 days. If Zalo refuses, send your Official Account a message from the recipient's Zalo and run the test again. Zalo may charge for a message sent more than 48 hours after the person last interacted.",
    ]);
  });

  it("finishes by saving the connection, and says to check the test message (item 6)", () => {
    expect(paragraphs("finish")).toEqual(["Finalize saves the outbound connection. Check the test message arrived."]);
  });

  it("lists only what the test or the person can check: no 'confirmed delivery manually', no 'sandbox'", () => {
    expect(step("finish").successCriteria).toEqual([
      "Zalo accepted the test message for your default OA user ID.",
      "The test message arrived in the recipient's Zalo.",
    ]);
    expect(wizardText()).not.toMatch(/confirmed delivery manually|manual confirmation closes the loop/u);
  });
});

describe("Zalo OA setup guide: when the test fails (A13)", () => {
  const items = () => step("test").troubleshooting ?? [];
  const body = (id: string) => items().find((item) => item.id === id)?.body ?? "";
  const title = (id: string) => items().find((item) => item.id === id)?.title ?? "";

  it("lists the failures a Zalo setup really hits, on the test step", () => {
    expect(items().map((item) => item.id)).toEqual([
      "token-refused",
      "cant-message-person",
      "app-not-allowed",
      "variable-not-found",
      "cant-reach-zalo",
      "nothing-arrived",
    ]);
  });

  it("matches what the test says when Zalo refuses the access token", async () => {
    const { live } = await refusedWith(TOKEN_INVALID).verdictOf(savedValues());
    const said = live.checks.map((check) => check.message).join("\n");

    expect(title("token-refused")).toBe("It says Zalo refused the access token");
    expect(said).toContain("Zalo refused the access token");
    expect(body("token-refused")).toBe(
      "The token may have expired, or it belongs to another app or Official Account. Get a new access token the same way as before, paste it again, and run the test again. If you used an environment variable, see the item about a missing token below.",
    );
  });

  it("matches what the test says when Zalo won't let the Official Account message that person", async () => {
    const { live } = await refusedWith(NOT_INTERACTED).verdictOf(savedValues());
    const said = live.checks.map((check) => check.message).join("\n");

    expect(title("cant-message-person")).toBe("It says Zalo won't let your Official Account message that person yet");
    expect(said).toContain("Zalo won't let your Official Account message that person yet");
    expect(body("cant-message-person")).toBe(
      "Zalo only lets an Official Account message people who interacted with it in the last 7 days, and not people who blocked it. Send your Official Account a message from the recipient's Zalo, then run the test again. A user_id belongs to one Official Account, so check that yours comes from the Official Account your token is for.",
    );
  });

  it("matches what the test says when Zalo says the app can't send for this Official Account", async () => {
    const { live } = await refusedWith(API_NOT_REGISTERED).verdictOf(savedValues());
    const said = live.checks.map((check) => check.message).join("\n");

    expect(title("app-not-allowed")).toBe("It says your app can't send messages for this Official Account");
    expect(said).toContain("your app can't send messages for this Official Account");
    expect(body("app-not-allowed")).toBe(
      "On developers.zalo.me check that your app has the permission to send messages and notifications through the Official Account, and that the Official Account has allowed the app. Then get a new access token and paste it again.",
    );
  });

  it("gives the variable name rule and the restart", () => {
    expect(title("variable-not-found")).toBe(
      "It says the Zalo access token is missing, and you used an environment variable",
    );
    expect(body("variable-not-found")).toBe(
      "A variable's name must start with ZALO_ (for example ZALO_ACCESS_TOKEN), and you must restart GoatCitadel after you set it. Or paste the access token instead.",
    );
  });

  it("matches what the structural check says when the variable isn't set", () => {
    const config = guide().normalize(
      draftOf({ accessTokenEnv: "ZALO_ACCESS_TOKEN_NOT_SET", defaultRecipientId: USER_ID }),
    );
    const auth = buildIntegrationConnectionChecks(port(), connectionOf(config)).find((check) => check.key === "auth");

    expect(auth).toEqual({ key: "auth", status: "fail", message: "Zalo access token is missing." });
  });

  it("matches what the test says when Zalo can't be reached", async () => {
    const { live } = await unreachable.verdictOf(savedValues());

    expect(title("cant-reach-zalo")).toBe("It says it couldn't reach Zalo");
    expect(live.checks.map((check) => check.message)).toEqual(["Test message: Couldn't reach Zalo: socket hang up"]);
    expect(body("cant-reach-zalo")).toBe(
      "Check that this computer is online and can reach openapi.zalo.me, then run the test again.",
    );
  });

  it("points a message that never shows up at the user_id, the Official Account and a block", () => {
    expect(title("nothing-arrived")).toBe("The test passed but nothing arrived in Zalo");
    expect(body("nothing-arrived")).toBe(
      "Check that the Default OA user ID is the person you meant, for the Official Account your token is for, and that they haven't blocked your Official Account.",
    );
  });
});

describe("Zalo OA setup guide: asking for what is missing (A15)", () => {
  it("asks for the access token, and jumps to the pasted field", () => {
    expect(guide().validate(draftOf({ defaultRecipientId: USER_ID }))).toEqual([
      expect.objectContaining({
        key: "zalo_auth_missing",
        fieldKey: "accessToken",
        level: "error",
        message: "Paste the Zalo access token.",
        failureCategory: "missing_input",
      }),
    ]);
  });

  it("does not ask when a pasted token, a variable name or a saved token is there", () => {
    const saved = draftOf(
      { defaultRecipientId: USER_ID },
      { hydration: { status: "opaque-secret", fieldState: { accessToken: "configured" }, warnings: [] } },
    );

    expect(guide().validate(draftOf(VALUES))).toEqual([]);
    expect(guide().validate(draftOf({ accessTokenEnv: "ZALO_ACCESS_TOKEN", defaultRecipientId: USER_ID }))).toEqual([]);
    expect(guide().validate(saved)).toEqual([]);
  });

  it("still asks for the recipient, in the words of its label, and keeps asking: no one can finish without it (item 1)", () => {
    expect(guide().validate(draftOf({ accessToken: ACCESS_TOKEN }))).toEqual([
      expect.objectContaining({
        key: "defaultRecipientId_required",
        fieldKey: "defaultRecipientId",
        level: "error",
        message: "Default OA user ID is required.",
        failureCategory: "missing_input",
      }),
    ]);
    expect(guide().validate(draftOf({ accessToken: ACCESS_TOKEN, defaultRecipientId: "   " }))).toHaveLength(1);
  });
});

describe("Zalo OA: can it finish?", () => {
  it("lets Continue pass with an access token and a user ID, and asks for nothing else", () => {
    expect(continueBlockers(VALUES)).toEqual([]);
    expect(guide().validate(draftOf(VALUES))).toEqual([]);
  });

  it("is cleared by the setup test once Zalo accepts the message, and the message is the one the guide describes", async () => {
    const config = guide().normalize(draftOf(VALUES));
    const { issues, live, deps, eligibility } = await accepting.verdictOf(config);
    const send = vi.mocked(deps.fetchWithDiagnosticsTimeout).mock.calls[0];
    const sent = JSON.parse(String(send?.[1]?.body)) as { recipient: { user_id: string }; message: { text: string } };

    expect(config).toEqual(VALUES);
    expect(vi.mocked(deps.fetchWithDiagnosticsTimeout)).toHaveBeenCalledTimes(1);
    expect(send?.[0]).toBe(ENDPOINT);
    expect(send?.[1]?.headers).toMatchObject({ access_token: ACCESS_TOKEN });
    expect(sent.recipient).toEqual({ user_id: USER_ID });
    expect(sent.message.text).toContain("[GoatCitadel Zalo probe");
    expect(paragraphs("test")[0]).toContain('It starts with "[GoatCitadel Zalo probe"');
    expect(live.probe?.steps).toEqual([
      expect.objectContaining({
        key: "zalo_sandbox_send",
        status: "pass",
        label: "Test message",
        message: "Zalo accepted the test message. Check that it arrived.",
        providerMessageId: "msg-1",
      }),
    ]);
    expect(issues).toEqual([]);
    expect(eligibility).toMatchObject({ allowed: true, blockingReasons: [] });
  });

  it("never deletes the test message, so asking the person to check it is true (R49)", async () => {
    const { deps } = await accepting.verdictOf(guide().normalize(draftOf(VALUES)));
    const methods = vi.mocked(deps.fetchWithDiagnosticsTimeout).mock.calls.map(([, init]) => init?.method);

    expect(methods).toEqual(["POST"]);
    expect(paragraphs("test")[0]).toContain("The test doesn't delete it, so check that it arrived");
  });

  it("holds Finalize back until openapi.zalo.me is on the network allowlist, though the test reaches Zalo (C7)", async () => {
    const blocked = guideFinish("channel.zalo", { fetch: zalo(), networkAllowlist: ["discord.com"] });

    const { live, issues, eligibility } = await blocked.verdictOf(guide().normalize(draftOf(VALUES)));

    // The test fetcher allows any public host, so Zalo answers; the real send would be blocked, so the check says so.
    expect(live.probe?.steps.map((step) => step.status)).toEqual(["pass"]);
    expect(issues).toEqual([
      {
        key: "provider_hosts",
        level: "warn",
        message:
          "Real sends need openapi.zalo.me on the network allowlist. Use Allow these hosts in the guide, or add it in Settings.",
        disposition: "blocking",
      },
    ]);
    expect(eligibility.allowed).toBe(false);
    expect(eligibility.blockingReasons).toEqual([
      "Real sends need openapi.zalo.me on the network allowlist. Use Allow these hosts in the guide, or add it in Settings.",
    ]);
    // Allow the host, as the button does, and the same connection can finish.
    const allowed = guideFinish("channel.zalo", {
      fetch: zalo(),
      networkAllowlist: ["discord.com", "openapi.zalo.me"],
    });
    expect((await allowed.verdictOf(guide().normalize(draftOf(VALUES)))).eligibility.allowed).toBe(true);
  });

  it("holds Finalize back for a refused or expired access token, says so plainly, and the guide names the fix", async () => {
    for (const refusal of [TOKEN_INVALID, TOKEN_EXPIRED]) {
      const { live, eligibility } = await refusedWith(refusal).verdictOf(guide().normalize(draftOf(VALUES)));

      expect(live.probe?.steps[0], String(refusal.error)).toMatchObject({
        status: "fail",
        label: "Test message",
        message: `Zalo refused the access token (error ${refusal.error}). It may have expired. Paste a new access token and run the test again.`,
        failureCategory: "credential_rejected",
      });
      expect(eligibility.allowed).toBe(false);
      expect(eligibility.blockingReasons.join("\n")).toContain("Zalo refused the access token");
    }
    expect(step("test").troubleshooting?.map((item) => item.id)).toContain("token-refused");
  });

  it("holds Finalize back while the person hasn't interacted with the Official Account, and the guide says what to do (item 3)", async () => {
    for (const refusal of [NOT_INTERACTED, NOT_FOLLOWED, INTERACTION_EXPIRED]) {
      const { live, eligibility } = await refusedWith(refusal).verdictOf(guide().normalize(draftOf(VALUES)));

      expect(live.probe?.steps[0], String(refusal.error)).toMatchObject({
        status: "fail",
        label: "Test message",
        message: `Zalo won't let your Official Account message that person yet (error ${refusal.error}). Zalo only allows messages to people who interacted with it in the last 7 days. Send your Official Account a message from their Zalo, then run the test again.`,
        failureCategory: "destination_mismatch",
      });
      expect(eligibility.allowed, String(refusal.error)).toBe(false);
    }
    // That is the way out: once the person has messaged the Official Account, the same Zalo lets the setup finish.
    expect((await accepting.verdictOf(guide().normalize(draftOf(VALUES)))).eligibility.allowed).toBe(true);
    expect(paragraphs("test")[1]).toContain(
      "send your Official Account a message from the recipient's Zalo and run the test again",
    );
  });

  it("holds Finalize back when the app may not send for this Official Account, and the guide names the fix", async () => {
    for (const refusal of [API_NOT_REGISTERED, OA_NOT_AUTHORIZED]) {
      const { live, eligibility } = await refusedWith(refusal).verdictOf(guide().normalize(draftOf(VALUES)));

      expect(live.probe?.steps[0], String(refusal.error)).toMatchObject({
        status: "fail",
        message: `Zalo says your app can't send messages for this Official Account (error ${refusal.error}). Check the app's permission to send messages on developers.zalo.me.`,
        failureCategory: "permission_mismatch",
      });
      expect(eligibility.allowed).toBe(false);
    }
  });

  it("passes any other refusal on in Zalo's own words, so nothing is hidden", async () => {
    const { live, eligibility } = await refusedWith(USER_BLOCKED).verdictOf(guide().normalize(draftOf(VALUES)));

    expect(live.probe?.steps[0]).toMatchObject({
      status: "fail",
      label: "Test message",
      message: "User has blocked invitation from OA",
    });
    expect(eligibility.allowed).toBe(false);
  });

  it("sends the test message through Zalo's current message API, which only the real call can reach (R57)", async () => {
    // The fake Zalo answers only /v3.0/oa/message/cs and 404s everything else, so a probe that still called the shut-down
    // v2.0/oa/message would fail here. The real send (comms-executor) is pinned to the same URL in
    // comms-executor-zalo-endpoint.test.ts.
    const { deps, eligibility } = await accepting.verdictOf(guide().normalize(draftOf(VALUES)));
    const urls = vi.mocked(deps.fetchWithDiagnosticsTimeout).mock.calls.map(([url]) => url);

    expect(urls).toEqual(["https://openapi.zalo.me/v3.0/oa/message/cs"]);
    expect(ENDPOINT).toBe("https://openapi.zalo.me/v3.0/oa/message/cs");
    expect(eligibility.allowed).toBe(true);
  });

  it("holds Finalize back and shows Zalo's own words when Zalo says the message API has been shut down (-240)", async () => {
    const { live, eligibility } = await refusedWith(SHUT_DOWN).verdictOf(guide().normalize(draftOf(VALUES)));

    expect(live.probe?.steps[0]).toMatchObject({ status: "fail", label: "Test message", message: SHUT_DOWN.message });
    expect(live.checks.map((check) => check.message)).toEqual([`Test message: ${SHUT_DOWN.message}`]);
    expect(eligibility.allowed).toBe(false);
    expect(eligibility.blockingReasons.join("\n")).toContain("MessageV2 API has been shut down");
  });

  it("holds Finalize back when Zalo can't be reached, in words the guide matches", async () => {
    const { live, eligibility } = await unreachable.verdictOf(guide().normalize(draftOf(VALUES)));

    expect(live.probe?.steps[0]).toMatchObject({
      status: "warn",
      label: "Test message",
      message: "Couldn't reach Zalo: socket hang up",
      failureCategory: "platform_unavailable",
    });
    expect(eligibility.allowed).toBe(false);
  });

  it("can't send without a user ID, and says so in the words of its label", async () => {
    const config = { accessToken: ACCESS_TOKEN };
    const { live, deps, eligibility } = await accepting.verdictOf(config);
    const structural = buildIntegrationConnectionChecks(port(), connectionOf(config)).find(
      (check) => check.key === "target",
    );

    expect(vi.mocked(deps.fetchWithDiagnosticsTimeout)).not.toHaveBeenCalled();
    expect(live.probe?.steps[0]).toMatchObject({
      status: "fail",
      message: "Default OA user ID is missing.",
      failureCategory: "missing_input",
    });
    expect(structural).toEqual({ key: "target", status: "warn", message: "Default OA user ID is missing." });
    expect(eligibility.allowed).toBe(false);
  });

  it("asks this path to tick nothing: the guide has no checklist boxes at all (R50)", () => {
    // Continue is blocked until every checklist box is ticked. Zalo needs nothing set up on this page that the person
    // can't do in Zalo first, so a box would only ask for a step this path doesn't need.
    const boxes = guide().definition.wizard.steps.flatMap((candidate) => candidate.checklist ?? []);

    expect(boxes).toEqual([]);
  });

  it("still tells the operator that attachments aren't supported", () => {
    const attachments = buildIntegrationConnectionChecks(port(), connectionOf(guide().normalize(draftOf(VALUES)))).find(
      (check) => check.key === "attachments",
    );

    expect(attachments).toEqual({
      key: "attachments",
      status: "pass",
      message: "This channel sends text. Attachments aren't supported.",
    });
  });

  it("is also cleared when the access token is a variable name rather than a pasted token", () => {
    const config = guide().normalize(draftOf({ accessTokenEnv: "ZALO_ACCESS_TOKEN", defaultRecipientId: USER_ID }));
    const previous = process.env.ZALO_ACCESS_TOKEN;
    process.env.ZALO_ACCESS_TOKEN = ACCESS_TOKEN;
    try {
      const structural = buildIntegrationConnectionChecks(port(), connectionOf(config));

      expect(structural.filter((check) => check.status !== "pass")).toEqual([]);
    } finally {
      if (previous === undefined) delete process.env.ZALO_ACCESS_TOKEN;
      else process.env.ZALO_ACCESS_TOKEN = previous;
    }
  });

  it("has no receiving path to finish: no sender step, no access-mode choice and nothing in the saved config", () => {
    const config = guide().normalize(draftOf({ ...VALUES, inboundAccessMode: "open_legacy", allowedSenders: ["u1"] }));

    expect(stepIds()).not.toContain("sender-access");
    expect(config).not.toHaveProperty("inboundAccessMode");
    expect(guide().definition.wizard.inboundWebhook).toBeUndefined();
  });

  it("does not make an edit replay the setup-only intro, and still asks for both values", () => {
    expect(continueBlockers(VALUES, "edit")).toEqual([]);
    expect(continueBlockers({}, "edit")).toEqual(["Access token", "Default OA user ID"]);
  });
});
