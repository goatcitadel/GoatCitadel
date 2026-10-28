# Settings Channel Guide Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every Settings › Channels setup guide one a person can finish, and make a finished channel actually send and receive.

**Architecture:** Four PRs, in this order:
1. **PR 1, saved keys:** sends and signature checks read a pasted key's real value, not its secure-storage reference. This is runtime bug C1, pulled forward; see "Order".
2. **PR 2, shared fixes (Part A):** what both Settings guide components show and do. Those are Cockpit `ChannelDraftEditor`, Classic `ChannelSetupWizard`, and their shared `useChannelWizard` / `channel-wizard-model`.
3. **PR 3, each guide (Part B):** each guide's definition and the shared guide builder `guided-journey.ts`.
4. **PR 4, the remaining runtime bugs (Part C).** Each starts with a failing test.

**Tech Stack:** TypeScript, React 19 + TanStack Query (Mission Control Next), Fastify gateway, `@goatcitadel/policy-engine` tool executor, Vitest, pnpm monorepo on Windows.

**Spec:** `docs/superpowers/specs/2026-10-27-channel-guide-audit.md`, a copy of the fix ledger that four read-only audits produced. Copy it in from the worktree's `artifacts/guide-audit/FIX-LEDGER.md` in PR 1's first commit. Section names below (`A3`, `Part B › Slack 4`, `C2`, `N3`) refer to it.

Operator rulings (2026-10-27):
- "replace all the older guides if they're wrong";
- "shared fixes first (show prerequisites, show the webhook address, offer missing hosts like the Telegram page does, editing skips the setup steps), then the per-guide fixes, then confirm and fix the runtime bugs. One PR per part."

## Order

The operator's order is A, then B, then C. **PR 1 pulls C1 forward, pending the operator's OK.**
- **Why:** pasted keys are saved as `keychain:goatcitadel:channel-connection:…` references, and the send path uses that text as the key. A Telegram bot set up in Chat › Messaging receives (polling resolves the reference) but cannot reply.
- **Evidence:**
  - `comms-executor.ts:101,116` loads the connection from storage;
  - `secretFrom` at `:4828` returns the stored value;
  - nothing in `packages/policy-engine` or `packages/storage` resolves channel references.
- **Effect on the plan:** Part B's "paste the key here" changes (spec A5) must not ship before C1. If the operator declines, PR 1 becomes the first task of PR 4 and Part B's B1 waits for it.

## Global Constraints

- **Official APIs only.** Use official vendor APIs and nothing that can get an account banned. Signal (signal-cli) and iMessage (BlueBubbles) were retired on 2026-10-28 (N1).
- **Local-first.** There is no hosted relay. GoatCitadel does not know its public web address (that setting is plan 4), so no copy may claim or guess one.
- **Operator copy:**
  - Use short plain sentences.
  - Don't use "posture", "provenance", "ingress", "egress", "sandbox message" or "activation plan".
  - Text marked "(unverified)" in the spec ships only after it is checked against the vendor.
  - `scripts/check-mission-control-next-cockpit-copy.mjs` must pass.
- **No new live regions.** `LIVE_REGION_BUDGET` is 896 (`scripts/check-mission-control-next-cockpit-semantics.mjs`), and callouts use `announce={false}`.
- **Hosts are added only by an operator click.** The click must be on a button that names the host, through `ensureHostsAllowed` (a `runtime_configuration` / `network_allowlist` change plan), never silently. The operator chose "offer missing hosts like the Telegram page does", which approves that one plan in place. Deny-wins policy, the gateway's network guard and approvals stay authoritative.
- **Secrets stay in memory.** A resolved secret never reaches config, logs, receipts, evidence, realtime payloads or errors. It is resolved in memory for the one send or check.
- **Contracts rebuild.** After changing `packages/contracts`, run `pnpm --filter @goatcitadel/contracts build` before Mission Control or policy-engine tests, because they read `dist`.
- **Architecture metrics.**
  - Never run `architecture:baseline:update`.
  - Prefer existing files.
  - A new gateway service file over the metrics thresholds needs an operator-approved C0 allowance; stop and ask.
- **Repo hygiene.**
  - Run Prettier only on files you touch; the pre-commit hook formats staged files.
  - Never `git stash`.
  - No personal paths in tracked files.
- **Heavy commands** run at below-normal priority. Use Vitest with `--maxWorkers=2`, and one heavy job at a time.
- **Settings › Channels visual baselines** (`visual-regression-settings-channels-*`) capture the Classic page. A visible change there needs `gh workflow run visual-rebaseline.yml --ref <branch> -f route_slugs=settings-channels`, then a cherry-pick of its `chore/visual-rebaseline-<run>` branch.
- **Branching.** Each PR branches from `origin/main` after the previous one merges; PR 1 also follows #608.

## Decisions (spec "Needs the operator")

Each has a recommended default; the plan follows it unless the operator says otherwise. N1 had no default; the operator decided it on 2026-10-28.

