# WhatsApp Setup Page and Public Web Address Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** "+ Add" › WhatsApp opens a one-page setup in Chat › Messaging that states Meta's steps up front, checks every pasted value with Meta, shows GoatCitadel's own web address and verify token, says when Meta has checked that address, hears the operator's one-time code, and ends with an in-place Turn on. GoatCitadel gains one "public web address" setting that WhatsApp and every other web-address channel read. A WhatsApp reply after the 24-hour window says so instead of failing silently.

**Architecture:**
- **One setting.** `publicWebAddress` is a gateway-owned runtime setting, saved through the existing Settings Change Plan path (`runtime_configuration` operation `public_web_address_configuration`) and approved in place. A shared contracts helper normalizes and validates it for both sides.
- **Gateway: WhatsApp setup.**
  - A setup check route reads Meta's Graph API with the draft's own saved values and returns names, never tokens.
  - A second route subscribes the app to the WhatsApp Business Account, on the operator's click.
  - A setup listener lets the WhatsApp webhook route answer Meta's address check and hear the one-time code for a Chat-made setup draft before Turn on. It keeps what it heard in memory, runs no turns and sends nothing.
- **Gateway: reply window.** A desk send into a WhatsApp conversation is refused with a fixed sentence when the person's last message is 24 hours old or more.
- **Cockpit.** A WhatsApp setup page on plan 2's frame (`SetupFrame`, `SetupSteps`, `TurnOnStep`, `useTurnOn`, `turnOnChannelDraft`), a "Change the key" entry, a Settings control for the public web address, and a composer block for a closed reply window.

**Tech Stack:** TypeScript, Fastify gateway with zod route schemas, Meta Graph API over `fetch`, React 19 Cockpit with TanStack Query, vitest (happy-dom, `createRoot`/`act`, no Testing Library).

**Spec:** `docs/superpowers/specs/2026-10-25-messaging-in-chat-and-channel-quick-setup-design.md`, sections 4–8, "WhatsApp (official Cloud API)", "Constraints" and "Calls I made". Plans 2 and 3 (`docs/superpowers/plans/2026-10-26-channel-quick-setup.md`, `docs/superpowers/plans/2026-10-28-discord-slack-setup.md`) built the frame and the patterns this plan reuses.

**Program:** plan 4 of 4. Plans 1–3 (#597, #604, #641) and the channel-guide fixes (#608, #611, #616, #620, #630, #631, #633) are merged.

**Calls this plan makes (operator to check):**
- **The address goes into Meta by hand.** Meta's own docs disagree about setting a WhatsApp app's callback address by API. Its WhatsApp page allows `POST /{app-id}/subscriptions`; its Graph reference for that call says "Webhooks for WhatsApp is not supported. WhatsApp webhooks must be configured using the App Dashboard." The per-number and per-account overrides are documented, but not whether they work without an app address. So the page shows GoatCitadel's address and a verify token GoatCitadel made, each with a copy button. It names Meta's own fields ("Callback URL", "Verify token"). Then it says "Meta checked your address just now." when Meta's check arrives.
- **GoatCitadel subscribes the app to the account itself.** That's `POST /{waba-id}/subscribed_apps`, which is documented. It runs only on the operator's click, and only when Meta says the app isn't subscribed already.
- **Five pasted values:** access token, phone number ID, WhatsApp Business Account ID, app ID and app secret. Meta's app dashboard shows all five.
  - The spec named four. The account ID is the fifth, because Meta documents no way to find it from the number for someone who made their own app.
  - The app ID and secret let GoatCitadel check the token belongs to that app (`debug_token`) and that the secret is right. A wrong secret would otherwise only show up later, as messages failing their signature check.
- **A short-lived token gets a warning, not a block.** Meta's temporary token from API Setup stops working within hours. When `debug_token` reports an expiry, the page says when and how to make a permanent one (a system user's token). The page still lets the operator go on.
- **Hearing the code before Turn on.**
  - The webhook route accepts Meta's check and Meta's message deliveries for a WhatsApp setup draft made on the Chat page, at the same address the connection will have.
  - For a delivery, it checks Meta's signature with the draft's app secret and checks the phone number ID. Then it looks only for a message whose whole text is the draft's code.
  - What it hears is kept in memory for 15 minutes. It runs no agent turn, replies to no one and keeps no message text.
  - A WhatsApp setup draft made in Settings is unchanged: its address answers 404 until it is finished.
- **The page writes down that Meta checked the address**, on the draft (`webhookCheckedAt`). A reload or a GoatCitadel restart then goes on past that step.
- **Only the person who sent the code may message the bot.** Anyone else's message is dropped with today's "Dropped a WhatsApp message from …" diagnostic, and the operator can add them under Who may message this bot. The spec's pairing codes for others are left for a follow-up, as Slack's were in plan 3.
- **Where it posts:** that person's WhatsApp. The Cloud API has no group chats, so there's no choice to make.
- **Settings keeps WhatsApp's guide** for anyone who wants it. The picker opens the Chat page, and a draft made on the Chat page resumes there. As before, only Telegram sends new setups from Settings to Chat.
- **The 24-hour window.**
  - GoatCitadel refuses a reply in a WhatsApp conversation when the person's last message is 24 hours old or more, or there is none. Both the composer and the gateway refuse.
  - Template messages, which Meta allows outside the window, are out of scope.
  - Agent answers are not checked. Meta reports a late failure afterwards as a delivery status, and GoatCitadel still ignores those (follow-up).
- **The public web address.**
  - One setting. It must be `https://`, may carry a path (for a reverse proxy under a path), and may not be a loopback, private-network or link-local address.
  - GoatCitadel doesn't try to reach it; for WhatsApp, Meta's check does that.
  - Every channel's web address in Settings and in Chat now starts with it, instead of "https://<your public address>".
- **Meta's test number.** Meta's docs don't say which numbers its test number may send to. The page therefore says the test message and replies "may" need your phone added under API Setup.
- **The Graph API version is `v23.0`**, the one GoatCitadel's WhatsApp sends, probes and typing use today. So a token that passes the check works for sending.
- **No new dependencies.** The QR code uses the existing `QrCode` component.

## Global Constraints

**Providers and scope**
- Official provider APIs only. Nothing may get an account banned.
- **Meta Graph API.** The base is `https://graph.facebook.com/v23.0`. Calls:
  - `GET /{phone-number-id}?fields=display_phone_number,verified_name`, with `Authorization: Bearer <access token>`.
  - `GET /debug_token?input_token=<access token>`, with `Authorization: Bearer <app id>|<app secret>`.
  - `GET /{waba-id}/phone_numbers?fields=id&limit=100`, with the access token.
  - `GET /{waba-id}/subscribed_apps`, with the access token.
  - `POST /{waba-id}/subscribed_apps`, with the access token and no body. This is the only write, and it runs only from the subscribe route.
- **Vendor facts this plan relies on.** Each was checked against Meta's developer docs on 2026-10-29; nothing beyond them may ship as a vendor claim:
  - **Verification request:** `GET <callback>?hub.mode=subscribe&hub.challenge=<x>&hub.verify_token=<y>`. The answer is 200 with the challenge as sent.
  - **Deliveries** carry `X-Hub-Signature-256: sha256=<hex HMAC-SHA256 of the body, keyed with the app secret>`. Meta retries anything but 200.
  - **Payload shape:** `entry[].changes[].value` holds `metadata.phone_number_id`, `contacts[].profile.name`, `contacts[].wa_id`, and `messages[]` with `from`, `id`, `timestamp` (Unix seconds as a string), `type` and `text.body`. Status updates carry `statuses[]` instead of `messages[]`.
  - **The window:** free-form messages are allowed within 24 hours of the person's last message or call, and each new message resets it. Outside it Meta's error code is `131047`.
  - **`debug_token`** returns `data.app_id`, `data.is_valid` and `data.expires_at`, where `0` means it never expires.
  - **`subscribed_apps`** reads as `{data:[{whatsapp_business_api_data:{id,name}}]}`. The POST returns `{success:true}`.
  - **Click-to-chat:** `https://wa.me/<digits>?text=<URL-encoded text>`. The number is international format, digits only, with no `+`, spaces or dashes.
  - **A system user's token** is Meta's long-lived token for someone who made their own app (Business Settings › System users).
- Cockpit changes go in `apps/mission-control-next/src/cockpit`, plus the shared `ChannelWebhookAddress` (Task 2). The Classic shell gets only what that shared component changes.

**Design and Cockpit guards**
- `DESIGN.md` rules apply:
  - sentence case
  - the shared status vocabulary
  - names before IDs (IDs only in `TechnicalDetails`)
  - `variant="danger"` only for irreversible actions
  - both themes and phone width
  - `TimeText` for times and `plural()` for counts
- Cockpit copy may not use "owner", "owners", "Gateway", "evidence", "revision", "snapshot" or "replay" (`check-mission-control-next-cockpit-copy.mjs`; Cockpit budgets are 0). Write "GoatCitadel", not "Gateway". Meta's field names ("Callback URL", "Verify token", "Phone number ID", "WhatsApp Business Account ID", "App ID", "App secret") are quoted as Meta shows them.
- No new live regions:
  - Each page's only status line is `SetupSteps`'s.
  - The composer's reason line carries the reply-window block.
  - `LIVE_REGION_BUDGET` stays at 900, and `Callout` takes `announce={false}`.
- At most 400 lines per non-test Cockpit file (`eslint.config.mjs`). Split a file before it gets there.
- Other Cockpit checks:
  - the raw-values ratchet
  - no arbitrary Tailwind values
  - each aria-label starts with the visible text
  - `cockpitInputClass` on text inputs
  - every `fetchSettings` query key in `SETTINGS_READER_KEYS`

**Gateway ownership, secrets and approvals**
- Mission Control is an API client. Drafts, connections, settings and plans are owned by the gateway.
- Approval is not weakened. Turn on runs `turnOnChannelDraft` unchanged in its approval behaviour. The public web address is saved through the Settings Change Plan path, and the operator's click approves it in place, the way Settings approves Firecrawl's address.
- **Secrets never leak.** None of these may appear in an error message, diagnostic, log line, response or rendered text, except the verify token in the one place the page shows it so the operator can copy it:
  - the access token;
  - the app secret;
  - the verify token;
  - an `<app id>|<app secret>` pair;
  - a Graph URL that carries `input_token`.

  Errors are fixed sentences. Never build one from `error.message`, a URL or a response body.
- Saved secrets are read through the owner-checked resolver, `resolveConnectionSecret(config, directKey, envKey, catalogId, owner)`. Draft secrets are read after `hydrateChannelSetupDraftSecrets`, with `channelSecretOwnerForDraft(draft)` as the owner.
- The setup check is read-only toward Meta. Only the subscribe route writes, and only `POST /{waba-id}/subscribed_apps`.

**Storage and dependencies**
- No new tables or migrations, and no new dependencies.
- New state lives in existing places:
  - **Draft values** carry `setupPage`, `setupCode`, `appId`, `businessAccountId`, `webhookCheckedAt`, `ownerActorIds`, `allowedSenders`, `inboundAccessMode` and `defaultTarget`.
  - **New config keys:** `appId` and `businessAccountId` on the connection, and top-level `publicWebAddress` in the assistant config.
  - **New storage read:** one query on `chat_messages`, beside `countAfter`.

**Architecture metrics**
- Never run `architecture:baseline:update`.
- `pnpm verify:architecture:metrics` passes on main today. If it fails for anything other than an allowance below, stop and ask the operator, naming the file and the counts.
- Operator-approved allowances for this plan (C0 entries in `scripts/verification/baselines/architecture-new-service-allowances.json`). Set each entry to the measured count:

  | File | Host callbacks | Dependency reads |
  |---|---|---|
  | `apps/gateway/src/services/channel-setup-whatsapp-check.ts` | up to 10 | up to 10 |
  | `apps/gateway/src/services/whatsapp-setup-listener.ts` | up to 10 | up to 10 |

- Every other file keeps its count and cap:

  | File | Count / cap |
  |---|---|
  | `gateway-route-composition-integrations.ts` | ≤ 105 |
  | `channel-setup-service.ts` | 56 host, 61 dependency |
  | `chat-messaging-service.ts` | within its allowance (cap 12) |
  | `gateway-service.ts` | ≤ 13132 lines (13126 today) |

  This plan adds exactly one line to `gateway-service.ts` (Task 6).

**Working practices**
- After changing `packages/contracts`, rebuild it (`pnpm --filter @goatcitadel/contracts build`) before running tests in other packages. Rebuild `@goatcitadel/mission-control-shared` after changing it.
- Run heavy work at low priority:
  - vitest with `--maxWorkers=2`, one heavy job at a time;
  - gateway tests from `apps/gateway` (`pnpm exec vitest run <files> --maxWorkers=2`);
  - Mission Control tests from `apps/mission-control-next`.
- Run Prettier only on files this plan creates, or on already-clean files it touches. Never on a directory glob. The pre-commit hook formats staged files, so a file that wasn't Prettier-clean gets its own `style:` commit first.
- Bump `GUIDED_CONTENT_VERSION_SUFFIX` (`guided-journey.ts`) once, in Task 3, to `.guided-` plus that day's date. It must differ from `.guided-2026-10-29`.
- No personal paths in tracked files.
- Work on branch `feat/channel-setup-whatsapp` in worktree `.claude/worktrees/messaging-in-chat`. Commit only there, and never `git stash`.

## Review Focus

1. **A forged delivery to a setup draft's address.**
   - A wrong `X-Hub-Signature-256` answers 401.
   - A right signature for another phone number ID answers 403.
   - Neither records anything, and no delivery ever starts a turn or a reply (Task 4).
2. **The code arrives inside a longer message, or from a second person.**
   - Only a message whose whole trimmed text is the draft's code counts, and the match is case-sensitive.
   - A second person who sends the current code replaces the first.
   - The page's "only this person" values name only the newest sender (Tasks 4 and 7).
3. **A reload in the middle of setup.** Say the tokens are stored, Meta checked the address and nobody has said hi yet. The page goes on at "Say hi" without asking for a new verify token. It offers a new verify token only while Meta hasn't checked the address (Task 7).
4. **The reply window's edges** (Task 6):
   - last message exactly 24 hours ago: closed;
   - 23 hours 59 minutes ago: open;
   - no message from the person: closed;
   - any channel but WhatsApp: never closed.
5. **What people type as a public web address** (Task 1):
   - `https://Example.com/goat/` saves as `https://example.com/goat`.
   - These are refused, each with its own sentence: `http://example.com`, `https://127.0.0.1`, `https://192.168.1.5`, `https://[::1]`, `https://localhost`, `https://user:pw@example.com`, `https://example.com/?a=1`, `example.com`.

---

### Task 1: Public web address setting (gateway and contracts)

**Files:**
- Create: `packages/contracts/src/public-web-address.ts`, exported from the contracts index
- Create: `packages/contracts/src/public-web-address.test.ts`
- Modify: `packages/contracts/src/config-schemas.ts` (top-level `publicWebAddress: z.string().optional()` in `AssistantConfigInputSchema`)
- Modify: `apps/gateway/src/config.ts` (`AssistantConfig.publicWebAddress?: string` and its loader)
- Modify: `apps/gateway/src/services/gateway/runtime-settings.ts` (`RuntimeSettings.publicWebAddress?: string`)
- Modify: `apps/gateway/src/services/settings-auth-service.ts`:
  - `getSettings`
  - `UpdateSettingsInput.publicWebAddress?: string | null`
  - `buildSettingsCandidate`
  - the apply step beside Firecrawl's at :604-633
- Modify: `apps/gateway/src/routes/dashboard.ts` (`updateSettingsSchema`: `publicWebAddress: z.string().max(400).nullable().optional()`)
- Modify: `apps/gateway/src/routes/dashboard-settings-change-plan.ts` (`SettingsChangePlanInput`, `settingsChangePlanRequest`)
- Modify: `packages/contracts/src/change-plan.ts` (the `ChangePlanRuntimeConfigurationOperation` union and its shape validator)
- Modify: `apps/gateway/src/routes/change-plans.ts` (zod schema beside :231-233)
- Modify: `apps/gateway/src/services/runtime-configuration-change-plan-adapter.ts` (`validateOwnerSelection`, `settingsPatch`, `matches`, `targetResourceId`, `describe`)
- Modify: `packages/mission-control-shared/src/api/types.ts` (`RuntimeSettingsResponse.publicWebAddress?: string`)
- Modify: `packages/mission-control-shared/src/api/settings-operations.ts` (`patchSettings` input `publicWebAddress?: string | null`)
- Test: the tests beside each changed gateway file that already cover Firecrawl's `web_firecrawl_configuration`. Find them with `git grep -l web_firecrawl_configuration -- '*.test.ts'`.

**Interfaces:**
- Produces, in contracts:
  ```ts
  export type PublicWebAddressCheck = { ok: true; address: string } | { ok: false; problem: string };
  /** Trims, checks and normalizes an operator's public web address. */
  export function checkPublicWebAddress(input: string): PublicWebAddressCheck;
  /** The full address of a web-address route, or undefined when no public web address is set. */
  export function publicWebAddressFor(publicWebAddress: string | undefined, path: string): string | undefined;
  export const PUBLIC_WEB_ADDRESS_MAX_LENGTH = 200;
  ```
- Produces, in the change-plan contract: the operation `{ operation: "public_web_address_configuration"; config: { publicWebAddress: string | null } }`, where `null` clears the setting.
- Produces, in settings: `RuntimeSettings.publicWebAddress?: string` and `RuntimeSettingsResponse.publicWebAddress?: string` (absent when unset). Also `patchSettings({ expectedRevision, publicWebAddress })`.
- Problems, exact copy, as exported constants:

  | Constant | Sentence |
  |---|---|
  | `PUBLIC_WEB_ADDRESS_NOT_URL` | "Enter a full address that starts with https://." |
  | `PUBLIC_WEB_ADDRESS_NOT_HTTPS` | "Use an https:// address. Meta and the other services send only to secure addresses." |
  | `PUBLIC_WEB_ADDRESS_HAS_LOGIN` | "Leave the user name and password out of the address." |
  | `PUBLIC_WEB_ADDRESS_HAS_EXTRA` | "Leave out anything after ? or #." |
  | `PUBLIC_WEB_ADDRESS_NOT_PUBLIC` | "Use an address the internet can reach, not one on this computer or your home network." |
  | `PUBLIC_WEB_ADDRESS_TOO_LONG` | "Use an address under 200 characters." |

- [ ] **Step 1: Write the failing tests**

`public-web-address.test.ts`:
- `it("keeps an https address and drops the trailing slash")`:
  - `checkPublicWebAddress("  https://Example.com/goat/ ")` gives `{ok: true, address: "https://example.com/goat"}`.
  - `"https://goat.example.com"` gives `"https://goat.example.com"`.
  - `"https://goat.example.com:8443/"` gives `"https://goat.example.com:8443"`.
- `it("refuses what Meta can't send to")`: each input below gives `{ok: false}` with the named sentence:

  | Input | Problem |
  |---|---|
  | `"example.com"` | NOT_URL |
  | `"http://example.com"` | NOT_HTTPS |
  | `"https://user:pw@example.com"` | HAS_LOGIN |
  | `"https://example.com/?a=1"` | HAS_EXTRA |
  | `"https://example.com/#x"` | HAS_EXTRA |
  | `"https://" + "a".repeat(200) + ".com"` | TOO_LONG |

- `it("refuses addresses on this computer or a home network")`. Each of these gives NOT_PUBLIC:
  - `https://localhost`
  - `https://goat.localhost`
  - `https://127.0.0.1`
  - `https://10.1.2.3`
  - `https://172.16.0.1`
  - `https://192.168.1.5`
  - `https://169.254.1.1`
  - `https://100.64.0.1`
  - `https://0.0.0.0`
  - `https://[::1]`
  - `https://[fe80::1]`
  - `https://[fd00::1]`
  - `https://[::ffff:192.168.1.5]`
- `it("joins the address and a route path")`:
  - `publicWebAddressFor("https://example.com/goat", "/api/v1/x")` is `"https://example.com/goat/api/v1/x"`.
  - `publicWebAddressFor(undefined, "/api/v1/x")` is `undefined`.