| | Question | Default used by this plan | Gates |
|---|---|---|---|
| N1 | Signal and iMessage are unofficial clients | Retired 2026-10-28 (operator): Signal and iMessage removed like Zalo personal (#602); see PR 3. C8 is moot. | B15, C8 |
| N2 | WhatsApp test message | keep plain text; the guide says to message the business number first | C4 (copy only) |
| N3 | Google Chat app mode can't be live-checked | let it finish with an advisory "message the app after you finish" | C2 (b) |
| N4 | Connection id before Finalize | reuse the draft id as the connection id | C3 |
| N5 | Put the sender id in the dropped-message diagnostic | yes (local, operator's own data) | C9, B1 sender help |
| N6 | Every edit re-sends a test message | keep as is (out of scope) | — |
| N7 | Slack OAuth in Settings | keep as an advanced option that names the four Gateway settings it needs | B3 |
| N8 | Plain `http://` to a LAN server | keep "https, or this computer only", and say so | B1 (A10) |
| N9 | ntfy receiving on public ntfy.sh | warn only | B11 |
| N10 | Default to "chat with my bot" | keep current defaults | — |
| N11 | Zalo token lifetime | Changed (Ruling R58): the access token was checked at about 25 hours (Zalo's auth page: https://developers.zalo.me/docs/official-account/bat-dau/xac-thuc-va-uy-quyen-cho-ung-dung-new). The guide says so and says to paste a new one in Edit setup. GoatCitadel doesn't renew it. | B14 |

## Review Focus

1. **A host field with a loopback, private or schemeless address** (`127.0.0.1:8080`, `ntfy.example.com`). The hosts check must not throw. A schemeless or unparsable value names no host. A loopback or private host is listed like any other, and is only ever added by the operator's click.
2. **Editing a saved channel whose guide is all setup steps.** The guide still shows at least one step, never an empty list.
3. **A saved reference for another connection, or one the store can't return.** The send fails with "The saved <channel> credential is unavailable from secure storage." It never sends the reference text, and never uses another connection's secret.
4. **A connection id that needs escaping.** The webhook path encodes it once.
5. **Telegram on polling** shows no webhook address; on web-address delivery it does.

---

## PR 1 — Saved keys reach sends and checks (spec C1; branch `fix/channel-saved-keys`)

### Task 1.1: Sends resolve this connection's saved keys

**Files:**
- Modify: `packages/policy-engine/src/tool-executor/comms-executor.ts`. Add a runtime hook to the comms runtime hooks type (`:64-70`). In `executeCommsToolWithBoundaryTracking`, resolve the config before the provider call (`:157`).
- Modify: `packages/policy-engine/src/tool-executor.ts` (the executor's runtime hooks, `~:160`), which passes the hook through.
- Modify: `apps/gateway/src/services/gateway-service.ts` (`~:1474`, beside `resolveApprovalActionTokenSecret`), which supplies the hook using the same `parseChannelSecretRef` + `secretStore.getSecret` steps as `resolveConnectionSecret` (`:12037-12057`).
- Test: `packages/policy-engine/src/tool-executor/comms-executor-secret-refs.test.ts` (create; pattern: `comms-executor-boundary.test.ts`).
- Create: `docs/superpowers/specs/2026-10-27-channel-guide-audit.md` (the ledger copy). Replace any absolute paths with repo-relative ones.

**Interfaces:**
- Produces: `resolveChannelConnectionSecret?: (secretRef: string) => string | undefined` on the comms runtime hooks.
- Behavior:
  - Before the provider call, every string value in the connection config that starts with `keychain:goatcitadel:channel-connection:<this connectionId>:` is replaced, in a copy held in memory only, by the hook's result.
  - A value naming another connection, or any other `keychain:goatcitadel:` reference, is never sent and never resolved: the send fails before any request with `The saved <channel label> credential is unavailable from secure storage.`
  - A reference with no hook or no stored value fails the same way, before any request.
  - Config values that aren't references are untouched.

- [ ] **Step 1: Write the failing tests.**
  - **Zalo:** a channel connection (enabled, connected) `conn-1` with config `{ accessToken: "keychain:goatcitadel:channel-connection:conn-1:accessToken:00000000-0000-4000-8000-000000000000", defaultRecipientId: "123" }` and allowlist `["openapi.zalo.me"]`. Stub `fetch` and record its requests. Call `executeCommsTool` for `channel.send` with `resolveChannelConnectionSecret: () => "real-token"`. Expect the `access_token` header to be `real-token`, and no request URL, header or body to contain `keychain:`.
  - **Telegram:** the same setup with `botToken` and allowlist `["api.telegram.org"]`. Expect the request path to contain `/botreal-token/`.
  - **Missing value:** a hook returning `undefined` makes the send fail with the message above and makes no request.
  - **Another connection's reference:** a reference naming `conn-2` on `conn-1` is never passed to the hook.
- [ ] **Step 2: Run** `& '.\node_modules\.bin\vitest.cmd' run --root 'packages/policy-engine' 'src/tool-executor/comms-executor-secret-refs.test.ts'`. Expected: FAIL (the header carries the reference).
- [ ] **Step 3: Implement** the hook type, the in-memory resolution and the gateway wiring.
- [ ] **Step 4: Run** the test, the policy-engine `tool-executor` suite, and `pnpm --filter @goatcitadel/policy-engine typecheck` and `pnpm --filter @goatcitadel/gateway typecheck`. Expected: PASS, exit 0.
- [ ] **Step 5: Commit** `fix(channels): send with a channel's saved key, not its secure-storage reference`.

### Task 1.2: Inbound signature checks resolve saved keys

**Files:**
- Modify: `apps/gateway/src/services/channel-secret-resolution.ts:94-104` (`readConfigSecret`) and `:21-27` (`resolveTelegramWebhookSecret`). Each takes an optional resolver.
- Modify: `apps/gateway/src/routes/integration-webhooks-shared.ts:60-106`, `integration-webhooks-slack-routes.ts:49`, and the Telegram webhook route. Each passes a resolver backed by `gateway.resolveConnectionSecret`; the route composition already has one, `gateway-route-composition-integrations.ts:88-89`.
- Test: `apps/gateway/src/routes/integrations.webhooks.test.ts`.

- [ ] **Step 1: Write the failing test.** Set up a `nextcloud-talk` connection whose `token` is a `keychain:goatcitadel:channel-connection:<id>:token:<uuid>` reference, with the secret store holding the real secret. Send a webhook signed with the real secret: expect 200. A webhook signed with the reference text: expect 401.
- [ ] **Step 2: Run** `& '.\node_modules\.bin\vitest.cmd' run --root 'apps/gateway' 'src/routes/integrations.webhooks.test.ts'`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the test and the `src/routes/integration-webhooks*` tests. Expected: PASS.
- [ ] **Step 5: Commit** `fix(channels): check signed webhooks against the saved key`.

### Task 1.3: PR 1 proof and PR

- [ ] Run these lanes: policy-engine tests; gateway `src/routes/integration-webhooks*`, `src/services/channel-*`; both typechecks; `git diff --check`.
- [ ] Open PR 1, and tell the operator their live Telegram reply test needs it merged and the local checkout rebuilt.

---

## PR 2 — Shared fixes (Part A; branch `fix/channel-guides-shared`)

### Task A1: Say how each channel is reached, and which steps are only for setting it up

**Files:**
- Modify: `packages/contracts/src/channel-wizard.ts` (`ChannelSetupStepDefinition` `:128-144`, `ChannelSetupWizardContent`)
- Modify: `apps/gateway/src/services/channel-setup-definitions/picker-hints.ts`. Fill `CHANNEL_REQUIRED_HOSTS` and add `CHANNEL_HOST_FIELDS`, `CHANNEL_CONDITIONAL_HOSTS` and `CHANNEL_INBOUND_WEBHOOKS`. `withPickerHints` applies them.
- Modify: each guide in the "setup-only" list below, which gains `createOnly: true` on the named steps.
- Test: `apps/gateway/src/services/channel-setup-definitions/picker-hints.test.ts`, `apps/gateway/src/services/channel-setup-definitions.test.ts`

**Interfaces (produced, contracts):**
```ts
// ChannelSetupStepDefinition
/** Shown only while setting a channel up; hidden when a saved channel is changed. */
createOnly?: boolean;

export interface ChannelSetupHostRule {
  host: string;
  /** Needed only while one of these fields is set (and equals `equals`, when given). */
  whenAnyFieldSet: string[];
  equals?: string | boolean;
}
export interface ChannelSetupInboundWebhook {
  /** The Gateway path the vendor posts to; `{connectionId}` stands for the saved connection's id. */
  pathTemplate: string;
  whenFieldEquals?: { fieldKey: string; value: string | boolean };
}
// ChannelSetupWizardContent
/** Fields holding a URL whose host the channel must be allowed to reach. */
hostFields?: string[];
conditionalHosts?: ChannelSetupHostRule[];
inboundWebhook?: ChannelSetupInboundWebhook;
```

**Host and webhook values.** These come from the code each channel sends through (spec A3): `comms-executor.ts`, `qqbot-client.ts`, `wecom-client.ts`, `google-chat-service-account.ts` and the live probes.

| key | requiredHosts | hostFields | conditionalHosts | inboundWebhook |
|---|---|---|---|---|
| telegram | api.telegram.org | | | when `receiveMode` = `webhook` |
| discord | discord.com | webhookUrl | | |
| slack | slack.com | webhookUrl | | yes |
| whatsapp | graph.facebook.com | | | yes |
| line | api.line.me | | | yes |
| zalo | openapi.zalo.me | | | |
| qqbot | bots.qq.com, api.bot.qq.com | | `sandbox.api.sgroup.qq.com` when `sandbox` = true | yes |
| wecom | qyapi.weixin.qq.com | | | yes |
| google-chat | chat.googleapis.com | webhookUrl | `oauth2.googleapis.com` when `serviceAccountKeyEnv` or `serviceAccountKey` is set (Chat app mode) | yes, when `serviceAccountKeyEnv` or `serviceAccountKey` is set (Chat app mode) |
| teams | | webhookUrl | | |
| ntfy | | baseUrl | | |
| matrix | | homeserverUrl | | |
| mattermost | | serverUrl | | |
| nextcloud-talk | | baseUrl | | yes |
| signal | | baseUrl | | |
| imessage | | bridgeUrl, photonSidecarUrl | | |

`pathTemplate` is `/api/v1/integrations/connections/{connectionId}/<key>/webhook`.

The signal and imessage rows above are retired (2026-10-28, N1) and not applied.

**Setup-only steps** (spec A4), marked explicitly, not by kind:
- the `overview` step of every guide except Telegram;
- Discord: `prerequisites`, `create-bot`, `install-bot`;
- Slack: `prerequisites`;
- Teams and Google Chat: `create-webhook`;
- ntfy: `prepare-topic`.

Telegram's `overview`, "What you can change here", stays visible.

- [ ] **Step 1: Write the failing tests.** In `picker-hints.test.ts`:
  ```ts
  it("says which hosts every guided channel reaches", () => {
    for (const definition of listChannelSetupDefinitions()) {
      const { requiredHosts = [], hostFields = [] } = definition.wizard;
      expect(requiredHosts.length + hostFields.length, definition.catalog.key).toBeGreaterThan(0);
    }
  });
  it("names the webhook path of exactly the channels that have a webhook route", () => {
    const routed = fs.readdirSync(fileURLToPath(new URL("../../routes", import.meta.url)))
      .map((file) => /^integration-webhooks-(.+)-routes\.ts$/u.exec(file)?.[1])
      .filter((key): key is string => Boolean(key)).sort();
    const withWebhook = listChannelSetupDefinitions()
      .filter((definition) => definition.wizard.inboundWebhook)
      .map((definition) => definition.catalog.key).sort();
    expect(withWebhook).toEqual(routed);
    for (const key of withWebhook)
      expect(requireChannelSetupDefinition(`channel.${key}`).definition.wizard.inboundWebhook?.pathTemplate)
        .toBe(`/api/v1/integrations/connections/{connectionId}/${key}/webhook`);
  });
  ```
  - Add one `it` per non-empty table cell with its exact values.
  - In `channel-setup-definitions.test.ts`: for each guide, the ids of steps with `createOnly` equal the list above. Telegram has none.
- [ ] **Step 2: Run** `& '.\node_modules\.bin\vitest.cmd' run --root 'apps/gateway' 'src/services/channel-setup-definitions'`. Expected: FAIL.
- [ ] **Step 3: Implement** the contract fields, the maps and their application, and the flags.
- [ ] **Step 4: Run** the tests. Then run `pnpm --filter @goatcitadel/contracts build` and `pnpm --filter @goatcitadel/gateway typecheck`. Expected: PASS, exit 0.
- [ ] **Step 5: Commit** `feat(channels): say which hosts, webhook path and setup-only steps each channel has`

### Task A2: Work out hosts, the webhook path and the steps to show (shared model + hook)

**Files:**
- Modify: `apps/mission-control-next/src/features/native-routes/settings/channel-setup/channel-wizard-model.ts`
- Modify: `apps/mission-control-next/src/features/native-routes/settings/channel-setup/use-channel-wizard.ts:31-34` (`visibleSteps`)
- Test: `apps/mission-control-next/src/features/native-routes/settings/channel-setup/channel-wizard-model.test.ts` (create)

**Interfaces:**
- Consumes: A1's fields; existing `hasFieldValue(draft, values, key)`, `wizardValuesWithDefaults(definition, values)`, `isStepVisible(step, values)`.
- Produces:
  - `channelHosts(definition: ChannelSetupDefinition, draft: ChannelSetupDraft, values: Record<string, unknown>): string[]`. It returns, in this order, deduped with the first occurrence kept:
    - `requiredHosts`;
    - each `conditionalHosts` rule whose field is set (`hasFieldValue`) and, when `equals` is given, equals it;
    - the lowercase `hostname` of each `hostFields` value (after defaults) that parses as an `http:`/`https:` URL. Anything else names no host.
  - `inboundWebhookPath(definition: ChannelSetupDefinition, values: Record<string, unknown>, connectionId: string | undefined): string | undefined`. It returns `undefined` with no connection id, with no `inboundWebhook`, or when `whenFieldEquals` doesn't match (after defaults). Otherwise it returns the template with `{connectionId}` replaced by `encodeURIComponent(connectionId)`.
  - `isStepForLifecycle(step: ChannelSetupStepDefinition, lifecycleMode: ChannelSetupDraft["lifecycleMode"]): boolean`. It returns `false` only when `lifecycleMode !== "create"` and `step.createOnly`.
  - `useChannelWizard` filters with both `isStepVisible` and `isStepForLifecycle`. If that leaves no step, it uses the steps `isStepVisible` allows.

- [ ] **Step 1: Write the failing tests** (`def(wizard)` / `draft(overrides)` are local fixtures):
  ```ts
  it("lists fixed hosts, hosts of set conditions and hosts of entered addresses, once each", () => {
    const definition = def({ requiredHosts: ["chat.googleapis.com"], hostFields: ["webhookUrl"],
      conditionalHosts: [{ host: "oauth2.googleapis.com", whenAnyFieldSet: ["serviceAccountKeyEnv"] }] });
    expect(channelHosts(definition, draft(), {
      webhookUrl: "https://chat.googleapis.com/v1/spaces/x", serviceAccountKeyEnv: "GOOGLE_CHAT_KEY",
    })).toEqual(["chat.googleapis.com", "oauth2.googleapis.com"]);
  });
  it("names no host for an address it can't read, and lists a loopback bridge", () => {
    const definition = def({ hostFields: ["baseUrl"] });
    expect(channelHosts(definition, draft(), { baseUrl: "ntfy.example.com" })).toEqual([]);
    expect(channelHosts(definition, draft(), { baseUrl: "http://127.0.0.1:8080" })).toEqual(["127.0.0.1"]);
  });
  it("adds a conditional host only when its field equals the value given", () => {
    const definition = def({ conditionalHosts: [{ host: "sandbox.api.sgroup.qq.com", whenAnyFieldSet: ["sandbox"], equals: true }] });
    expect(channelHosts(definition, draft(), { sandbox: false })).toEqual([]);
    expect(channelHosts(definition, draft(), { sandbox: true })).toEqual(["sandbox.api.sgroup.qq.com"]);
  });
  it("gives the webhook path only for a saved connection whose condition holds, escaping the id once", () => {
    const telegram = def({ inboundWebhook: { pathTemplate: "/api/v1/integrations/connections/{connectionId}/telegram/webhook",
      whenFieldEquals: { fieldKey: "receiveMode", value: "webhook" } } });
    expect(inboundWebhookPath(telegram, { receiveMode: "poll" }, "c-1")).toBeUndefined();
    expect(inboundWebhookPath(telegram, { receiveMode: "webhook" }, undefined)).toBeUndefined();
    expect(inboundWebhookPath(telegram, { receiveMode: "webhook" }, "c 1/2"))
      .toBe("/api/v1/integrations/connections/c%201%2F2/telegram/webhook");
  });
  it("hides setup-only steps only when a saved channel is changed", () => {
    expect(isStepForLifecycle({ id: "b", kind: "instruction", title: "B", createOnly: true }, "edit")).toBe(false);
    expect(isStepForLifecycle({ id: "b", kind: "instruction", title: "B", createOnly: true }, "create")).toBe(true);
    expect(isStepForLifecycle({ id: "o", kind: "intro", title: "O" }, "edit")).toBe(true);
  });
  ```
  Add a `useChannelWizard` case: an `edit` draft of a definition whose only non-test steps are `createOnly` still has visible steps.
- [ ] **Step 2: Run** `& '.\node_modules\.bin\vitest.cmd' run --root 'apps/mission-control-next' --maxWorkers=2 'src/features/native-routes/settings/channel-setup/channel-wizard-model.test.ts'`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the test, `ChannelGuidedSetup.test.tsx` and `ChannelSetupWizard.test.tsx`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(settings): work out a channel's hosts, webhook path and setup-only steps`

### Task A3: "What you need" and the editing note, in both guides

**Files:**
- Create: `apps/mission-control-next/src/features/native-routes/settings/channel-setup/ChannelNeeds.tsx` (used by both headers)
- Modify: `apps/mission-control-next/src/cockpit/areas/settings/ChannelDraftEditor.tsx` (header `:36-43`) and `apps/mission-control-next/src/features/native-routes/settings/channel-setup/ChannelSetupWizard.tsx` (header `:79-98`)
- Test: `apps/mission-control-next/src/features/native-routes/settings/channel-setup/ChannelGuidedSetup.test.tsx` (renders both components against the real gateway definitions)

**Copy (exact):**
- Under the summary: a heading `What you need` over the list `definition.wizard.prerequisites`, one item each. No list when it's empty.
- When `draft.lifecycleMode !== "create"`, a line `You're changing {name}. The steps for setting it up are hidden.`, where `{name}` is the connection label, else the catalog label.

- [ ] **Step 1: Write the failing tests.** For each of `ChannelSetupWizard` and `ChannelDraftEditor`, using the real Slack definition:
  - the `What you need` items equal `definition.wizard.prerequisites`;
  - a `create` draft's step list starts with the `overview` step and shows no "You're changing" line;
  - an `edit` draft's step list has no `overview` or `prerequisites` step, and shows `You're changing Slack. The steps for setting it up are hidden.`
- [ ] **Step 2: Run** `ChannelGuidedSetup.test.tsx`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the test and `perf:check` (from `apps/mission-control-next`). Expected: PASS, exit 0.
- [ ] **Step 5: Commit** `feat(settings): show what a channel needs, and skip setup steps when editing`

### Task A4: Check the hosts and offer to allow the missing ones

**Files:**
- Move: `missingHosts`, `useMissingHosts` (`cockpit/areas/chat/channel-setup/use-missing-hosts.ts`) and `ensureHostsAllowed` (from `approve-plan-in-place.ts:141-170`) to `apps/mission-control-next/src/features/native-routes/settings/channel-hosts.ts`. The Chat page imports them from there, and its own tests stay green.
- Create: `apps/mission-control-next/src/features/native-routes/settings/channel-setup/ChannelHostsCheck.tsx`
- Modify: both guides, which render it on the step whose `kind === "test"`, above Validate / Run live test.
- Test: `apps/mission-control-next/src/features/native-routes/settings/channel-setup/ChannelHostsCheck.test.tsx`

**Interfaces:**
- Consumes: A2 `channelHosts`; `HOSTS_UNKNOWN` (`cockpit/areas/chat/channel-setup/TurnOnStep.tsx`).
- Produces: `ChannelHostsCheck({ hosts, workspaceId }: { hosts: readonly string[]; workspaceId: string })`. It renders nothing for an empty list, and adds no live region.

**Copy (exact):**
- **All allowed:** `GoatCitadel may reach {hosts, comma-joined}.`
- **Some missing:** `GoatCitadel can't reach these yet: {missing}. Real messages fail until they're allowed.` A button `Allow these hosts` (loading label `Allowing…`) calls `ensureHostsAllowed(missing, workspaceId, missing)`. On `{ kind: "allowed" }` the allowlist is re-read.
- **Outcome `elsewhere` with `approvalId`:** a link `Approve it in Inbox` to `/inbox?approvalId=…&workspaceId=…`.
- **Outcome `elsewhere` without one:** a link `Review it in Inbox` to `/inbox?item=change_plan:<planId>&workspaceId=…`.
- **Outcome `failed`:** its message. **Outcome `blocked`:** its reasons.
- **While the allowlist read is pending:** nothing, and no button.
- **Read failed:** `HOSTS_UNKNOWN` and `Try again`.

- [ ] **Step 1: Write the failing tests.** Mock `fetchSettings` and `ensureHostsAllowed`.
  - It renders nothing for `[]`.
  - It lists allowed hosts.
  - For `["api.line.me"]` missing, clicking `Allow these hosts` calls `ensureHostsAllowed(["api.line.me"], "default", ["api.line.me"])`. After `allowed` and a re-read, it shows `GoatCitadel may reach api.line.me.`
  - An `elsewhere` outcome with `approvalId: "a-1"` shows `Approve it in Inbox`.
  - A read failure shows `HOSTS_UNKNOWN` and `Try again`, and no Allow button.
  - No `[role="status"]`, `[role="alert"]` or `[aria-live]` in any state.
  - In `ChannelGuidedSetup.test.tsx`, the test step of the real LINE guide shows a hosts line naming `api.line.me`.
- [ ] **Step 2: Run** the tests. Expected: FAIL.
- [ ] **Step 3: Implement** the move, the component, and both placements with `channelHosts(definition, draft, values)` and `scopeId`.
- [ ] **Step 4: Run** the new tests, `src/cockpit/areas/chat/channel-setup` and `ChannelGuidedSetup.test.tsx`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(settings): check a channel's hosts and offer to allow the missing ones`

### Task A5: Show the webhook address

**Files:**
- Create: `apps/mission-control-next/src/features/native-routes/settings/channel-setup/ChannelWebhookAddress.tsx`
- Modify: both guides' `first-message` step, and the saved-connection panels: Cockpit `apps/mission-control-next/src/cockpit/areas/settings/ChannelsSettings.tsx` (above "Connection identity", `~:356`) and Classic `apps/mission-control-next/src/features/native-routes/settings/sections/ChannelsSection.tsx` (above Connection ID, `:377-382`). Each uses the connection's definition from `data.definitions` and `connection.config` as values.
- Test: `ChannelWebhookAddress.test.tsx` (create), `apps/mission-control-next/src/cockpit/areas/settings/ChannelsSettings.test.tsx`, `ChannelGuidedSetup.test.tsx`

**Interfaces:**
- Consumes: A2 `inboundWebhookPath`.
- Produces: `ChannelWebhookAddress({ path }: { path: string })`.

**Copy (exact):**
- Label `Webhook address`.
- Then `https://<your public address>` + the path, in a `<code>`, with a button `Copy` that writes that text with `navigator.clipboard.writeText` and then reads `Copied`.
- Then `GoatCitadel doesn't provide a public address. Put your own HTTPS address (a reverse proxy or tunnel) in front of this Gateway, then give the vendor this address.`
- In the `first-message` step of a create draft for a webhook channel: `You get this address after you finish: Settings › Channels › this connection.` (C3 replaces this line.)

- [ ] **Step 1: Write the failing tests.**
  - The component shows the exact copy. `Copy` writes `https://<your public address>/api/v1/integrations/connections/conn-1/slack/webhook` and turns into `Copied`, without a live region.
  - Cockpit Settings with saved Slack connection `conn-1` selected shows that path.
  - A saved Telegram connection with `receiveMode: "poll"` shows no address; with `"webhook"` it does.
- [ ] **Step 2: Run** them. Expected: FAIL.
- [ ] **Step 3: Implement** the component and its placements.
- [ ] **Step 4: Run** the tests, `ChannelGuidedSetup.test.tsx` and `ChannelSetupWizard.test.tsx`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(settings): show where a channel's vendor sends messages`

### Task A6: Small shared fixes in both guides (spec A9, A14, A16 nav, A17)

**Files:** `channel-wizard-model.ts` (`findMissingFieldLabels` `:87-125`), `apps/gateway/src/services/channel-setup-service.ts:375`, Classic `ChannelSetupWizard.tsx` (nav sub-label `:205`, Finish footer `:283-288`)

**Decisions:**
- **A9:** `findMissingFieldLabels` skips `requiredAnyOf` keys that have no field, and dedupes. "or webhookUrlEnv" never appears.
- **A14:** a passing test's `recommendedNextAction` becomes `Check that the test message arrived, then finalize.` The error branch is unchanged.
- **A16 (Classic nav):** the sub-label under each step shows `channelStageLabel(step)` instead of `humanizeStepKind(step.kind)`.
- **A17 (Classic):** when `finalizeDisabledReason(dirty, feedback)` gives a reason, show it as text under the footer, as Cockpit does (`ChannelDraftEditor.tsx:219-221`).

- [ ] **Step 1: Write the failing tests:**
  - the Slack missing-values message names no key ending in `Env`;
  - a passing test result's next action is the string above;
  - the Classic nav shows `Connect account`, not `field collection`;
  - Classic shows the Finalize reason as text.
- [ ] **Step 2: Run** them. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the gateway channel-setup tests and the Mission Control channel-setup tests. Expected: PASS.
- [ ] **Step 5: Commit** `fix(settings): plainer missing-value, next-step and finalize messages`

### Task A7: PR 2 proof and PR

- [ ] **Lanes:**
  - gateway `src/services/channel-setup*`;
  - Mission Control `src/features/native-routes/settings`, `src/cockpit/areas/settings` and `src/cockpit/areas/chat/channel-setup`;
  - both typechecks and `perf:check`;
  - the Mission Control production build, with no new circular chunk;
  - `git diff --check`.
- [ ] **Browser proof** on the loopback sandbox (`artifacts/channel-quick-setup/scripts/`), light and dark, desktop and phone:
  - a LINE create draft shows `What you need` and the hosts line;
  - editing a saved Slack connection hides its setup steps and shows the editing note and the webhook address.
- [ ] Rebaseline `settings-channels` if the Classic page changed. Open PR 2.

---

## PR 3 — Each guide (Part B; branch `fix/channel-guides-each`)

Each task applies one spec section, `Part B › <Guide>`, in full: its numbered entries, its POSTURE text, its step troubleshooting (A13) and its `fieldKey` on auth-missing issues (A15).
- **Skip, in every task:** entries that point to Part C, and anything a decision gates other than by the default above.
- **Text marked "(unverified)":** ship it only if checked against the vendor's official docs (cite the URL in the commit), else leave it out.
- **Every task's tests:**
  - the guide's POSTURE `introSummary`, `prerequisites` and first-message text equal the spec;
  - each `[blocks]` entry has a test pinning its change (a validation rule, a field's required/advanced/order, a step moved or removed);
  - each `[misleads]` label or explanation change has one exact-string assertion.
- **Tests go in** `apps/gateway/src/services/channel-setup-definitions.test.ts`, or `<channel>.copy.test.ts` beside the guide (pattern: `slack.copy.test.ts`).
- **Run:** `& '.\node_modules\.bin\vitest.cmd' run --root 'apps/gateway' 'src/services/channel-setup-definitions'`.
- **Commit message:** `fix(channels): make the <Guide> setup guide one you can finish`.

### Task B1: The shared guide builder (spec A5, A7, A8, A10, A11, A12, A16 title)

**Files:** `apps/gateway/src/services/channel-setup-definitions/guided-journey.ts`, `apps/gateway/src/services/channel-setup-definitions/common.ts`, `apps/gateway/src/services/channel-setup-definitions.test.ts`

**Decisions (from the spec, exact rules):**
- **A12:** `withGuidedJourney` splits and retitles only the first field-collection step. Later field steps keep their authored id, title and stage, and their fields stay out of the `requiredAnyOf` built at GJ:249-252.
- **A11:** an authored `stage` is kept; only unset stages are derived.
- **A5 (needs PR 1 merged):**
  - every `<secretKey>Env` field, where `secretKey` is in `adapter.secretFieldKeys`, becomes `advanced: true` with the label `<Label> from an environment variable (advanced)`;
  - its explanation ends with `The variable's name must start with {PREFIX}_ (for example {EXAMPLE}). Set it where GoatCitadel starts, then restart GoatCitadel.`;
  - inbound webhook secrets add ` It must also end in _TOKEN or _SECRET.`;
  - `PREFIX` is the catalog key upper-cased with `-` → `_`, and `EXAMPLE` is `PREFIX` + `_` + the field key without `Env` in upper snake case;
  - each pasted-secret field moves first, drops "(manual fallback)", and explains `Paste it here. GoatCitadel keeps it in this computer's secure storage.`
- **A7:** per-key sender explanations, exactly as the spec lists them. `google-chat`, `qqbot` and `wecom` add the A6 sentence once C9 lands.
- **A8:**
  - the inserted sender step gets `visibleWhenFieldEquals` `inboundStreamEnabled = true` for ntfy, matrix and mattermost, and `receiveEvents = true` for signal;
  - forced-allowlist keys have no `inboundAccessMode` field;
  - `open_legacy` is offered only when `draft.hydration.rawLegacyConfig.inboundAccessMode === "open_legacy"`.
- **A10:** a `common.ts` helper `requireSecureUrl(value, fieldKey, label)` applies `connection-url-helpers.ts:13-23`'s rule, with the message `Use https://. Plain http:// works only for this computer (127.0.0.1 or localhost).`
- **A16:** the destinations step of an outbound-only channel is titled `Where should messages go?`

- [ ] **Step 1: Write the failing tests.**
  - Every `…Env` field's example name passes `isPermittedIntegrationSecretEnvVarName(example, catalogId)`.
  - A guide with two field steps keeps the second's authored title.
  - Matrix's sender step is hidden while `inboundStreamEnabled` is false.
  - QQ has no `inboundAccessMode` field.
  - `requireSecureUrl("http://192.168.1.5", …)` gives the error, while `http://127.0.0.1:8080` and `https://x` pass.
  - Zalo's destinations step is titled `Where should messages go?`
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `fix(channels): plainer shared steps in every setup guide`

### Tasks B2–B14: one per guide

Each is one spec section, applied as above. The extra pins below are each guide's `[blocks]` changes.

| Task | Spec section | Extra pins (tests) |
|---|---|---|
| B2 | Part B › Discord (7) | `botToken` before `botTokenEnv`; `guildPolicy` then `inboundDmPolicy` before the id fields; `defaultGuildId` required while guild policy is allowlist; step `webhook-path` gone |
| B3 | Part B › Slack (8) | entries per spec; the OAuth button text per N7 default |
| B4 | Part B › Teams (4) | the owner checkbox per spec |
| B5 | Part B › Google Chat (9) | mode field per spec (A8 visibility keys off it) |
| B6 | Part B › WhatsApp (7) | access-token where-to-find; first-message says to message the business first (N2 default) |
| B7 | Part B › LINE (6) | user-ID where-to-find ("Your user ID", Basic settings); new "Receive messages (optional)" step keeps its title (A12) |
| B8 | Part B › Matrix (7) | per spec |
| B9 | Part B › Mattermost (6) | per spec |
| B10 | Part B › Nextcloud Talk (10) | the bot-install steps; webhook address copy waits for C3 |
| B11 | Part B › ntfy (7) | ntfy.sh receiving warning (N9 default) |
| B12 | Part B › QQ Bot (8) | the `webhook` step removed per spec; sender help per A7 |
| B13 | Part B › WeCom (8) | the `webhook` step removed per spec; the trusted-IP prerequisite; 60020/81013 troubleshooting |
| B14 | Part B › Zalo OA (6) | the token note; it states the verified lifetime of about 25 hours (R58) |

New vendor-setup steps a guide adds are `createOnly: true` (A4).

### Task B15: Signal and iMessage (N1: retired)

Apply `Part B › Signal` and `Part B › iMessage` only if N1 keeps them. If N1 hides or retires them, follow the operator's ruling instead (for retiring, the pattern is PR #602, which removed Zalo personal).

**Decided 2026-10-28:** retire both, like Zalo personal. Their Part B entries are not applied.

### Task B16: PR 3 proof and PR

- [ ] **Lanes:** gateway `src/services/channel-setup*`, `src/services/integration-diagnostics*`; Mission Control `ChannelGuidedSetup.test.tsx`; the gateway typecheck; `docs:check`; `git diff --check`.
- [ ] **Browser proof** of three edited guides (LINE, Matrix, WeCom) on the sandbox; rebaseline `settings-channels` if needed. Open PR 3.

### As built (PR 3)

Tasks added while the PR ran:
- **B15:** Signal and iMessage were removed instead of fixed. A saved connection to either shows as removed and can't send (R32, R38).
- **B18:** the "attachments" check now passes with "This channel sends text. Attachments aren't supported." for LINE, Matrix, Nextcloud Talk, QQ Bot, WeCom and Zalo. It also added a shared test helper for the finish path (R45, R47).
- **B17:** the gateway records the host of a saved secret webhook address, so the hosts check can offer it. Host names may contain underscores. A trailing dot is not stripped (R33, R59).
- **B19:** test results and notes say "test message" or "Test send", not "sandbox" wording (R56, R60).

Rulings that changed the plan's text:
- **Zalo's v3 endpoint (R57):** Zalo's send and test now use `v3.0/oa/message/cs`. The v2 message API is shut down (error -240).
- **R39:** the shared text for pasted and environment-variable secret fields wins. Guides don't re-author it.
- **R42:** Discord keeps "Choose destinations and access". "Where should messages go?" is only for outbound-only channels.
- **R44:** the environment-variable label drops a trailing "(paste …)".
- **R46:** no vendor claim ships unless it was checked against the vendor's official docs, even where the spec's own text has one.
- **R48:** each text-only guide says once, in its overview step, "This channel sends text. Attachments aren't supported."
- **R49:** guide text must match what the test does with its message. No guide asks you to check a message the test deletes or never sends.
- **R50:** a checklist box can't require a step the chosen path doesn't need.

---

## PR 4 — The remaining runtime bugs (Part C; branch `fix/channel-runtime-bugs`)

Each task follows its spec entry: the failing test it names first, then the minimal fix it names, then a commit.

| Task | Spec | Failing test | Fix | Gate |
|---|---|---|---|---|
| C2 | C2 | (a) `channel-setup-eligibility.test.ts`: a Google Chat webhook-mode result has no blocking `target` warn; (b) an app-mode `google_chat_app_live_send` warn is `advisory` | (a) drop the thread-key `requireText` in webhook mode (`IDS:285-290`); (b) add it to the advisory set and defer an empty app-mode `defaultSpace` | (b) N3 default |
| C3 | C3 | `channel-setup-service.contract.test.ts`: a finalized `create` draft's connection id equals its draft id | `connectionId: readyDraft.connectionId ?? readyDraft.draftId` (`CSS:464`). Then A5's create-draft line becomes `This address works once you finish.` with the path shown before Finalize | N4 default |
| C4 | C4 | (none under the N2 default) | the WhatsApp first-message copy is done in B6. If N2 picks the template, write the spec's failing test and send `hello_world` | N2 |
| C5 | C5 | for every `…Env` field, a token-shaped value fails `validate()` with that `fieldKey` and `failureCategory: "malformed_value"` | one shared check in `withGuidedJourney.validate`, with the spec's message. It runs on validate only, so a saved connection with a non-conforming name keeps working until it is next edited; the PR says so | |
| C6 | C6 | `integration-diagnostics-service.contract.test.ts`: Mattermost with `botTokenEnv: "MY_TOKEN"` set fails `auth` naming `MATTERMOST_` | `requireSecretRef` resolves through `deps.resolveConnectionSecret`, with the spec's message | |
| C7 | C7 | the same file: a Zalo connection with allowlist `["discord.com"]` gets a `url` warn naming `openapi.zalo.me`; likewise Slack, WhatsApp and LINE | Telegram-style checks driven by `CHANNEL_REQUIRED_HOSTS` | |
| C8 | C8 | Moot: iMessage was retired on 2026-10-28 (N1). | Skip. | N1 |
| C9 | A6 | `channel-inbound-dispatch.test.ts` and the webhooks test: a dropped message's diagnostic `message` contains the sender id | the spec's message for both events, at `channel-inbound-dispatch.ts:363-385` and `integration-webhooks.ts:~150-170` | N5 default |

### As built (PR 4)

What changed from the table:
- **C4:** skipped. The N2 default applies, and the WhatsApp copy shipped in PR 3. **C8:** moot (N1). Zalo's token refresh was left out (operator, 2026-10-28).
- **Added while the PR ran:** C6b and C6c (security: a send reads a channel's variable only through the name rule, and a saved key is read only for the connection or draft that owns it), C11 (an edit keeps its saved key), D1 (small setup-path fixes left from PR 3), D2 (a retired channel never looks usable) and D3 (docs, labels and guide versions).
- **D3:** every guide's `wizard.contentVersion` now ends in `.guided-2026-10-28`, set by one constant in `guided-journey.ts`. The `delivery_posture` diagnostic check keeps its key and shows as "Sending and receiving".

Rulings:
- R63: PR 4 is C2, C3, C5/C6, C6b, C6c, C7, C9, C11, D1, D2 and D3.
- R64: some findings are parked for later (below).
- R65: dev diagnostics are off under `NODE_ENV=production` (Docker), so guides that point to System › Diagnostics say Docker needs `GOATCITADEL_DEV_DIAGNOSTICS_ENABLED=true`. Ids must survive the diagnostics redactor, which isn't weakened.
- R66: a variable-name field accepts exactly the names its runtime resolver accepts. The predicates are reused, not copied.
- R67: the provider-hosts warning names exactly the hosts the guide's Allow these hosts button adds, and blocks Finalize until they're allowed.
- R68: Google Chat Chat-app mode finishes with an advisory, because no test message can be sent. Webhook mode no longer needs the thread key.
- R69: a new connection keeps its draft's id, so its webhook address shows before Finalize.
- R70: "an edit asks for the saved key again" was confirmed by a test before it was fixed. It was real for Google Chat and the webhook-address channels.
- R71: C3 also fixed the Google Chat address lines that its change made false.
- R72: the model-provider `apiKeyEnv` presence check is left unguarded, because it isn't a channel field.
- R73 (security): sends read a channel's variable only through the name rule. The rule is checked through a gateway hook, and a missing hook fails closed.
- R74 (security): a pasted token in a name field is never echoed in a check message or the resolver's warning log.
- R75 (security): the SMTP password variable gets the same rule (`SMTP_` / `IMAP_` alias for the email integration only).
- R76: the Discord gateway runtime logs in with the saved token, not its secure-storage reference.
- R77: subagent commit trailers name the model that wrote the commit.
- R78 (security): a saved key is only read for the connection or draft that owns it, checked once at the shared read.
- R79: Slack's `slack.com` is required only with a bot token, not for an incoming-webhook-only setup.
- R80: guide copy says to finish setup first, then where to find a dropped sender's id, and what Docker shows.
- R81: Chat's Discord form asks for the server ID only on bot paths.
- R82: a field revealed by a choice in the same Chat form is accepted. The open-legacy marker can never be submitted.

Parked for later:
- orphaned secure-storage entries after a key is replaced or cleared;
- trailing-dot handling in the network guards;
- whether `occ talk:bot:list` prints bot ids (needs a live Talk install);
- the dead `buildSlackOAuthConnectionInput`;
- Classic diagnostics showing raw check keys (D3 maps only `delivery_posture` to a plain name);
- System › Diagnostics alert text when diagnostics are off.

### Task C10: PR 4 proof and PR

- [ ] **Lanes:** gateway `src/services/channel-*`, `src/services/integration-diagnostics*`, `src/routes/integration-webhooks*`; the gateway typecheck; `git diff --check`.
- [ ] Open PR 4.