Gateway tests, beside the Firecrawl cases:
- A PATCH with `publicWebAddress: "https://Example.com/"` makes a `public_web_address_configuration` plan with config `{publicWebAddress: "https://example.com"}`. Once applied, `GET /api/v1/settings` returns `publicWebAddress: "https://example.com"`.
- `publicWebAddress: null` clears it: the setting is absent afterwards.
- `publicWebAddress: "http://example.com"` is a 400 with `PUBLIC_WEB_ADDRESS_NOT_HTTPS`, and no plan is created.
- The adapter's `describe` gives risk `"caution"`. Its summary is "Set GoatCitadel's public web address to https://example.com" or "Clear GoatCitadel's public web address".
- Saving `publicWebAddress` together with another settings key is refused, as every other two-key save is today.

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm --filter @goatcitadel/contracts exec vitest run src/public-web-address.test.ts`. Then run the touched gateway tests from `apps/gateway` with `--maxWorkers=2`.
Expected: FAIL (module not found, unknown operation).

- [ ] **Step 3: Implement**

**Contracts.** Implement `checkPublicWebAddress` with `new URL`:
- Order: length, then URL parse, then protocol, then credentials, then `search`/`hash`, then host.
- The host is "not public" when it's any of these:
  - `localhost`, or a name ending in `.localhost`;
  - an IPv4 literal in 0.0.0.0/8, 10/8, 100.64/10, 127/8, 169.254/16, 172.16/12 or 192.168/16;
  - an IPv6 literal that's `::`, `::1`, in fc00::/7 or fe80::/10, or an IPv4-mapped address in one of those IPv4 ranges.

  Contracts can't import `policy-engine`, so keep these ranges in the new file, with a comment pointing at `isPrivateOrReservedHost` in `packages/policy-engine/src/sandbox/network-guard.ts`.
- The normalized address is `origin` plus the `pathname` with trailing slashes removed.

**Gateway.** Follow Firecrawl's `web_firecrawl_configuration` through every file listed. Then:
- **Validation:** `validateOwnerSelection` runs `checkPublicWebAddress`, and a problem becomes a `ValidationError` with that sentence.
- **Storage:** the stored value is the normalized address. `null` removes the key from the candidate config.
- **Target:** `targetResourceId` is `"public_web_address_configuration"`.

- [ ] **Step 4: Rebuild contracts and the shared client, then run the tests**

Run: `pnpm --filter @goatcitadel/contracts build`, `pnpm --filter @goatcitadel/mission-control-shared build`, then the Step 2 commands.
Expected: PASS. Then `pnpm --filter @goatcitadel/gateway typecheck` exits 0.

- [ ] **Step 5: Commit**

```bash
git add packages/contracts packages/mission-control-shared apps/gateway
git commit -m "feat(settings): a public web address setting that channels read"
```

---

### Task 2: Public web address in the Cockpit

**Files:**
- Create: `apps/mission-control-next/src/cockpit/areas/settings/PublicWebAddressField.tsx`
- Create: `apps/mission-control-next/src/cockpit/areas/settings/PublicWebAddressField.test.tsx`
- Modify: `apps/mission-control-next/src/cockpit/areas/settings/SettingsArea.tsx` (render the field above `ChannelsSettings` in the channels section, :142-144)
- Modify: `apps/mission-control-next/src/cockpit/areas/settings/settings-approval-owner.ts` (new owner for `public_web_address_configuration`)
- Modify: `apps/mission-control-next/src/features/native-routes/settings/channel-setup/ChannelWebhookAddress.tsx`
- Test: `apps/mission-control-next/src/features/native-routes/settings/channel-setup/ChannelWebhookAddress.test.tsx`

**Interfaces:**
- Consumes: Task 1's `checkPublicWebAddress`, `publicWebAddressFor`, `RuntimeSettingsResponse.publicWebAddress` and `patchSettings`.
- Produces: `PublicWebAddressField({ settings, onSaved? }: { settings: RuntimeSettingsResponse; onSaved?: (address: string) => void })`. It's built on `useGovernedRuntimeSetting<string>` and is the one control the Settings section and Task 8's page both render.
- Produces: `usePublicWebAddress(): string | undefined`, exported from `PublicWebAddressField.tsx`. It reads `fetchSettings` under the query key `useMissingHosts` already uses (`["system", "settings-web-search"]`, already in `SETTINGS_READER_KEYS`).

- [ ] **Step 1: Write the failing tests**

`PublicWebAddressField.test.tsx`, modelled on `FirecrawlSettings.test.tsx`:
- `it("shows the saved address and saves a new one through Settings' approval")`. Typing `https://Goat.example.com/` and choosing **Save address** sends `patchSettings` with `publicWebAddress: "https://Goat.example.com/"`. The gateway normalizes it. The approval dialog is the same one Firecrawl's address uses.
- `it("says what's wrong before saving")`. Typing `http://goat.example.com` shows `PUBLIC_WEB_ADDRESS_NOT_HTTPS` next to the field, and Save is disabled.
- `it("clears the address")`. **Clear** sends `publicWebAddress: null`.
- The help text reads exactly: "The https:// address where Meta and other services can reach this GoatCitadel. Use your own domain, reverse proxy or tunnel; GoatCitadel doesn't provide one."

`ChannelWebhookAddress.test.tsx`:
- With settings `publicWebAddress: "https://goat.example.com"`, the address shown and copied is `https://goat.example.com/api/v1/integrations/connections/<id>/whatsapp/webhook`.
- Without it, today's placeholder and copy stay. A link labelled "Set your public web address" goes to `/settings/connections#channels`.

- [ ] **Step 2: Run them to verify they fail**

Run (from `apps/mission-control-next`): `pnpm exec vitest run src/cockpit/areas/settings/PublicWebAddressField.test.tsx src/features/native-routes/settings/channel-setup/ChannelWebhookAddress.test.tsx --maxWorkers=2`
Expected: FAIL.

- [ ] **Step 3: Implement**

- Follow `FirecrawlSettings.tsx:70-95` for the draft string, the problem line and the governed save. Use `BudgetModeControl.tsx` for the hook's arguments, with:
  - `operation`: `"public_web_address_configuration"`;
  - `read`: `settings.publicWebAddress ?? ""`;
  - `patch`: `{ publicWebAddress: value.trim() || null }`.
- The field's label is "Public web address". The Settings section's heading is "Public web address".
- `ChannelWebhookAddress` reads `usePublicWebAddress()`. It shows `publicWebAddressFor(address, path)` when set, and the placeholder otherwise.

- [ ] **Step 4: Run the tests and the Cockpit guards**

Run: the Step 2 command, then from the repo root:
- `node scripts/check-mission-control-next-cockpit-copy.mjs`
- `node scripts/check-mission-control-next-cockpit-semantics.mjs`
- `node scripts/check-mission-control-next-cockpit-classes.mjs`
- `node scripts/check-mission-control-next-raw-values.mjs`

Expected: all PASS. Live regions stay at 900, and the `settings-readers.inventory.test.ts` test passes.

- [ ] **Step 5: Commit**

```bash
git add apps/mission-control-next
git commit -m "feat(cockpit): set GoatCitadel's public web address and show it in channel addresses"
```

---

### Task 3: WhatsApp guide carries the setup page's values

**Files:**
- Modify: `apps/gateway/src/services/channel-setup-definitions/whatsapp.ts`:
  - new fields `appId` and `businessAccountId`;
  - `hydrate` and `normalize` carry them, plus `ownerActorIds`;
  - `validate` checks both new fields.
- Modify: `apps/gateway/src/services/channel-setup-definitions/guided-journey.ts` (`POSTURE.whatsapp`, `GUIDED_CONTENT_VERSION_SUFFIX`)
- Modify: `apps/gateway/src/services/channel-setup-definitions/picker-hints.ts` (`CHANNEL_PICKER_HINTS.whatsapp.minutes = 15`)
- Test: `apps/gateway/src/services/channel-setup-definitions/whatsapp.test.ts` (create it if absent, modelled on `slack.copy.test.ts`)

**Interfaces:**
- Produces: the draft keys `appId` and `businessAccountId` are saved into the connection config. Both are optional in Settings and must match `^\d{6,}$` when present.
- Produces: `ownerActorIds` survives hydrate → normalize, as on Discord (`discord.ts`).

- [ ] **Step 1: Write the failing tests**

- `it("keeps the app and account IDs and who made the setup")`:
  - Normalizing a draft with `appId: "1234567"`, `businessAccountId: "7654321"` and `ownerActorIds: ["15551234567"]` keeps all three.
  - Hydrating that config gives them back.
- `it("checks the IDs' shape")`:
  - `appId: "abc"` gives an issue on `appId` reading "Use the App ID from your Meta app's Basic settings: digits only."
  - `businessAccountId: "x"` gives an issue on `businessAccountId` reading "Use the WhatsApp Business Account ID from API Setup: digits only."
- `it("accepts a WhatsApp ID as the default contact")`. `defaultTarget: "15551234567"` validates with no issue.
- `it("tells the setup story up front")`. The summary is exactly: "Send and receive WhatsApp messages through your own Meta app. Meta delivers messages only to a public https:// address, so GoatCitadel needs one. The quickest setup is WhatsApp in Chat › Messaging."
- The picker hint for WhatsApp is `{group: "phone_apps", note: "Business account + public web address", minutes: 15}`.

- [ ] **Step 2: Run them to verify they fail**

Run (from `apps/gateway`): `pnpm exec vitest run src/services/channel-setup-definitions/whatsapp.test.ts src/services/channel-setup-definitions/picker-hints.test.ts --maxWorkers=2`
Expected: FAIL.

- [ ] **Step 3: Implement**

- Add both fields to the `receive-messages` step, after `appSecret`:
  - `appId` is labelled "App ID", with `inputMode: "numeric"`.
  - `businessAccountId` is labelled "WhatsApp Business Account ID", with `inputMode: "numeric"`.

  Neither is required in Settings.
- Leave the other `POSTURE.whatsapp` lines as they are.
- Bump the suffix as Global Constraints say.

- [ ] **Step 4: Run the tests**

Run: the Step 2 command, then `pnpm exec vitest run src/services/channel-setup-definitions --maxWorkers=2`, from `apps/gateway`.
Expected: PASS. The suffix bump changes expected versions in other definition tests; update only those version strings.

- [ ] **Step 5: Commit**

```bash
git add apps/gateway/src/services/channel-setup-definitions
git commit -m "feat(whatsapp): the guide keeps the app and account IDs and who made the setup"
```

---

### Task 4: WhatsApp setup listener

**Files:**
- Modify: `packages/contracts/src/channel-setup-checks.ts` (`WhatsAppSetupCodeSender`)
- Create: `apps/gateway/src/services/whatsapp-setup-listener.ts`
- Create: `apps/gateway/src/services/whatsapp-setup-listener.test.ts`
- Modify: `apps/gateway/src/routes/integration-webhooks-whatsapp-routes.ts`:
  - GET: on a missing connection, ask the listener;
  - POST: before the factory handler, ask the listener when the connection is missing.
- Modify: `apps/gateway/src/services/integration-webhook-route-service.ts` (two port methods)
- Modify: `apps/gateway/src/services/gateway-route-composition-integrations.ts`:
  - create one listener from `channelSetupDeps`;
  - pass it to the webhook port and to Task 5's channel setup port.
- Modify: `scripts/verification/baselines/architecture-new-service-allowances.json`
- Test: `apps/gateway/src/routes/integration-webhooks-whatsapp-routes.test.ts`. Use the file that already covers this route; find it with `git grep -l "whatsapp/webhook" -- '*.test.ts'`.

**Interfaces:**
- Produces:
  ```ts
  export interface WhatsAppSetupCodeSender { actorId: string; displayName?: string }   // in contracts, channel-setup-checks.ts
  export interface WhatsAppSetupHeard { addressCheckedAt?: string; code?: string; codeSender?: WhatsAppSetupCodeSender }
  export interface WhatsAppSetupListener {
    /** Meta's address check for a Chat-made setup draft: the challenge to send back, or the status to refuse with. */
    answerCheck(draftId: string, query: { mode?: string; verifyToken?: string; challenge?: string }): Promise<{ status: 200; challenge: string } | { status: 400 | 401 | 404 }>;
    /** A delivery for a Chat-made setup draft: listens for the draft's code and nothing else. */
    hearDelivery(draftId: string, rawBody: string, signature: string | undefined): Promise<{ status: 200 | 400 | 401 | 403 | 404 }>;
    /** What has been heard for the draft in the last 15 minutes. */
    heard(draftId: string): WhatsAppSetupHeard;
  }
  export function createWhatsAppSetupListener(host: ChannelSetupHost, now?: () => Date): WhatsAppSetupListener;
  export const WHATSAPP_SETUP_LISTEN_MS = 15 * 60_000;
  export const WHATSAPP_SETUP_LISTEN_MAX_DRAFTS = 32;
  ```
- Produces: the port methods `answerWhatsAppSetupCheck` and `hearWhatsAppSetupDelivery`, which call the same listener.
- A draft qualifies only when all of these hold:
  - `catalogId === "channel.whatsapp"`;
  - `lifecycleMode === "create"`;
  - `draft.setupPage === "messaging"`.

  For any other draft, or a missing one, the answer is 404, as today.

- [ ] **Step 1: Write the failing tests**

`whatsapp-setup-listener.test.ts` uses the fake setup host from `channel-setup-slack-check.test.ts`. The draft has these values, with `appSecret` and `webhookVerifyToken` stored as draft secrets:
- `{setupPage: "messaging", phoneNumberId: "106540352242922", setupCode: "Kp4mZ9qRtW"}`

Tests:
- `it("answers Meta's check with the challenge and notes the time")`:
  - `answerCheck` with mode `subscribe`, the right token and challenge `"1158201444"` gives `{status: 200, challenge: "1158201444"}`.
  - `heard(draftId).addressCheckedAt` is the fake clock's time.
- `it("refuses a check with the wrong token or no challenge")`. A wrong token gives 401, a missing challenge or another mode gives 400, and neither notes a time.
- `it("answers 404 for a draft not made on the Chat page, another channel's draft, or no draft")`.
- `it("hears the code from the person who sent it")`:
  - The delivery is a valid Meta text payload. `from` is `"16505551234"`, `contacts[0].profile.name` is `"Sheena"` and `text.body` is `" Kp4mZ9qRtW "`.
  - It's signed with the draft's app secret.
  - The answer is 200, and `heard(draftId)` is `{code: "Kp4mZ9qRtW", codeSender: {actorId: "16505551234", displayName: "Sheena"}}`.
- `it("hears only a message that is the code and nothing else")`. Each of these answers 200 and hears no sender:
  - `"my code is Kp4mZ9qRtW"`;
  - `"kp4mz9qrtw"`;
  - an image with that caption;
  - a `statuses` delivery.
- `it("the newest sender of the current code replaces the earlier one")`. Two signed deliveries from different numbers leave the second as `codeSender`.
- `it("refuses a delivery Meta didn't sign for this draft")`:
  - a wrong signature gives 401;
  - no signature gives 401;
  - a right signature for `phone_number_id` `"999"` gives 403.

  Nothing is heard in any of them.
- `it("forgets after 15 minutes, and keeps at most 32 drafts")`:
  - After the fake clock moves 15 minutes past the last note, `heard()` is `{}`.
  - With 33 drafts noted, the oldest is forgotten.
- `it("never quotes a secret")`. A run with a wrong token, a wrong signature and a `fetch` that throws leaves no app secret or verify token in any thrown message or result.

Route tests:
- GET to a missing connection whose id is a qualifying draft answers `text/plain` with the challenge.
- POST to it with a signed code delivery answers 200, with the existing ignored-webhook reply (`createIgnoredWebhookReply`) and reason `"setup_listening"`. `acceptInboundChannelEvent(s)` and `respondToExistingChatMessage` are never called.
- GET and POST to an id that's neither a connection nor a qualifying draft still answer 404.

- [ ] **Step 2: Run them to verify they fail**

Run (from `apps/gateway`): `pnpm exec vitest run src/services/whatsapp-setup-listener.test.ts <the route test> --maxWorkers=2`
Expected: FAIL.

- [ ] **Step 3: Implement**

**Listener.**
- Load the draft with `host.storage.channelSetupDrafts.get`, and decide if it qualifies.
- Build the ephemeral connection as `checkSlackSetup` does (`buildEphemeralChannelConnection(host, hydrateChannelSetupDraftSecrets(host, draft))`). Then resolve from its config with `host.resolveConnectionSecret(config, "webhookVerifyToken", "webhookVerifyTokenEnv", "channel.whatsapp", channelSecretOwnerForDraft(draft))`. Resolve `appSecret`/`appSecretEnv` the same way.
- Compare with `timingSafeStringEqual`.
- Check signatures with `verifyWhatsAppWebhookSignature` and the phone number with `verifyWhatsAppWebhookConnectionBinding` (both in `whatsapp-webhook.ts`), against the draft's `phoneNumberId`.
- Read messages straight from the payload, matching `text.body.trim() === draft.draft.setupCode`, as Slack's `senderOfCode` does.
- Keep `Map<draftId, WhatsAppSetupHeard & { touchedAt: number }>`. A note refreshes `touchedAt`. Over 32 entries, drop the one with the oldest `touchedAt`.

**Routes.** Keep the existing connection path unchanged. The listener runs only when `getIntegrationConnection` throws not-found. The POST's 256 KB limit, raw body and rate limits apply to the draft path too.

**Allowance.** Measure the listener with the repository counters and add its C0 entry:
- `reason`: the WhatsApp setup listener for the Messaging setup page.
- `evidence`: this test file and the measured counts.
- If the counts exceed the cap, stop and ask.

- [ ] **Step 4: Run the tests and the gates**

Run: the Step 2 command, then `pnpm verify:architecture:metrics` and `pnpm verify:gateway:async-boundary`.
Expected: PASS. `gateway-route-composition-integrations.ts` stays ≤ 105.

- [ ] **Step 5: Commit**

```bash
git add apps/gateway packages/contracts scripts/verification/baselines/architecture-new-service-allowances.json
git commit -m "feat(whatsapp): answer Meta's address check and hear the setup code before Turn on"
```

---

### Task 5: WhatsApp setup check and subscribe routes

**Files:**
- Modify: `packages/contracts/src/channel-setup-checks.ts`
- Create: `apps/gateway/src/services/channel-setup-whatsapp-check.ts`
- Create: `apps/gateway/src/services/channel-setup-whatsapp-check.test.ts`
- Modify: `apps/gateway/src/services/channel-setup-service.ts` (export line, like `checkSlackSetup`)
- Modify: `apps/gateway/src/services/channel-setup-route-service.ts` (`channelSetupRouteMethods`, `createChannelSetupRoutePort`)
- Modify: `apps/gateway/src/services/gateway-route-composition-integrations.ts` (two lines beside :139-140, passing Task 4's listener)
- Modify: `apps/gateway/src/routes/integrations-channel-setup-routes.ts` (two routes beside the Slack one)
- Modify: `packages/mission-control-shared/src/api/channel-setup-operations.ts`
- Modify: `scripts/verification/baselines/architecture-new-service-allowances.json`
- Test: `apps/gateway/src/routes/integrations.channel-setup.test.ts`

**Interfaces:**
- Produces, in contracts:
  ```ts
  export interface WhatsAppSetupCheckInput extends ChannelSetupCheckDraftRef {
    /** Ask Meta about the number, the token, the app and the account. Without it, only what GoatCitadel heard is returned. */
    askMeta?: boolean;
    /** The code the page is listening for. */
    setupCode?: string;
  }
  export interface WhatsAppSetupCheckResult {
    /** With askMeta: the business number as Meta shows it, and the name Meta verified. */
    number?: { displayNumber: string; verifiedName: string };
    /** With askMeta: when the access token stops working. Absent when it never does. */
    tokenExpiresAt?: string;
    /** With askMeta: the app gets the account's messages. */
    appSubscribed?: boolean;
    /** When Meta last checked this setup's web address with its verify token, in the last 15 minutes. */
    addressCheckedAt?: string;
    /** Who sent `setupCode`, when it is the code the listener heard. */
    codeSender?: WhatsAppSetupCodeSender;
  }
  export interface WhatsAppSetupSubscribeResult { appSubscribed: true }
  ```
- Produces, in gateway:
  - `checkWhatsAppSetup(host, listener, input): Promise<WhatsAppSetupCheckResult>`
  - `subscribeWhatsAppSetupApp(host, input: ChannelSetupCheckDraftRef): Promise<WhatsAppSetupSubscribeResult>`
  - the routes `POST /api/v1/channels/whatsapp/setup-check` and `POST /api/v1/channels/whatsapp/setup-subscribe`
- Produces, in the shared client: `checkWhatsAppSetup(input)` and `subscribeWhatsAppSetupApp(input)`.
- Fixed errors, as `ValidationError` messages:

  | Constant | Message |
  |---|---|
  | `WHATSAPP_TOKEN_REJECTED` | "Meta didn't accept the access token." |
  | `WHATSAPP_NUMBER_NOT_FOUND` | "Meta couldn't find that phone number ID for this access token." |
  | `WHATSAPP_APP_REJECTED` | "Meta didn't accept that App ID and App secret together." |
  | `WHATSAPP_OTHER_APP` | "That access token was made for a different Meta app." |
  | `WHATSAPP_ACCOUNT_NOT_FOUND` | "Meta couldn't find that WhatsApp Business Account for this access token." |
  | `WHATSAPP_NUMBER_NOT_IN_ACCOUNT` | "That phone number isn't in that WhatsApp Business Account." |
  | `WHATSAPP_SUBSCRIBE_REFUSED` | "Meta didn't let this app receive the account's messages. Check that the access token can manage the account." |
  | `WHATSAPP_UNREACHABLE` | "GoatCitadel couldn't reach Meta." |
  | `WHATSAPP_DETAILS_MISSING` | "Paste all five WhatsApp details first." |
  | `WHATSAPP_DRAFT_ONLY` | "Choose a WhatsApp setup draft to check." |

- [ ] **Step 1: Write the failing tests**

`channel-setup-whatsapp-check.test.ts` uses the fake setup host with a scripted `fetchWithTimeout`. The draft holds `phoneNumberId: "106540352242922"`, `businessAccountId: "102290129340398"` and `appId: "670843887433847"`, with `accessToken` and `appSecret` as draft secrets.
- `it("names the number and says the token never expires")`:
  - `/106540352242922?fields=display_phone_number,verified_name` returns `{display_phone_number: "+1 555-078-3881", verified_name: "Goat Shop"}`.
  - `debug_token` returns `{data: {app_id: "670843887433847", is_valid: true, expires_at: 0}}`.
  - `/102290129340398/phone_numbers` lists the number.
  - `subscribed_apps` lists `{whatsapp_business_api_data: {id: "670843887433847"}}`.
  - The result is `{number: {displayNumber: "+1 555-078-3881", verifiedName: "Goat Shop"}, appSubscribed: true}`, with no `tokenExpiresAt`.
- `it("says when a short-lived token stops working")`. `expires_at: 1767225600` gives `tokenExpiresAt: "2026-01-01T00:00:00.000Z"`.
- `it("asks Meta in a fixed order with the right credentials")`:
  - The calls go in this order: number, `debug_token`, `phone_numbers`, `subscribed_apps`.
  - The access token is only ever in an `Authorization: Bearer` header, and in `debug_token`'s `input_token`.
  - The app token `670843887433847|<secret>` is only in `debug_token`'s `Authorization` header.
- `it("maps each refusal to its sentence")`:

  | Meta's answer | Sentence |
  |---|---|
  | 401 on the number | TOKEN_REJECTED |
  | 400 with `error.code` 100 on the number | NUMBER_NOT_FOUND |
  | 400 on `debug_token` | APP_REJECTED |
  | `is_valid: false` | TOKEN_REJECTED |
  | another `app_id` | OTHER_APP |
  | 400 on `phone_numbers` | ACCOUNT_NOT_FOUND |
  | a list without the number | NUMBER_NOT_IN_ACCOUNT |
  | a `fetch` rejection | UNREACHABLE |

  No message contains the token, the secret or `input_token`.
- `it("asks Meta nothing without askMeta")`. With only `setupCode`, no fetch is made. The result has `addressCheckedAt` and `codeSender` from the listener when its `code` equals `setupCode`, and no `codeSender` when it doesn't.
- `it("needs all five details before asking Meta")`. With `askMeta`, a draft without `businessAccountId` throws `WHATSAPP_DETAILS_MISSING`. Without `askMeta`, it isn't asked for.
- `it("subscribes the app on request")`:
  - `subscribeWhatsAppSetupApp` POSTs `/102290129340398/subscribed_apps` with no body and returns `{appSubscribed: true}`.
  - A 403 throws `WHATSAPP_SUBSCRIBE_REFUSED`.
- `it("checks only WhatsApp drafts")`. A Slack draft throws `WHATSAPP_DRAFT_ONLY`.

Route tests:
- Both bodies are strict, with `draftId: z.guid()` and `expectedRevision` a positive integer.
- `setupCode` matches `^[A-Za-z0-9]{6,32}$`.
- Responses have `cache-control: no-store`.
- A `ValidationError` is 400 with its message.
- Both routes are in the operator access class.

- [ ] **Step 2: Run them to verify they fail**

Run (from `apps/gateway`): `pnpm exec vitest run src/services/channel-setup-whatsapp-check.test.ts src/routes/integrations.channel-setup.test.ts --maxWorkers=2`
Expected: FAIL.

- [ ] **Step 3: Implement**

**Service.** Mirror `checkSlackSetup`:
1. Load the draft, check it's a WhatsApp draft, and check `expectedRevision`.
2. Build the ephemeral connection.
3. Resolve `accessToken`/`accessTokenEnv` and `appSecret`/`appSecretEnv` with the draft owner.
4. Fetch with `host.fetchWithTimeout` and read bounded JSON as Slack's check does.

The listener's `heard()` gives `addressCheckedAt` and the code match. A route accepts any WhatsApp draft, create or rotate, so Task 9 can use it.

**Routes.** Same options as the Slack route: `logLevel: "silent"`, a rate limit of 20 a minute, and `no-store`.

**Allowance.** Measure the new file and add its C0 entry, as in Task 4.

- [ ] **Step 4: Rebuild contracts and the shared client, then run the tests and the gates**

Run: both builds, the Step 2 command, `pnpm verify:architecture:metrics` and `pnpm verify:gateway:async-boundary`.
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages apps/gateway scripts/verification/baselines/architecture-new-service-allowances.json
git commit -m "feat(whatsapp): check a setup's details with Meta and subscribe its app"
```

---

### Task 6: WhatsApp's 24-hour reply window

**Files:**
- Create: `packages/contracts/src/channel-reply-window.ts`, exported from the contracts index
- Create: `packages/contracts/src/channel-reply-window.test.ts`
- Modify: `packages/storage/src/chat-message-repo.ts` (`latestChannelMessageAt`, beside `countAfter` at :619-627)
- Test: `packages/storage/src/chat-message-repo.test.ts`
- Modify: `apps/gateway/src/services/channel-desk-turn.ts` (`routeOperatorDeskSend` input and its window check)
- Test: `apps/gateway/src/services/channel-desk-turn.test.ts`
- Modify: `apps/gateway/src/services/gateway-service.ts` (one line in `sendOperatorDeskMessage`, :4936)
- Modify: `apps/mission-control-next/src/cockpit/areas/chat/channel-conversation.ts` (`channelKey` on `ChannelConversationContext`; `latestChannelTurnAt(turns)` beside `findNewChannelMessages`)
- Modify: `apps/mission-control-next/src/cockpit/areas/chat/channel-composer.ts` (a new `channelReplyBlock` kind)
- Modify: `apps/mission-control-next/src/cockpit/areas/chat/use-channel-composer.ts`
- Test: the tests beside those three Cockpit files

**Interfaces:**
- Produces, in contracts:
  ```ts
  export const WHATSAPP_REPLY_WINDOW_MS = 24 * 60 * 60 * 1000;
  export const WHATSAPP_REPLY_WINDOW_CLOSED =
    "WhatsApp allows a reply only within 24 hours of their last message. Once they message again, you can reply.";
  /** Whether a reply in this channel's conversation is outside the provider's window. Only WhatsApp has one. */
  export function isChannelReplyWindowClosed(channelKey: string | undefined, lastInboundAt: string | undefined, now: Date): boolean;
  ```
- Produces, in storage: `ChatMessageRepository.latestChannelMessageAt(sessionId: string): string | undefined`. This is the newest `timestamp` among role `user` messages with source authority `external_channel`.
- Produces, in gateway: `routeOperatorDeskSend`'s input gains `lastInboundAt?: string` and `now?: () => Date`. A closed window gives `{ mode: "blocked", message: WHATSAPP_REPLY_WINDOW_CLOSED }`, which the route already turns into a 409.
- Produces, in the Cockpit: `channelReplyBlock` returns `{ kind: "reply-window-closed", message: WHATSAPP_REPLY_WINDOW_CLOSED }` for a WhatsApp conversation whose window is closed.

- [ ] **Step 1: Write the failing tests**

- **Contracts:** `it("closes WhatsApp's window at 24 hours and never closes another channel's")`. With `now` at `2026-10-29T12:00:00Z`:
  - `whatsapp` with a last message at `2026-10-28T12:00:00Z` is closed;
  - at `2026-10-28T12:01:00Z` it's open;
  - with `undefined` it's closed;
  - `telegram` with `undefined` is open.
- **Storage:** `it("finds the person's newest message, never a reply")`:
  - Two `external_channel` user messages, an assistant reply and an operator message are stored.
  - `latestChannelMessageAt` is the newer external one.
  - A session with none gives `undefined`.
- **Gateway:** `it("refuses a WhatsApp desk send outside the window, in both modes")`:
  - With a WhatsApp connection and `lastInboundAt` 25 hours ago, `routeOperatorDeskSend` gives `blocked` with `WHATSAPP_REPLY_WINDOW_CLOSED`.
  - This holds for the operator's own conversation (ask) and for someone else's (post). `acceptOperatorDeskEvent` isn't called.
  - With 1 hour ago it goes on as today.
  - A Telegram connection with no `lastInboundAt` goes on as today.
- **Cockpit:** `it("blocks the WhatsApp composer with the window sentence")`:
  - A conversation with `channelKey: "whatsapp"` whose newest `external_channel` turn is 25 hours old shows the sentence as the composer's reason, and the textarea is disabled.
  - At 1 hour old, nothing is blocked.
  - The reason line is the composer's existing one, so no new `role="status"`.

- [ ] **Step 2: Run them to verify they fail**

Run each package's test for the files above, with `--maxWorkers=2`.
Expected: FAIL.

- [ ] **Step 3: Implement**

- **Storage:** add a prepared `SELECT MAX(timestamp)` statement with `countChannelMessagesAfterStmt`'s `WHERE`.
- **`gateway-service.ts`:** add exactly one line, `const lastInboundAt = await this.storage.chatMessages.latestChannelMessageAt(sessionId);`. Pass `lastInboundAt` in the existing object literal; it must stay on one line.
- **`channel-desk-turn.ts`:** check the window after `blocked` is decided, before `post` returns, using `connection.key`. In this file, "now" is `input.now?.() ?? new Date()`.
- **Cockpit:**
  - `describeChannelConversation` copies `channelKey` from the overview channel.
  - `use-channel-composer.ts` reads the newest external turn from `active.thread.turns` with `latestChannelTurnAt`.
  - `ChatArea.tsx` is at its cap and isn't changed.

- [ ] **Step 4: Run the tests and the gates**

Run: the Step 2 commands, the four Cockpit guards, `pnpm verify:gateway:async-boundary` and `pnpm verify:architecture:metrics`.
Expected: PASS. `gateway-service.ts` is 13127 lines.

- [ ] **Step 5: Commit**

```bash
git add packages apps
git commit -m "feat(chat): say when WhatsApp's 24-hour reply window has closed, and refuse the send"
```

---

### Task 7: WhatsApp setup model and hook

**Files:**
- Create: `apps/mission-control-next/src/cockpit/areas/chat/channel-setup/whatsapp-setup-model.ts`
- Create: `apps/mission-control-next/src/cockpit/areas/chat/channel-setup/whatsapp-setup-model.test.ts`
- Create: `apps/mission-control-next/src/cockpit/areas/chat/channel-setup/whatsapp-choices.ts` (save helpers and the one-poll ask, as `slack-choices.ts` does)
- Create: `apps/mission-control-next/src/cockpit/areas/chat/channel-setup/use-whatsapp-setup.ts`
- Create: `apps/mission-control-next/src/cockpit/areas/chat/channel-setup/use-whatsapp-setup.test.ts`

**Interfaces:**
- Consumes: Task 5's `checkWhatsAppSetup` and `subscribeWhatsAppSetupApp`. From plans 2 and 3: `useSetupState`, `chatSetupToResume`, `markedChatSetupDraft`, `latestDraft`, `listenForHi`, `createSetupCode`, `SETUP_CODE_ALPHABET` and `SAY_HI_POLL_MS`.
- Produces, in the model:
  ```ts
  export const WHATSAPP_CATALOG_ID = "channel.whatsapp";
  export interface WhatsAppDetails { accessToken: string; phoneNumberId: string; businessAccountId: string; appId: string; appSecret: string }
  /** The first detail that's missing or the wrong shape, as one sentence, or undefined. */
  export function whatsAppDetailsProblem(details: WhatsAppDetails): string | undefined;
  /** 32 characters from SETUP_CODE_ALPHABET, from crypto.getRandomValues. */
  export function createVerifyToken(): string;
  /** https://wa.me/<digits of displayNumber>?text=<code>. */
  export function waMeLink(displayNumber: string, code: string): string;
  /** Only the sender may message the bot, they own the setup, and their WhatsApp is where it posts. The input isn't changed. */
  export function whatsAppDraftWithSender(values: Record<string, unknown>, sender: WhatsAppSetupCodeSender): Record<string, unknown>;
  /** Who said hi, as whatsAppDraftWithSender saved it, or null. */
  export function savedWhatsAppSender(values: Record<string, unknown>): WhatsAppSetupCodeSender | null;
  ```
- Produces, in the hook, `useWhatsAppSetup(workspaceId: string, resumeDraftId?: string): WhatsAppSetupState`:
  - **State:**
    - `draft`
    - `number: {displayNumber, verifiedName} | null`
    - `tokenExpiresAt?: string`
    - `verifyToken: string | null` (held in page memory only)
    - `addressCheckedAt?: string`
    - `appSubscribed: boolean`
    - `sender`
    - `code`
    - `codeExpired`
    - `busy`
    - `error?`
  - **Actions:**
    - `checkDetails(details)`
    - `newVerifyToken()`
    - `subscribeApp()`
    - `newCode()`
    - `startOver()`
- Fixed sentences, in the model:

  | Constant | Sentence |
  |---|---|
  | `WHATSAPP_CHECK_FAILED` | "GoatCitadel couldn't check those details with Meta." |
  | `WHATSAPP_ADDRESS_WAITING` | "Waiting for Meta to check your address…" |
  | `WHATSAPP_ADDRESS_CHECKED` | "Meta checked your address just now." |
  | `WHATSAPP_WAITING_FOR_HI` | "Waiting for your message…" |
  | `WHATSAPP_CODE_EXPIRED` | "The code ran out. Make a new one to try again." |

  Any failed check or subscribe says the gateway's 400 sentence when there is one. Otherwise it says `WHATSAPP_CHECK_FAILED`.

- [ ] **Step 1: Write the failing tests**

Model:
- `whatsAppDetailsProblem` names, in field order:
  - an empty field: "Paste the <label> first.";
  - a non-digit ID: "<label> is digits only.".
- `waMeLink("+1 555-078-3881", "Kp4mZ9qRtW")` is `"https://wa.me/15550783881?text=Kp4mZ9qRtW"`.
- `createVerifyToken()` is 32 characters, all from `SETUP_CODE_ALPHABET`, and two calls differ.
- `whatsAppDraftWithSender({label: "kept"}, {actorId: "16505551234", displayName: "Sheena"})` adds `allowedSenders: ["16505551234"]`, `ownerActorIds: ["16505551234"]`, `inboundAccessMode: "allowlist"` and `defaultTarget: "16505551234"`. It keeps `label` and doesn't change its input.
- `savedWhatsAppSender` reads that back. It's null without all four keys.

Hook, modelled on `use-slack-setup.test.ts`:
- `it("marks a new draft before storing anything, then stores the details in one write")`:
  - The order is: create, mark (`setupPage: "messaging"`), then one `submitChannelSetupDraftSecrets` with `accessToken`, `appSecret` and a fresh `webhookVerifyToken`.
  - Then one update with `phoneNumberId`, `businessAccountId` and `appId`.
  - Then `checkWhatsAppSetup({askMeta: true})`.
  - `verifyToken` is the stored one, and no token is in the returned state except `verifyToken`.
- `it("shows the number and the token's end")`. The check's `number` and `tokenExpiresAt` land in the state.
- `it("listens for Meta's check, notes it on the draft once, and stops")`:
  - The hook asks every `SAY_HI_POLL_MS` with no `askMeta`.
  - When `addressCheckedAt` arrives, it writes `webhookCheckedAt` to the draft once.
- `it("subscribes the app only when Meta says it isn't")`.
- `it("hears the code, saves the sender, and stops asking")`. Writes use `whatsAppDraftWithSender`.
- `it("comes back to a setup")`:
  - A resumed draft with both secrets and all three IDs stored is checked again with `askMeta: true`, so the number shows. It writes nothing.
  - With `webhookCheckedAt` set and no sender, it resumes at "say hi", with `verifyToken` null.
  - Without `webhookCheckedAt`, `newVerifyToken` stores a new `webhookVerifyToken` and shows it.
- `it("starts over by discarding the draft")`.

- [ ] **Step 2: Run them to verify they fail**

Run (from `apps/mission-control-next`): `pnpm exec vitest run src/cockpit/areas/chat/channel-setup/whatsapp-setup-model.test.ts src/cockpit/areas/chat/channel-setup/use-whatsapp-setup.test.ts --maxWorkers=2`
Expected: FAIL.

- [ ] **Step 3: Implement**

Follow `use-slack-setup.ts` for the generation counter, `useSetupState`, `listenForHi` and the resume path. Keep the hook under 400 lines by moving writes into `whatsapp-choices.ts`. The hook asks about Meta's check and about the hi with the same no-`askMeta` call; the two waits don't overlap, because "say hi" opens only after the address step is done.

- [ ] **Step 4: Run the tests and the Cockpit guards**

Run: the Step 2 command and the four guard scripts.
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/mission-control-next/src/cockpit/areas/chat/channel-setup
git commit -m "feat(cockpit): the WhatsApp setup's model and state"
```

---

### Task 8: WhatsApp setup page

**Files:**
- Create: `apps/mission-control-next/src/cockpit/areas/chat/channel-setup/WhatsAppSetupPage.tsx`
- Create: `apps/mission-control-next/src/cockpit/areas/chat/channel-setup/WhatsAppDetailsStep.tsx`
- Create: `apps/mission-control-next/src/cockpit/areas/chat/channel-setup/WhatsAppAddressStep.tsx`
- Create: `apps/mission-control-next/src/cockpit/areas/chat/channel-setup/WhatsAppSayHiStep.tsx`
- Create: `apps/mission-control-next/src/cockpit/areas/chat/channel-setup/WhatsAppSetupPage.test.tsx`
- Modify: `apps/mission-control-next/src/cockpit/areas/chat/channel-setup/ChannelSetupView.tsx` (`SETUP_PAGES`)
- Modify: `apps/mission-control-next/src/cockpit/areas/chat/channel-setup/channel-picker-model.ts` (`CONVERTED_SETUP_CHANNELS` adds `whatsapp`)
- Test: `channel-picker-model.test.ts`

**Interfaces:**
- Consumes: Task 7's hook and model, Task 2's `PublicWebAddressField` and `usePublicWebAddress`, Task 1's `publicWebAddressFor`, plan 2's `TurnOnStep`/`useTurnOn`, and `QrCode`.
- Produces: `WhatsAppSetupPage({workspaceId, resumeDraftId}: SetupPageProps)`.

**Steps of the page, in order. Each opens when the one before is done:**

1. **"Give GoatCitadel a public web address."**
   - The body says: "Meta delivers WhatsApp messages only to a public https:// address. Use your own domain, reverse proxy or tunnel; GoatCitadel doesn't provide one."
   - It renders `PublicWebAddressField`.
   - Done when `usePublicWebAddress()` is set. The result line is the address.
2. **"Make your Meta app."**
   - A short ordered list:
     1. Open developers.facebook.com/apps and create an app for WhatsApp ("Connect with customers through WhatsApp").
     2. In API Setup, note the Phone number ID and the WhatsApp Business Account ID (Meta's test number is fine).
     3. In App settings › Basic, note the App ID and App secret.
     4. In Business Settings › System users, make a token for this app with whatsapp_business_messaging and whatsapp_business_management.
   - The link opens `https://developers.facebook.com/apps` in a new tab.
   - It's always open, and done when step 3 is.
3. **"Paste your WhatsApp details"** (`WhatsAppDetailsStep`).
   - Five fields:
     - the access token and App secret, as masked `TokenField`s;
     - the three IDs, as numeric text inputs.
   - **Check** runs `checkDetails`. The result line reads "Works. Your number is <displayNumber> (<verifiedName>)."
   - With `tokenExpiresAt`, a `Callout` (`announce={false}`, not danger) says "This token stops working <TimeText>. Make a system user's token in Business Settings so WhatsApp keeps working, then paste it here."
4. **"Point Meta at GoatCitadel"** (`WhatsAppAddressStep`).
   - Two read-only copy fields:
     - **Callback URL:** `publicWebAddressFor(address, "/api/v1/integrations/connections/<draftId>/whatsapp/webhook")`;
     - **Verify token:** the hook's `verifyToken`, or a **Make a new verify token** button when it's null and Meta hasn't checked.
   - The text says: "In your Meta app, open WhatsApp › Configuration. Paste these into Callback URL and Verify token, choose Verify and save, then subscribe to messages."
   - The step's status is `WHATSAPP_ADDRESS_WAITING` until `addressCheckedAt` arrives, then `WHATSAPP_ADDRESS_CHECKED`.
   - When `appSubscribed` is false, a button **Let this app receive your number's messages** runs `subscribeApp`.
   - Done when the address is checked and the app is subscribed.
5. **"Say hi from your phone"** (`WhatsAppSayHiStep`).
   - It shows the code, a `QrCode` and a link to `waMeLink(displayNumber, code)`.
   - The text says: "Open the link on your phone and send the message as it is. With Meta's test number, your phone may first need to be added under API Setup › To."
   - The status is `WHATSAPP_WAITING_FOR_HI`, `WHATSAPP_CODE_EXPIRED` with **New code**, or "<displayName or number> can message your bot."
6. **Turn on** (`TurnOnStep`).
   - The changes are:
     - "Only <name> can message your WhatsApp bot."
     - "Replies go to <name> on WhatsApp."
     - "GoatCitadel sends <name> a test message. WhatsApp can't remove it afterwards."
     - any missing host from `useChannelSetupHosts`, which here is `graph.facebook.com`.
   - `WHATSAPP_TURN_ON_WORDING` has:
     - button "Turn on WhatsApp";
     - working "Turning on WhatsApp…";
     - done "WhatsApp is on.";
     - doneLink "Open WhatsApp's page";
     - `cleanup` set to the sentence Slack's wording uses.
   - Done links to `chatPageHref(draftId)`. A create draft's connection keeps the draft's id, so the Callback URL in step 4 stays right after Turn on.

- [ ] **Step 1: Write the failing tests**

`WhatsAppSetupPage.test.tsx`, modelled on `SlackSetupPage.test.tsx`, with the hook's client calls mocked:
- `it("asks for a public web address first and opens the rest once it is set")`.
- `it("shows the Callback URL built from the public web address and the draft")`.
- `it("shows the token's end as a calm note")`.
- `it("offers to subscribe the app only when Meta says it isn't")`.
- `it("shows the code, the QR code and the wa.me link")`.
- `it("lists what Turn on changes, including graph.facebook.com when it is missing")`.
- `it("never renders the access token or the App secret")`.
- `it("has one status line")`. There's exactly one `role="status"` in the page.

`channel-picker-model.test.ts`: the WhatsApp tile links to `/chat/messaging/add/whatsapp`, and Settings' "Set up in Chat" links resolve for a WhatsApp draft made on the page.

- [ ] **Step 2: Run them to verify they fail**

Run (from `apps/mission-control-next`): `pnpm exec vitest run src/cockpit/areas/chat/channel-setup/WhatsAppSetupPage.test.tsx src/cockpit/areas/chat/channel-setup/channel-picker-model.test.ts --maxWorkers=2`
Expected: FAIL.

- [ ] **Step 3: Implement**

Follow `SlackSetupPage.tsx` and its step files. Keep each file under 400 lines.

- [ ] **Step 4: Run the tests, the Cockpit guards and the build**

Run: the Step 2 command, `pnpm exec vitest run src/cockpit/areas/chat/channel-setup --maxWorkers=2`, the four guard scripts and `pnpm --filter @goatcitadel/mission-control-next build`.
Expected: PASS. Live regions stay at 900.

- [ ] **Step 5: Commit**

```bash
git add apps/mission-control-next/src/cockpit/areas/chat/channel-setup
git commit -m "feat(cockpit): set up WhatsApp from Chat › Messaging"
```

---

### Task 9: Change WhatsApp's key from Chat

**Files:**
- Modify: `apps/mission-control-next/src/cockpit/areas/chat/channel-setup/token-change-channels.ts` (a `WHATSAPP` entry)
- Modify: `apps/mission-control-next/src/cockpit/areas/chat/channel-setup/TokenChangeFields.tsx` (`WhatsAppTokenFields`: one masked access token field)
- Modify: `apps/mission-control-next/src/cockpit/areas/chat/channel-setup/channel-picker-model.ts` (`KEY_CHANGE_CHANNELS` adds `whatsapp`)
- Modify: `apps/mission-control-next/src/cockpit/areas/chat/channel-setup/ChannelSetupView.tsx` (`KEY_CHANGE_PAGES`)
- Test: `token-change-channels.test.ts` and `channel-picker-model.test.ts`

**Interfaces:**
- Consumes: Task 5's `checkWhatsAppSetup` with `askMeta: true`.
- Produces: the `WHATSAPP` `TokenChangeChannel`:
  - `title`: "Change WhatsApp's access token"
  - `savedBotKey`: `"phoneNumberId"`
  - `secretValues`: `{ accessToken }`
  - `check` gives `botId` = the draft's `phoneNumberId`, `botName` = `verifiedName`, and `works` = "Token works for <displayNumber> (<verifiedName>)."
  - `failed`: `WHATSAPP_CHECK_FAILED`
  - `wording` is `saveKeyWording` with done "Saved. WhatsApp uses the new token now." and doneLink "Back to WhatsApp's page".

- [ ] **Step 1: Write the failing tests**

- `hasChatKeyChangePage` is true for a WhatsApp connection.
- The WhatsApp entry stores only `accessToken`.
- A check that throws gives `failed`.
- A good check names the number.

- [ ] **Step 2: Run them to verify they fail**

Run (from `apps/mission-control-next`): `pnpm exec vitest run src/cockpit/areas/chat/channel-setup/token-change-channels.test.ts src/cockpit/areas/chat/channel-setup/channel-picker-model.test.ts --maxWorkers=2`
Expected: FAIL.

- [ ] **Step 3: Implement**

Follow the `SLACK` entry. A token that expires is saved without a note on this page (follow-up).

- [ ] **Step 4: Run the tests and the Cockpit guards**

Run: the Step 2 command and the four guard scripts.
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/mission-control-next/src/cockpit/areas/chat/channel-setup
git commit -m "feat(cockpit): change WhatsApp's access token from its channel page"
```

---

### Task 10: Docs, lanes and browser proof

**Files:**
- Modify: `docs/CHANNEL_GUIDED_SETUP.md`:
  - a "WhatsApp quick setup" section after Slack's, covering what the operator does by hand, each step, the listener, the window and the key page;
  - a "Public web address" section.
- Modify: `docs/COMMUNICATION_CHANNEL_SETUP_GUIDE.md`:
  - the WhatsApp section names the Chat page and the five values;
  - every `https://<your-gateway-host>/…` placeholder says the address starts with the public web address from Settings › Channels.
- Modify: `CHANGELOG.md` ([Unreleased])
- Modify: this plan, adding an "As built" section with every ruling made while building

- [ ] **Step 1: Update the docs**

Each doc line must match what the code does, including:
- the five values;
- the 15-minute listener;
- the window's two refusals;
- that agent answers aren't checked;
- that pairing for others isn't there yet.

- [ ] **Step 2: Run the lanes**

Run, one at a time:
- `pnpm typecheck`
- `pnpm docs:check`
- `pnpm verify:gateway:async-boundary`
- `pnpm verify:architecture:metrics`
- `pnpm verify:channels:parity`
- the four Cockpit guards
- `pnpm --filter @goatcitadel/mission-control-next build`
- `pnpm --filter @goatcitadel/mission-control-next perf:check`
- `pnpm verify:fast`
- `git diff --check`

Expected: exit 0 for each. A `verify:fast` failure in a file this plan doesn't touch is rerun alone and reported with its output, never hidden.

- [ ] **Step 3: Browser proof in a sandbox**

Use a throwaway gateway (scratch root, home and backups; keychain off; token auth) with every outbound request blocked, and the worktree's Vite build. Meta's answers come from a local stub, the way plan 3's proof stubbed Discord and Slack. Walk the page:
- set the address;
- paste details;
- send a signed fake verification GET and a signed fake code delivery to the draft's address;
- turn on.

Then check, on screen and in network requests:
- each step's sentences;
- one status line;
- phone width and both themes;
- no token or secret in any response body or rendered text, apart from the verify token where it is shown;
- no request to `graph.facebook.com`.

- [ ] **Step 4: Commit**

```bash
git add docs CHANGELOG.md
git commit -m "docs(channels): WhatsApp quick setup and the public web address"
```

Not run here: the real-account checks. The operator does them after merge:
- create a Meta app;
- paste the five values;
- set the Callback URL;
- say hi;
- turn on;
- reply within the window;
- try a reply after 24 hours.

### As built

What changed from the tasks above (rulings made before the build, P1 to P6, while Tasks 1 to 9 were built and reviewed, R1 to R17, and in the final review's fix wave, R18′ to R24 and F5 to F10):
- **P1:** Task 4 creates the one setup listener in `gateway-route-composition-integrations.ts` and passes it to the webhook port only; Task 5 adds the channel-setup port wiring that passes the same instance. The plan's Task 4 text named a port that did not exist yet.
- **P2:** Task 2 also exports `usePublicWebAddressSettings()` (the same `fetchSettings` query key `useMissingHosts` uses), and `usePublicWebAddress()` derives from it. Task 8 renders `PublicWebAddressField` with that settings object and a short loading line while it is undefined.
- **P3:** `checkDetails` makes and stores a new verify token only when the draft has none stored and the page holds none in memory. A check repeated after a typo therefore never invalidates a Callback URL Meta already checked. After a reload a stored token is shown only through "Make a new verify token".
- **P4:** the wait for Meta's address check uses the same 10-minute limit as the hi. On expiry the address step says "Meta hasn't checked your address yet. Choose Verify and save in Meta, then check again." and offers **Check again**, which restarts the wait. The plan gave the wait no end.
- **P5:** `checkPublicWebAddress` in contracts keeps its own copy of the private and loopback range logic, with a comment pointing at policy-engine's `isPrivateOrReservedHost`. Contracts cannot import policy-engine, and the Cockpit needs the same check.
- **P6:** the page's two waits poll every 6 seconds (`WHATSAPP_LISTEN_POLL_MS = 6_000`, as Slack's), not 4 seconds as Task 7's text says. The setup-check route allows 20 calls a minute, and 15 a minute of polling would leave too little for the page's own Meta checks.
- **R1:** `getSettings` reads `deps.config.assistant` once into a local (`settings-auth-service.ts` dependency accesses 278 to 230) instead of taking an allowance. The pinned baseline still says 278, so 48 reads of headroom exist.
- **R2:** the operation type `PublicWebAddressRuntimeOperation` and its shape validator live in contracts `public-web-address.ts`, not `change-plan.ts`, which would have passed its 1000-line ESLint cap (`web-search.ts` is the precedent).
- **R3:** `config-sync-lib.ts` also changed (unlisted), so the setting is saved and cleared across restarts.
- **R4:** the policy-engine `change_plan` tool schema stays without the new operation. The operator sets this address; a model in Chat cannot propose a change to it.
- **R5:** the shared governed-setting hook (`use-governed-runtime-setting.ts`) gained optional `normalize`, `onSaved` and `save(value?)`, and `ChannelWebhookAddress` makes its own query client in Classic. Without them every save ended "outcome uncertain" and the Classic guide crashed. Existing callers are unchanged.
- **R6:** `GUIDED_CONTENT_VERSION_SUFFIX` is `.guided-2026-10-29-whatsapp`. The plan asked for that day's date and for a value different from `.guided-2026-10-29`, and the build day was 2026-10-29.
- **R7:** a Graph error body with `error.code === 190` reads as "Meta didn't accept the access token." on every call that sends the access token, whatever the HTTP status. An expired temporary token otherwise read "GoatCitadel couldn't reach Meta." `debug_token` is excluded: it uses the app token, and a 400 there is still the App ID and secret being refused.
- **R8:** the check reads only the first 100 numbers of an account and never follows `paging.next`, whose address carries the access token. An account with more than 100 numbers could be told its number is not in the account.
- **R9:** parsing is strict: a Meta answer missing `expires_at` or `verified_name` reads as "GoatCitadel couldn't reach Meta." rather than as "never expires" or an invented name.
- **R10:** Turn on's cleanup sentence names WhatsApp ("GoatCitadel couldn't remove its test message. Delete it in WhatsApp if you like."), not Slack's literal "Delete it in Slack".
- **R11:** `PublicWebAddressField` keeps its own save-status lines on the WhatsApp page. They belong to the shared governed-save control and announce the operator's own save, so up to two status regions exist while the address is being saved. The page's own status line stays `SetupSteps`'.
- **R12:** the expiring-token note reads "This token stops working <time>. Make a system user's token in Business Settings so WhatsApp keeps working, then change the key from WhatsApp's page once it's on." Step 3 stays closed, because reopening it would need all five values again and Start over would break the Callback URL. A permanent token cannot be pasted before Turn on without starting over.
- **R13:** step 4's result and anything not heard in this page session say "Meta has checked your address."; "…just now." appears only at the moment the check is first seen (a new hook flag, `addressCheckedHere`). A resume whose first question carries a check Meta made in the last 15 minutes still says "just now".
- **R14:** `hasChatKeyChangePage` is true for WhatsApp only when the connection keeps `phoneNumberId`, `businessAccountId`, `appId` and `appSecret` or `appSecretEnv`. The page re-pastes the access token alone and the check needs the other four, so an older Settings-made, send-only connection keeps its Settings link.
- **R15:** `TokenChangeChannel.testMessage` is optional, so WhatsApp's save step can say its test message cannot be removed; the shared line says it is removed.
- **R16:** the one-line, test-only fixture fix (`a754cfa38`, `ChatArea.visible-session.test.tsx` turns gain a `userMessage`) got no separate re-review; the final whole-branch review covers it.
- **R17:** the key page's test-message line reads "GoatCitadel sends a test message where your bot posts. WhatsApp delivers it only within 24 hours of that person's last message to your number, so have them message it first. WhatsApp can't remove it afterwards." The save flow is unchanged, so a key change days after the person last wrote can still be blocked by the window.
- **Review fixes** (one round each; rulings above where they made one): Task 4 applies the accepted-delivery rate limit to a verified draft delivery, in its own bucket with the saved connection's limit, window and key shape (`806723e87`); Task 7 restarts the address wait after a failed `webhookCheckedAt` note (`0fee7898f`); Task 8 carries R12 and R13 (`0117160f8`); Task 9 carries R17 (`93769b76d`).
- **Allowances and counts:** the two approved C0 entries were set to the measured counts, `whatsapp-setup-listener.ts` 2 host callbacks and 2 dependency reads, and `channel-setup-whatsapp-check.ts` 3 and 3 (each cap 10 and 10 approved). `gateway-route-composition-integrations.ts` stays at 102 of 105 and `channel-setup-service.ts` at 55 host and 61 dependency reads. `gateway-service.ts` gained its one line and measures 13127 lines (13126 before, cap 13132).
- **R18′:** the route port gains `channelSecretStore`, filled from the gateway's key store and read only where channel credentials are kept (`composeChannelSetupHost` and `createIntegrationChannelPortForGateway`), so a pasted channel key is stored on a real gateway. The port's generic `secretStore` stays unset, so the Vault master key, evidence receipt signing, notification webhook delivery, integration-action replay sealing, the Citadel Ward request vault and mobile push run as on main. A test composes the real port and shows channel setup and the channel port get custody while `secretStore` stays unset. The new member takes `GatewayRouteCompositionPort` to 188 members; the operator approved raising that one baseline number from 187 to 188 by hand, without regenerating the baseline.
- **R19:** the docs-only fix `4ea6ab939` was checked by the final whole-branch review instead of a review of its own.
- **R20:** the reply window is read only in a channel conversation, one whose binding names a `conversation`. A local or mission chat bound to WhatsApp with **Save binding** posts as it did, and Meta refuses a late send itself. The composer already blocked only conversations under Messaging.
- **R21:** a refusal Meta answered with its own error code, and that has no sentence of its own (a 403, a 429, another code), reads "Meta refused the request. Check that the access token has the whatsapp_business_management and whatsapp_business_messaging permissions." A call that never answered, a 5xx and an answer without Meta's error code still read "GoatCitadel couldn't reach Meta." Only the code is read, and the earlier mappings are unchanged.
- **R22:** `whatsAppFailure` matches "Secure channel credential storage is unavailable." exactly, at any status, and the page says "This page stores your keys in this computer's secure storage, which isn't available here. Use WhatsApp's guide in Settings with environment variables instead.", with "WhatsApp's guide in Settings" linking where the page's own Settings link goes. R23 makes that sentence reachable on a host without an OS keychain.
- **R23:** the port gives `channelSecretStore` only while the key store reports itself available (a getter, read when channel custody is composed). On a host without an OS keychain, channel setup keeps no custody and the secrets route answers "Secure channel credential storage is unavailable." with a 422, as on main, which R22's page sentence reads. Without R23, R18′ would have made such a host fail with the key store's own error, which the page reads as "GoatCitadel couldn't check those details with Meta."
- **R24:** startup custody reconciliation guards its delete of an unusable temporary credential. A delete that fails leaves the credential in secure storage, is reported as a warn diagnostic (`channel_setup.secret_reconciliation.delete_failed`, with the draft, catalog, field and error type only), and reconciliation and startup go on.
- **Final fix wave (F5 to F10):** the gateway-level window test gains an open case, so losing the last-message time fails it (F5); making a new verify token stops the wait for Meta's check first and starts it again afterwards, so the wait's end can't leave the page busy (F6); the key page shows GoatCitadel's own sentence for a failed check, with the fixed sentence as the fallback (F7); the listener's `nameOf` comment says it takes the only contact's name even when its `wa_id` differs (F8); "24 hours or more" in `channel-desk-turn.ts` and the changelog (F9); the changelog keeps "the code and its sender", and the guide says the composer is off once the window has closed (F10).
- **Deferred minors**, each recorded in the build ledger, none changing what the docs say: Turn on more than 24 hours after the hi hits the reply window and the setup page's change line does not say so; a replayed older signed delivery that carries the current code can replace the sender (no freshness check); the composer re-checks the window only when it draws; after a reload the page names the number, not the person.
- **Found while proving (Task 10):**
  - The route composition port (`createGatewayRouteCompositionPort`) never carried the key store at run time, so on a real gateway every pasted channel secret (the Telegram, Discord, Slack and WhatsApp pages, and Settings' saved keys) was refused with 422 "Secure channel credential storage is unavailable."; the proof's preload attached a store to get past it. R18′ fixed it narrowly, for channel credential custody only, through `channelSecretStore`. The port's other `secretStore` readers (the Vault master key, evidence receipt signing, notification webhook delivery, integration-action replay sealing, the Citadel Ward request vault and mobile push) still run without a key store; that is pre-existing and out of this plan's scope.
  - `fast.storage-migration-parity` in `verify:fast` fails on this branch because the lane compares against `origin/main`, which has moved four commits (with SQLite migrations) past the branch base. With `GOATCITADEL_STORAGE_MIGRATION_BASE_REF` set to the branch base (`ea9b03ee0`) the lane passes. The branch adds no migration.
  - The key page leaves its rotate-secret draft behind when the operator leaves it without saving (the shared key-change hook never discards), so Settings › Channels lists it under Drafts. The other channels' key pages do the same.
- **Browser proof:** one walk through the whole page in a throwaway gateway (scratch root, home and backups, token auth, OS keychain off with an in-memory stand-in for credential custody, every non-loopback connection refused and logged), with Meta answered by a loopback stand-in on 127.0.0.1. The walk set the address (approved in place), pasted the five values (a wrong token first), sent Meta's GET verification and signed code deliveries to the draft's address, subscribed the app, turned on, followed Change the key to the key page, and read the address in Settings and Classic. At each screen the page was captured at 1440 and 375 width in light and dark (76 screenshots). It made 458 checks with 0 failures and 0 console, page or HTTP errors apart from the one deliberate refusal (a wrong token, 400). No token, secret, app token or verify token appeared in 155 gateway response bodies, the visible text, the accessibility tree or any HTML (the verify token only in its own field), or in 31 scanned logs and artifacts. The gateway's own egress log, the refusing proxy and the browser's outside-request count were all 0, and the closing egress control still refused. The gateway made 12 requests for graph.facebook.com (10 reads, plus the subscribe POST and Turn on's test message), each answered in-process by the loopback stand-in. The public connection config showed the App secret, the access token and the verify token as the redaction marker, and Change the key on the channel page led to the Chat key page.

Not run: the real-account checks listed at the end of Task 10. The operator does them after merge.
