# Capabilities Hub Phase 1 (Foundation and Connectors) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a top-level Capabilities area to the cockpit and ship its Connectors tab. The tab is one list of every app the AI can use, with a governed one-button install and a per-connector setting for what asks first.

**Architecture:** A new Gateway route merges these sources into one connector list, with a state and a group for each item:
- MCP templates
- saved MCP servers
- the integration catalog and its connections
- Google sign-in
- web search credentials
- workspace capability selections

The cockpit renders that list in a new `capabilities` area and never joins sources itself. The install path is a new Change Plan adapter. It follows #572's operator approval skip, extended to a new `capabilities` origin surface, and the OAuth and enable steps reuse the existing reviewed MCP routes. What asks first is a new per-server `approvalPosture` field, decided in the policy engine from the MCP tool annotations the runtime starts keeping.

**Tech Stack:** TypeScript, React 19, TanStack Query, Tailwind (cockpit tokens), Radix Switch, Fastify, zod, Vitest, SQLite and Postgres storage.

**Spec:** `docs/superpowers/specs/2026-10-25-capabilities-hub-design.md`. Phases 2–5 (Tools, Skills, Plugins, Claude Code plugin import) get their own plans.

## PR boundaries

Each PR is cut from a freshly fetched `origin/main` in its own worktree (superpowers:using-git-worktrees) and merged before the next one starts.

| PR | Tasks | Ships |
|---|---|---|
| 1a | 1–10 | The Capabilities area, the switch, the DESIGN.md exception, and the connector list with a details panel. Available items link to Settings to set up. |
| 1b | 11–13 | What asks first: tool annotations, `approvalPosture`, policy decision and the Manage control. |
| 1c | 14–18 | One-button install: approval skip for Capabilities, pinned local templates, install adapter and route, install flow and panel. |

## Global Constraints

- Build each PR from a freshly fetched `origin/main`. The spec was written against `d0fd137db`.
- The Gateway owns every read and write. The cockpit renders `GET /api/v1/capabilities/connectors` and never merges catalogs, templates or connections itself (`apps/mission-control-next/AGENTS.md`).
- Visible copy follows DESIGN.md: sentence case, plain words, and no raw status strings, IDs, URLs or error text outside `TechnicalDetails`. `scripts/check-mission-control-next-cockpit-copy.mjs` bans "Gateway", "evidence", "owner", "revision", "snapshot", "canonical", "durable", "projection" and "posture" in visible copy. The UI says "What asks first", never "posture".
- Risk reads Safe, Caution, Danger or Nuclear. State always pairs a word with the dot; never colour alone.
- Install and switch actions are the operator's own. They follow `settingsApprovalSkipEnabled` (#572), and `remote_hardened` always asks. AI-initiated actions keep every approval.
- A row never says plain "Connected" or "On" when the AI can't use it. Chat-unavailable and hidden-in-workspace states are always shown.
- Excluded from the list: templates `approval-inbox`, `durable-tasks`, `filesystem` and `fetch`; `GATEWAY_OWNED_MCP_SERVER_IDS`; `model_provider` entries; and `external_connector` entries (`runtimePosture: "catalog_only"`).
- No new dependencies. `@radix-ui/react-switch@1.2.6` is already in `apps/mission-control-next/package.json`.
- After changing `packages/contracts`, rebuild it (`pnpm --filter @goatcitadel/contracts build`) before running package or app tests; they resolve contracts from `dist`.
- Run tests at low priority with `--maxWorkers=2`, one heavy job at a time.
- Never `prettier --write` a directory glob. Format only files you touched.
- Never `git stash`.
- No personal paths in tracked files.
- Code copied from Hermes Agent (MIT, Nous Research) keeps its notice in `THIRD_PARTY_NOTICES.md`.
- Commands:
  - Gateway test: `pnpm --filter @goatcitadel/gateway exec vitest run <path relative to apps/gateway> --maxWorkers=2`
  - Cockpit test: `pnpm --filter @goatcitadel/mission-control-next exec vitest run <path relative to the app> --maxWorkers=2`
  - Shared test: `pnpm --filter @goatcitadel/mission-control-shared exec vitest run <path> --maxWorkers=2`
  - Policy-engine and storage tests use the same pattern with `@goatcitadel/policy-engine` and `@goatcitadel/storage`.

## Review Focus

1. **The #572 setting is off (the default).** Install must stop at "Waiting on you in Inbox" with a link. It resumes on approval and never shows Installed early. *(Task 17)*
2. **Sign-in never comes back.** If the window is closed, the return is lost or the state doesn't match, the panel stays on "Finish signing in" with the manual code fallback and Cancel, and nothing is switched on. *(Task 17)*
3. **The same app is already saved under a different letter case.** The list shows one merged row, and install refuses a duplicate. *(Tasks 2 and 16)*
4. **A tool has no annotations and the connector is set to "Nothing asks".** It still asks, because missing annotations count as destructive. *(Task 12)*
5. **One source fails.** If the web-search status or the Google status throws, the other connectors still render, plus a plain issue line. The page never shows an empty "0 apps". *(Task 3)*

---

# PR 1a: Capabilities area and connector list

### Task 1: Connector list contract

**Files:**
- Create: `packages/contracts/src/capability-connectors.ts`
- Modify: `packages/contracts/src/index.ts` (re-export, next to the `web-search` export)
- Test: `packages/contracts/src/capability-connectors.test.ts`

**Interfaces:**
- Produces:

```ts
import type { McpServerCategory } from "./mcp.js";

export type CapabilityConnectorKind = "built_in" | "mcp" | "channel";
export type CapabilityConnectorSource = "mcp_template" | "mcp_server" | "integration" | "web_search";
export type CapabilityConnectorState =
  | "connected" | "needs_sign_in" | "sign_in_expired" | "broken" | "available" | "turned_off";
export type CapabilityConnectorGroup = "connected" | "on_this_device" | "available" | "turned_off";
export type CapabilityConnectorCategory = McpServerCategory | "messaging" | "search";
export type CapabilityConnectorAuth = "none" | "oauth" | "api_key" | "bot_token" | "google";
export type CapabilityConnectorReason =
  | "ready" | "not_connected" | "sign_in_needed" | "sign_in_expired" | "error"
  | "turned_off" | "not_installed" | "needs_api_key" | "missing_sign_in_setup";
export type CapabilityConnectorChatBlock = "mcp_in_chat_off" | "background_runs_off";

export interface CapabilityConnectorItem {
  id: string; // "mcp-template:<templateId>" | "mcp-server:<serverId>" | "integration:<connectionId|catalogId>" | "web-search:<targetId>"
  name: string;
  description: string;
  kind: CapabilityConnectorKind;
  source: CapabilityConnectorSource;
  category: CapabilityConnectorCategory;
  state: CapabilityConnectorState;
  reason: CapabilityConnectorReason;
  group: CapabilityConnectorGroup;
  auth: CapabilityConnectorAuth;
  runsOnThisDevice: boolean;
  command?: string; // exact command line, only when runsOnThisDevice
  networkHosts: string[];
  templateId?: string;
  serverId?: string;
  serverRevision?: string;           // McpServerRecord.revision (opaque)
  serverConnectionRevision?: string; // McpServerRecord.connectionRevision (opaque)
  catalogId?: string;
  connectionId?: string;
  chat: { available: boolean; blockedBy?: CapabilityConnectorChatBlock };
  hiddenInWorkspace: boolean;
  lastError?: string; // shown only inside TechnicalDetails
}

export interface CapabilityConnectorsIssue { source: CapabilityConnectorSource; message: string }
export interface CapabilityConnectorsResponse {
  workspaceId: string;
  items: CapabilityConnectorItem[];
  issues: CapabilityConnectorsIssue[];
  generatedAt: string;
}
export const CAPABILITY_CONNECTOR_GROUP_ORDER: readonly CapabilityConnectorGroup[] =
  ["connected", "on_this_device", "available", "turned_off"];
```

- [ ] **Step 1: Write the failing test** `capability-connectors.test.ts`: `it("orders groups connected, on this device, available, turned off")`, asserting `CAPABILITY_CONNECTOR_GROUP_ORDER` equals that list.
- [ ] **Step 2: Run it and confirm it fails** (module not found). Run: `pnpm --filter @goatcitadel/contracts exec vitest run src/capability-connectors.test.ts --maxWorkers=2`.
- [ ] **Step 3: Implement** the file above and the re-export.
- [ ] **Step 4: Run the test (PASS), then** `pnpm --filter @goatcitadel/contracts build`.
- [ ] **Step 5: Commit:** `feat(contracts): add the Capabilities connector list contract`.

### Task 2: Connector projection builder

**Files:**
- Create: `apps/gateway/src/services/capability-connectors-projection.ts`
- Create: `apps/gateway/src/services/capability-connectors-integrations.ts`
- Test: `apps/gateway/src/services/capability-connectors-projection.test.ts`
- Test: `apps/gateway/src/services/capability-connectors-integrations.test.ts`

**Interfaces:**
- Consumes: the Task 1 types; `McpServerTemplateRecord`, `McpServerRecord` (`contracts/mcp.ts`); `IntegrationCatalogEntry`, `IntegrationConnection` (`contracts/integrations.ts`); `GoogleWorkspaceOAuthStatus`, `GOOGLE_WORKSPACE_CATALOG_ID` (`contracts/google-workspace.ts`); `WebSearchCredentialStatus` (`contracts/web-search.ts`).
- Produces:

```ts
export const EXCLUDED_CONNECTOR_TEMPLATE_IDS: ReadonlySet<string>; // approval-inbox, durable-tasks, filesystem, fetch
export interface CapabilityConnectorsProjectionInput {
  templates: readonly McpServerTemplateRecord[];        // already filtered by isVisibleMcpTemplateRecord
  servers: readonly McpServerRecord[];                  // GATEWAY_OWNED_MCP_SERVER_IDS already removed
  integrationCatalog: readonly IntegrationCatalogEntry[];
  connections: readonly IntegrationConnection[];
  googleStatusByConnectionId: ReadonlyMap<string, GoogleWorkspaceOAuthStatus>;
  webSearch: readonly WebSearchCredentialStatus[];
  firecrawlEnabled: boolean;
  hiddenServerIds: ReadonlySet<string>;
  hiddenConnectionIds: ReadonlySet<string>;
  chat: { staticMcp: boolean; durableExecution: boolean };
}
export function buildCapabilityConnectors(input: CapabilityConnectorsProjectionInput): CapabilityConnectorItem[];
// capability-connectors-integrations.ts
export const CONNECTOR_INTEGRATION_CATALOG_IDS: ReadonlySet<string>;
export function isListedIntegration(entry: IntegrationCatalogEntry): boolean;
```

**Rules the builder implements:**

- **Template exclusions.** Templates whose `templateId` is in `EXCLUDED_CONNECTOR_TEMPLATE_IDS` are dropped. Confirm the four ids against `mcp-server-templates.ts`.
- **Merging templates with saved servers.** A saved server and a template are the same app when `server.label.toLowerCase() === template.label.toLowerCase()`. This is the same label match `/mcp/templates/discovery` uses. The merged item takes the `mcp-server:` id and keeps `templateId`. Saved servers that match no template are listed with `category` taken from the server.
- **Which integrations are listed.** `isListedIntegration(entry)` is true only when `entry.kind !== "model_provider"`, `!entry.externalConnector`, and `CONNECTOR_INTEGRATION_CATALOG_IDS` has `entry.catalogId`. The set starts with `automation.gmail`, `automation.imap-smtp` and `automation.webhooks`, plus every `channel.*` entry whose key matches a `tool-registry.ts` tool prefix: discord, slack, telegram, mattermost, imessage, whatsapp, zalo, zalouser and teams. Confirm each against `INTEGRATION_CATALOG`.
  - A connection row (`integration:<connectionId>`) replaces its catalog row (`integration:<catalogId>`).
  - `automation.gmail` is named "Gmail and Google Calendar", with `auth: "google"`.
  - Channels get `kind: "channel"` and `category: "messaging"`. Other integrations get `kind: "built_in"`.
- **Web search** gives one row per credential target: `search.firecrawl` ("Firecrawl"), `search.brave` ("Brave Search") and `search.parallel` ("Parallel"). They get `kind: "built_in"`, `category: "search"` and `auth: "api_key"`. The native engines are not listed.
- **On this device.** `runsOnThisDevice` is `transport === "stdio"`. Unsaved stdio templates go in the `on_this_device` group, and `command` is `[command, ...args].join(" ")`.
- **State and reason by source:**

| Source | Condition | state | reason |
|---|---|---|---|
| Unsaved template | `authType === "token"` | available | needs_api_key |
| Unsaved template | `oauth2` without an endpoint source | available | missing_sign_in_setup |
| Unsaved template | otherwise | available | not_installed |
| Saved MCP server | `enabled === false` | turned_off | turned_off |
| Saved MCP server | `authState.readiness` is `needs_auth` | needs_sign_in | sign_in_needed |
| Saved MCP server | `authState.readiness` is `expired` | sign_in_expired | sign_in_expired |
| Saved MCP server | `status === "error"` | broken | error |
| Saved MCP server | otherwise | connected | ready |
| Integration connection | `enabled === false` or `status === "paused"` | turned_off | turned_off |
| Integration connection | `status === "error"` | broken | error |
| Integration connection | `status === "disconnected"` | needs_sign_in | not_connected |
| Integration connection | `status === "connected"` | connected | ready |
| Google connection | `requiresReauth` (checked first) | sign_in_expired | sign_in_expired |
| Google connection | `!connected` | needs_sign_in | sign_in_needed |
| Catalog entry with no connection | — | available | not_installed |
| Web search | `activeSource` present (Firecrawl also needs `firecrawlEnabled` and `endpointAllowlisted`) | connected | ready |
| Web search | otherwise | available | needs_api_key |

- **Group** comes from state: connected, needs_sign_in, sign_in_expired and broken go in `connected`; turned_off goes in `turned_off`; available goes in `available` or `on_this_device`.
- **Chat.** MCP items set `chat.available = input.chat.staticMcp`. When that is false, `blockedBy` is `"background_runs_off"` if `!input.chat.durableExecution`, else `"mcp_in_chat_off"`. Integration and web-search items always set `chat.available = true`.
- **Hidden in workspace** is true when the item's `serverId` or `connectionId` is in the hidden sets.
- **Sort order** inside a group: broken, then sign_in_expired, then needs_sign_in, then the rest. Then by name, case-insensitive.

- [ ] **Step 1: Write the failing tests** in `capability-connectors-projection.test.ts`, building inputs from small fixtures:
  - `it("drops internal and duplicate-of-builtin templates")`: the ids `approval-inbox`, `durable-tasks`, `filesystem` and `fetch` are absent.
  - `it("merges a saved server with its template by label ignoring case")`: template "Linear" plus server "linear" gives exactly one item, with `id === "mcp-server:<serverId>"` and `templateId === "linear"`.
  - `it("places unsaved stdio templates on this device with the exact command")`: `group === "on_this_device"`, and `command` equals `"npx -y @upstash/context7-mcp@1.2.3"` for that fixture.
  - `it("lists only callable integrations")`: Gmail is present; `kind: "model_provider"`, an `externalConnector` entry and a Notion entry are absent.
  - `it("marks a server hidden in the workspace")`: `hiddenInWorkspace === true`.
  - `it("explains why Chat can't reach MCP")`: `{ staticMcp: false, durableExecution: true }` gives `blockedBy === "mcp_in_chat_off"`.
  - `it("orders broken before healthy inside connected")`.
  - `it.each(<state table rows>)("maps %s to %s")`: one row per line of the state table.
- [ ] **Step 2: Write the failing test** `capability-connectors-integrations.test.ts`: `it("lists only catalog ids that exist and, for channels, have registry tools")`. It iterates `CONNECTOR_INTEGRATION_CATALOG_IDS` against `INTEGRATION_CATALOG` and the `tool-registry.ts` tool names.
- [ ] **Step 3: Run both and confirm they fail.** Run: `pnpm --filter @goatcitadel/gateway exec vitest run src/services/capability-connectors-projection.test.ts src/services/capability-connectors-integrations.test.ts --maxWorkers=2`.
- [ ] **Step 4: Implement** `buildCapabilityConnectors` and `isListedIntegration` as pure functions, with no I/O.
- [ ] **Step 5: Run both tests (PASS).**
- [ ] **Step 6: Commit:** `feat(gateway): build one connector list from MCP, integrations and web search`.

### Task 3: Connector service and route

**Files:**
- Create: `apps/gateway/src/services/capability-connectors-service.ts`
- Create: `apps/gateway/src/routes/capability-connectors.ts`
- Modify: `apps/gateway/src/app.ts` (register next to `webSearchSettingsRoutes`, around `:397`)
- Modify: `apps/gateway/src/services/gateway-route-services.ts` (add `capabilityConnectors` to `GatewayRouteServices`), plus the `gateway-route-composition-*.ts` file that composes `webSearchCredentials` (find it with `git grep webSearchCredentials`)
- Modify: `apps/gateway/src/coverage-exercise.ts` (exercise the new GET)
- Test: `apps/gateway/src/services/capability-connectors-service.test.ts`
- Test: `apps/gateway/src/routes/capability-connectors.test.ts`

**Interfaces:**
- Consumes: `buildCapabilityConnectors` (Task 2). Each source is read through its existing owner:
  - `GatewayService.listMcpTemplates` and `readMcpServers`
  - `listIntegrationCatalog` and the integration connections list
  - `integrations.getGoogleWorkspaceOAuthStatus(connectionId)`, only for `automation.gmail` connections
  - `webSearchCredentials.listStatuses()`
  - runtime `web.firecrawl.enabled`
  - `capabilityScope.getView("workspace", workspaceId, "mcp_server" | "integration")`, where `items[].enabled === false` means hidden
  - `settings.getSettings().chatFeatureAvailability`
- Produces:

```ts
export interface CapabilityConnectorsSources { /* one async reader per source above */ }
export class CapabilityConnectorsService {
  constructor(sources: CapabilityConnectorsSources);
  list(workspaceId: string): Promise<CapabilityConnectorsResponse>;
}
// Route: GET /api/v1/capabilities/connectors?workspaceId=<id>  → 200 CapabilityConnectorsResponse
```

**Route details:**
- Query schema: `z.object({ workspaceId: z.string().min(1).max(200) }).strict()`.
- Options: `{ config: { rateLimit: { max: 120, timeWindow: "1 minute" } } }`, using the literal form from `docs/security/findings-triage.md` §1.
- Behaviour: `markNoStore(reply)`; operator access by default; errors go through `sendRouteError`. The route does not publish realtime events and makes no live network checks (`checkFirecrawl` is never called).

**Partial failure:** each source read runs in its own try/catch. A failed source adds `{ source, message: "<plain one-line reason>" }` to `issues` and is treated as empty. The response is still 200.

- [ ] **Step 1: Write the failing service tests:**
  - `it("returns items from healthy sources and an issue for the failing one")`: the web-search reader throws, MCP items are still present, and `issues` is `[{ source: "web_search", message: expect.any(String) }]`.
  - `it("reads Google status only for Gmail connections")`: the reader spy is called once, with the Gmail connection id.
- [ ] **Step 2: Write the failing route tests.** Mirror `routes/web-search-settings.test.ts`: a bare `Fastify()` with `decorate("services", …)`.
  - `it("returns the connector list for a workspace")`: status 200, body `items` length, and `cache-control` is `no-store`.
  - `it("rejects unknown query fields")`: status 400.
- [ ] **Step 3: Run them and confirm they fail.**
- [ ] **Step 4: Implement** the service, the route, the registration and the composition.
- [ ] **Step 5: Run the tests (PASS), then run** `src/routes/get-routes-publish-sweep.test.ts` **(PASS).**
- [ ] **Step 6: Commit:** `feat(gateway): serve the Capabilities connector list`.

### Task 4: Shared client

**Files:**
- Create: `packages/mission-control-shared/src/api/capability-connectors.ts`
- Test: `packages/mission-control-shared/src/api/capability-connectors.test.ts` (mirror `mcp-test-evidence.test.ts`)

**Interfaces:**
- Produces: `fetchCapabilityConnectors(workspaceId: string, options?: { signal?: AbortSignal }): Promise<CapabilityConnectorsResponse>`. It calls `request()` from `./client-core.js` with `cache: "no-store"` and `?workspaceId=` URL-encoded. Import it as `@goatcitadel/mission-control-shared/api/capability-connectors`.

- [ ] **Step 1: Write the failing test.** `it("requests the connector list for the encoded workspace")`: the URL equals `/api/v1/capabilities/connectors?workspaceId=a%2Fb` and `cache` is `"no-store"`.
- [ ] **Step 2: Run it and confirm it fails.** **Step 3: Implement it.** **Step 4: Run it (PASS).**
- [ ] **Step 5: Commit:** `feat(shared): add the Capabilities connector client`.

### Task 5: Cockpit switch primitive

**Files:**
- Create: `apps/mission-control-next/src/cockpit/ui/Switch.tsx`
- Modify: `apps/mission-control-next/src/cockpit/ui/index.ts` (export it)
- Test: `apps/mission-control-next/src/cockpit/ui/Switch.test.tsx`

**Interfaces:**
- Produces:

```ts
export interface SwitchProps {
  checked: boolean;
  onCheckedChange: (next: boolean) => void;
  label: string;            // accessible name, e.g. the connector's name
  onText?: string;          // default "On"
  offText?: string;         // default "Off"
  disabled?: boolean;
  pending?: boolean;        // disables and sets aria-busy while a change is saving
  describedBy?: string;
}
export function Switch(props: SwitchProps): JSX.Element;
```

**Look:** it is built on `@radix-ui/react-switch`. The visible state text (`On` or `Off`, `aria-hidden`) sits before a pill track:
- the track is `h-5 w-9 rounded-full`, filled with the same accent background class as the primary `Button` variant when on, and with the raised surface and a control border when off
- the thumb is a white `size-4` that moves with `translate-x-4`

No arbitrary Tailwind values (cockpit-classes guard). Focus ring and hover follow the cockpit `Button`.

- [ ] **Step 1: Write the failing tests:**
  - `it("exposes a switch named by its label with the checked state")`: `getByRole("switch", { name: "Linear" })` has `aria-checked="true"`, and the visible text includes "On".
  - `it("flips on click")`: `onCheckedChange` is called with `false`.
  - `it("is unavailable while pending")`: `aria-busy="true"`, it is disabled, and a click does not call the handler.
  - `it("shows Off text when unchecked")`.
- [ ] **Step 2: Run them and confirm they fail.** Run: `pnpm --filter @goatcitadel/mission-control-next exec vitest run src/cockpit/ui/Switch.test.tsx --maxWorkers=2`.
- [ ] **Step 3: Implement it.** **Step 4: Run it (PASS).**
- [ ] **Step 5: Commit:** `feat(cockpit): add the shared on/off switch`.

### Task 6: DESIGN.md exception and guard scope

**Files:**
- Modify: `DESIGN.md`
  - Components: name `ui/Switch` the standard on/off control.
  - Page anatomy: add a scoped exception, "Inside the Capabilities area (`src/cockpit/areas/capabilities/`), catalog lists may be a two-column grid of row cards, and the Tools tab may show one row of four cards; no banners or hero images".
- Modify: `scripts/check-mission-control-next-page-anatomy.mjs`. The `card-surface` and `padded-panel` `count()` return 0 when `relative.startsWith("areas/capabilities/")`. Add a one-line comment pointing at DESIGN.md.

- [ ] **Step 1: Make both edits.**
- [ ] **Step 2: Run** `node scripts/check-mission-control-next-page-anatomy.mjs`. Expected: PASS with unchanged budgets.
- [ ] **Step 3: Commit:** `docs(design): allow catalog row cards in Capabilities and make the switch standard`.

### Task 7: Wire the Capabilities area into the cockpit

**Files:**
- Modify: `apps/mission-control-next/src/cockpit/app/routes.ts`
  - Add `"capabilities"` to `CockpitArea`.
  - Insert `{ area: "capabilities", label: "Capabilities", path: "/capabilities", shortcut: "a" }` between Work and Library in `COCKPIT_AREAS`.
  - Add `capabilities: "capabilities"` to `AREA_BY_SEGMENT`.
- Modify: `cockpit/app/area-loaders.ts`: add `CapabilitiesArea = preloadable(...)` importing `../areas/capabilities/CapabilitiesArea`, plus a `LOADERS` entry.
- Modify: `cockpit/app/CockpitShell.tsx`: add the import, `areaLabel`, and an area switch branch rendering `<CapabilitiesArea />`.
- Modify: `cockpit/app/Sidebar.tsx`: `AREA_ICONS.capabilities = Blocks` (lucide-react).
- Modify: `cockpit/app/MobileTabBar.tsx`: add a Capabilities entry to the More sheet, before System. It is not a fifth tab.
- Modify: `cockpit/app/cockpit-compatibility.ts`: add `const capabilitiesViews = new Set(["connectors"]);` and `if (area === "capabilities" && (parts.length === 1 || (parts.length === 2 && capabilitiesViews.has(section!)))) return native();` before the final `missing`.
- Modify: `cockpit/app/CommandPalette.tsx`: terms for Capabilities are `"skills plugins connectors tools mcp integrations apps install"`.
- Modify: `scripts/verification/cross-browser-smoke.mjs` (add `/capabilities`).
- Create: `cockpit/areas/capabilities/CapabilitiesArea.tsx`. For now it is a stub that renders `<AreaHeader title="Capabilities" />`; Task 8 fills it in.
- Test (update): `cockpit/app/routes.test.ts`, `cockpit/app/CockpitShell.test.tsx` (mock `CapabilitiesArea` the way `LibraryArea` is mocked), `cockpit/app/CommandPalette.test.tsx`, `cockpit/app/MobileTabBar.test.tsx` and `cockpit/app/cockpit-compatibility.test.ts`.

- [ ] **Step 1: Update the tests first:**
  - `routes.test.ts`: the `[label, shortcut]` list is `["Chat","c"],["Inbox","i"],["Work","w"],["Capabilities","a"],["Library","l"],["System","s"]`.
  - `CockpitShell.test.tsx`: the nav link labels in order are Chat, Inbox, Work, Capabilities, Library, System.
  - `CommandPalette.test.tsx`: the list includes "Go to Capabilities".
  - `MobileTabBar.test.tsx`: the More sheet lists Capabilities.
  - `cockpit-compatibility.test.ts`: `/capabilities` and `/capabilities/connectors` resolve `native`; `/capabilities/skills` resolves `missing` in this phase.
- [ ] **Step 2: Run them and confirm they fail.**
- [ ] **Step 3: Implement the wiring.**
- [ ] **Step 4: Run the five tests (PASS) and** `pnpm --filter @goatcitadel/mission-control-next typecheck` **(PASS).**
- [ ] **Step 5: Commit:** `feat(cockpit): add Capabilities to the main navigation`.

### Task 8: Area shell, search and category filter

**Files:**
- Modify: `cockpit/areas/capabilities/CapabilitiesArea.tsx`
- Create: `cockpit/areas/capabilities/CapabilitySearch.tsx`
- Create: `cockpit/areas/capabilities/CategoryFilter.tsx`
- Create: `cockpit/areas/capabilities/capabilities-tabs.ts`
- Test: `cockpit/areas/capabilities/CapabilitiesArea.test.tsx`
- Test: `cockpit/areas/capabilities/CategoryFilter.test.tsx`

**Interfaces:**
- Produces:

```ts
// capabilities-tabs.ts
export type CapabilitiesTabId = "connectors"; // phases 2–4 widen this
export const CAPABILITIES_TABS: readonly { id: CapabilitiesTabId; label: string; href: string }[];
export function readCapabilitiesTab(rest: readonly string[]): CapabilitiesTabId; // unknown or empty → "connectors"
// CapabilitySearch.tsx
export function CapabilitySearch(props: {
  tabLabel: string; value: string; onChange: (value: string) => void;
  placeholder: string; actions?: ReactNode;
}): JSX.Element;
// CategoryFilter.tsx
export interface CategoryOption { id: string; label: string }
export function CategoryFilter(props: {
  options: readonly CategoryOption[]; selected: readonly string[];
  onChange: (selected: string[]) => void; visibleCount?: number; // default 3
}): JSX.Element;
```

**Behaviour:**
- The page uses `AreaTabsProvider` and `AreaHeader`, with title "Capabilities" and the description "Everything GoatCitadel's AI can use, in one place."
- `CapabilitySearch` is a labelled search input with the tab name as a small badge and the actions on the right. Its input uses 16px text on phones.
- `CategoryFilter` shows "All" plus `visibleCount` options. The rest go under a "+N" `Popover` button. A selected option always stays visible. Selecting every option is the same as "All", and clearing returns to "All".

- [ ] **Step 1: Write the failing tests:**
  - `it("opens Connectors for /capabilities")`, mirroring the `WorkArea.scope.test.tsx` setup: the heading "Capabilities" and the tab "Connectors" are present.
  - `it("keeps a selected category visible after it overflows")`.
  - `it("treats every category selected as All")`.
  - `it("shows the hidden count on the overflow button")`: the text is "+2" when 5 options are given.
- [ ] **Step 2: Run them and confirm they fail.** **Step 3: Implement it.** **Step 4: Run the tests (PASS).**
- [ ] **Step 5: Commit:** `feat(cockpit): Capabilities page shell with search and category filter`.

### Task 9: Connectors tab: list, groups and rows

**Files:**
- Create: `cockpit/areas/capabilities/connectors/connector-view.ts`
- Create: `cockpit/areas/capabilities/connectors/ConnectorsTab.tsx`
- Create: `cockpit/areas/capabilities/connectors/ConnectorRow.tsx`
- Create: `cockpit/areas/capabilities/LetterIcon.tsx`
- Modify: `cockpit/data/query-keys.ts`: add `capabilityConnectors: (workspaceId: string): TopicKey => ["mcp", "capability-connectors", workspaceId]`
- Test: `cockpit/areas/capabilities/connectors/connector-view.test.ts`
- Test: `cockpit/areas/capabilities/connectors/ConnectorsTab.test.tsx`

**Interfaces:**
- Consumes: `fetchCapabilityConnectors` (Task 4), `CategoryFilter` and `CapabilitySearch` (Task 8), `useUiPreferences().activeWorkspaceId`.
- Produces:

```ts
export function filterConnectors(items: readonly CapabilityConnectorItem[], f: { query: string; categories: readonly string[] }): CapabilityConnectorItem[];
export function groupConnectors(items: readonly CapabilityConnectorItem[]): { group: CapabilityConnectorGroup; label: string; items: CapabilityConnectorItem[] }[];
export function connectorCategoryLabel(c: CapabilityConnectorCategory): string;
export function connectorKindLabel(k: CapabilityConnectorKind): string;         // "Built in" | "MCP" | "Channel"
export function presentConnectorState(item: CapabilityConnectorItem): StatusPresentation & { reason: string };
export function connectorAction(item: CapabilityConnectorItem): { kind: "install" | "set_up" | "reconnect" | "try_again" | "turn_back_on" | "manage"; label: string };
// "install" is returned only from Task 18 on.
export function letterIconTone(name: string): number; // stable index into the icon tone list
```

**Copy:**
- Group labels: "Connected", "On this device", "Available" and "Turned off", each heading followed by its count.
- State labels: connected "Connected", needs_sign_in "Needs sign-in", sign_in_expired "Sign-in expired", broken "Not working", available "Available", turned_off "Turned off".
- Reason lines:

| reason | Line |
|---|---|
| ready | "Ready to use" |
| not_connected | "Not connected yet" |
| sign_in_needed | "Sign in to finish setup" |
| sign_in_expired | "Sign in again to keep using it" |
| error | "Stopped working; open it to see why" |
| turned_off | "Switched off" |
| not_installed | "Not installed" |
| needs_api_key | "Needs an API key" |
| missing_sign_in_setup | "Sign-in isn't set up for this app yet" |

- If `chat.available` is false on a connected row, the reason becomes "Connected · not available in Chat".
- If `hiddenInWorkspace`, the state label becomes "Hidden in this workspace".

**Actions in PR 1a:** available rows say "Set up", broken rows "Try again", expired rows "Reconnect", turned-off rows "Turn back on", and connected rows "Manage". Every action opens the panel from Task 10. Install arrives in Task 18.

**Search** matches name, description, category label and kind label, ignoring case. The placeholder is `Try "<category label of the first connected item, else 'automation'>"`.

**Layout:** the grid is `grid grid-cols-1 sm:grid-cols-2 gap-2`. Each row is a row card: letter icon, name and kind label, one-line description, `StatusBadge` and reason, and one button.

**States:**
- Loading shows the existing `CHECKING_FOR_CHANGES` line.
- An error with no cached data shows a plain message and Retry.
- Cached data plus an error keeps the list and adds a one-line warning.
- `issues` render as one plain line each above the groups.
- No matches shows `EmptyState` with "Clear filters".

- [ ] **Step 1: Write the failing tests in `connector-view.test.ts`:**
  - `it("groups in the fixed order and drops empty groups")`.
  - `it("filters by query across name, description, category and kind")`.
  - `it("says not available in Chat on a connected MCP row")`.
  - `it("says hidden in this workspace")`.
  - `it.each` over the action table.
- [ ] **Step 2: Write the failing tests in `ConnectorsTab.test.tsx`** (mock the client):
  - `it("renders groups with counts")`: the text contains "Connected 2" and "Available 3".
  - `it("keeps rows and shows an issue line when one source failed")`.
  - `it("offers Clear filters when nothing matches")`.
  - `it("never renders 0 apps while the first load fails")`: an error message and Retry are shown, and the text does not contain "0".
- [ ] **Step 3: Run them and confirm they fail.** **Step 4: Implement it.** **Step 5: Run the tests (PASS).**
- [ ] **Step 6: Commit:** `feat(cockpit): list connectors by state with filters and search`.

### Task 10: Connector details panel, MCP switch, refresh wiring and proof

**Files:**
- Create: `cockpit/areas/capabilities/connectors/ConnectorPanel.tsx`
- Create: `cockpit/areas/capabilities/connectors/connector-links.ts`
- Create: `cockpit/areas/capabilities/connectors/use-connector-enabled.ts`
- Modify: `cockpit/data/event-map.ts`: add `queryKeys.capabilityConnectors` prefix `["mcp","capability-connectors"]` to `MCP_KEYS` and `INTEGRATION_KEYS`
- Test: `cockpit/areas/capabilities/connectors/ConnectorPanel.test.tsx`
- Test: `cockpit/areas/capabilities/connectors/use-connector-enabled.test.tsx`

**Interfaces:**
- Consumes:
  - `useInspector().open({ source: \`capabilities:${item.id}\`, title: item.name, body })` (`cockpit/app/inspector.tsx`)
  - `updateMcpServer` (`mcp-operations.ts:125`)
  - the toggle-availability helper behind `mcpToggleUnavailableReason`
  - `Switch` (Task 5)
- Produces:

```ts
export function connectorSettingsHref(item: CapabilityConnectorItem): string;
// mcp_* → "/settings/connections#mcp-servers"; channel → "#channels"; other integration → "#integration-connections"; web_search → "#web-search"
export function useConnectorEnabled(item: CapabilityConnectorItem): {
  enabled: boolean; pending: boolean; error?: string; unavailableReason?: string; setEnabled(next: boolean): void;
};
```

**Also consumed:** `fetchMcpTools(serverId)` and `deleteMcpServer(serverId, expectedRevision: string)` (`mcp-operations.ts:226,142`), and `McpServerCreate` (`cockpit/areas/settings/McpServerCreate.tsx`).

**Panel content, top to bottom:**
1. kind and category
2. state and reason
3. "What it does": the description, and for saved MCP servers the tool list from `fetchMcpTools`
4. "How it connects": the sign-in host, or "Needs an API key", or "Runs on this computer", followed by the exact `command` and the line "This program's own internet access isn't limited by GoatCitadel's allowed sites."
5. The Chat line when unavailable: "Chat can't use connectors yet", with a link to the Settings feature control.
6. The hidden-in-workspace line, with a link to `/settings/citadel#workspace-capabilities`.
7. A `Switch` for saved MCP servers only.
8. "Remove", for saved MCP servers only. It is a `variant="danger"` button behind a confirmation that names the app, and calls `deleteMcpServer(serverId, serverRevision)`.
9. "Advanced setup in Settings", linking to `connectorSettingsHref`.
10. `TechnicalDetails` with the ids, hosts and `lastError`.

**Switch behaviour:** the switch is optimistic. It sets the cached item's state locally and calls `updateMcpServer` with `enabled` and the server's current revision, using the request field `McpServerUpdateRequest` requires (read its type). On failure it rolls back only this item and shows the plain error. On a 409 it shows "Changed elsewhere. Reload to see the latest." with a Reload button.

**Linkable items:** opening a panel sets `?item=<item.id>` on `/capabilities/connectors`, and loading that URL opens the panel once the list arrives. An unknown id is ignored.

**Add your own:** the Connectors tab passes an "Add your own" button to `CapabilitySearch` `actions`. It opens the inspector with the existing `McpServerCreate` flow.

- [ ] **Step 1: Write the failing tests:**
  - `it("shows the exact command and the network warning for on-device apps")`.
  - `it("links Advanced setup to the MCP section")`.
  - `it("rolls back only the failed switch")`: with a mocked `updateMcpServer` rejection, `aria-checked` returns to `"true"` and the error text is shown.
  - `it("explains a 409 with a reload")`.
  - `it("disables the switch with the reason when the server can't run yet")`.
  - `it("removes a server only after confirming")`: `deleteMcpServer` is not called until the confirmation is accepted.
  - `it("opens the panel from ?item= once the list loads")`.
  - `it("lists a saved server's tools")`.
- [ ] **Step 2: Run them and confirm they fail.** **Step 3: Implement it.** **Step 4: Run the tests (PASS).**
- [ ] **Step 5: Run the PR checks:**
  - mc-next `typecheck`
  - `pnpm --filter @goatcitadel/mission-control-next perf:check` (bump `LIVE_REGION_BUDGET` in `check-mission-control-next-cockpit-semantics.mjs` by exactly the number of `role="status"` regions added, if any)
  - the gateway tests from Tasks 2–3
  - `git diff --check`
- [ ] **Step 6: Get browser proof.** Run the app against a sandbox gateway using the testbench recipe: `pnpm testbench` with `VITE_GATEWAY_URL`. Screenshot `/capabilities/connectors` at desktop and phone width, in light and dark themes.
- [ ] **Step 7: Commit:** `feat(cockpit): connector details panel with an on/off switch`. Then open PR 1a.

---

# PR 1b: What asks first

### Task 11: Contract, policy schema and annotation capture

**Files:**
- Modify: `packages/contracts/src/mcp.ts`
  - add `export type McpApprovalPosture = "everything_asks" | "reads_free" | "nothing_asks";`
  - add `approvalPosture?: McpApprovalPosture` to `McpServerPolicy`
  - add `annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean }` to `McpToolRecord`
- Modify: `apps/gateway/src/routes/mcp-request-schemas.ts` (`updatePolicySchema`: optional `approvalPosture` enum)
- Modify: `apps/gateway/src/services/mcp-runtime.ts:680` (`normalizeDiscoveredTools`): keep `annotations.readOnlyHint` and `annotations.destructiveHint` only when they are booleans
- Modify: storage for `mcp_tools_cache`: add an `annotations_json` column in `packages/storage/src/sqlite.ts` and a new migration in `packages/storage/src/postgres/migrations.ts`
  - Follow the PG v2 dual-lineage rule: the schema-shape gate must pass on both a fresh database and an upgraded one. Add a convergence migration if the gate needs it.
- Test: `apps/gateway/src/routes/mcp.test.ts`, `apps/gateway/src/services/mcp-runtime.test.ts`, and the storage round-trip tests for both backends

- [ ] **Step 1: Write the failing tests:**
  - `it("accepts approvalPosture on a policy update and rejects unknown values")`: 200 for `"reads_free"`, 400 for `"sometimes"`.
  - `it("keeps boolean tool annotations and drops other values")`: `{ readOnlyHint: true, destructiveHint: "no" }` gives `{ readOnlyHint: true }`.
  - `it("round-trips tool annotations")` on SQLite and on Postgres, fresh and upgraded.
- [ ] **Step 2: Run them and confirm they fail.** **Step 3: Implement it, and rebuild contracts.** **Step 4: Run the tests (PASS), including the storage schema-shape tests.**
- [ ] **Step 5: Commit:** `feat(mcp): record tool annotations and a per-server approval setting`.

### Task 12: Policy decision

**Files:**
- Modify: `apps/gateway/src/services/native-mcp-chat-catalog.ts:166-267`, `native-mcp-chat-binding.ts:141,184` and `mcp-tool-policy-binding.ts`, so the MCP policy binding identity carries `approvalPosture` and the tool's `annotations`
- Modify: `packages/policy-engine/src/engine.ts:1318-1396` (`evaluateAccessInternal` approval decision for MCP-bound calls)
- Modify: `apps/gateway/src/services/tool-invocation-coordinator-service.ts:2196` (`checkMcpServerToolPolicy`): when `approvalPosture` is set, skip `requireFirstToolApproval`; blocked and allowed patterns and quarantine still apply
- Test: `packages/policy-engine/src/mcp-named-policy.test.ts`, `apps/gateway/src/services/tool-invocation-coordinator-service.test.ts`

**Interfaces:**
- Produces: `mcpCallAsksFirst(posture: McpApprovalPosture | undefined, annotations: McpToolRecord["annotations"]): boolean | "first_use"` in `packages/contracts/src/mcp.ts`. It is pure, so both the engine and the cockpit import it. `"first_use"` means the posture is unset. The engine uses it for the decision below.

**Rule:**
- **Posture unset:** today's behaviour, unchanged.
- **`everything_asks`:** the call asks.
- **`reads_free`:** no approval only when `readOnlyHint === true`.
- **`nothing_asks`:** no approval when `readOnlyHint === true` or `destructiveHint === false`.
- **Missing annotations** count as destructive and ask.
- **Unchanged under every posture:** deny grants, wards, permission-profile denies, blocked patterns and `trustTier: "quarantined"` still block.

- [ ] **Step 1: Write the failing table test** `it.each(rows)("posture %s with %j asks: %s")`. Rows (posture, annotations → asks):

| Posture | Annotations | Asks |
|---|---|---|
| everything_asks | `{readOnlyHint:true}` | true |
| reads_free | `{readOnlyHint:true}` | false |
| reads_free | `{destructiveHint:false}` | true |
| reads_free | `{}` | true |
| nothing_asks | `{destructiveHint:false}` | false |
| nothing_asks | `{}` | true |
| nothing_asks | `{destructiveHint:true}` | true |
| nothing_asks | `{readOnlyHint:true}` | false |

- [ ] **Step 2: Write the failing tests:**
  - `it("still denies under nothing_asks when a deny grant matches")`.
  - `it("still blocks a quarantined server under nothing_asks")`.
  - `it("ignores requireFirstToolApproval once a posture is set")`.
- [ ] **Step 3: Run them and confirm they fail.** **Step 4: Implement it.** **Step 5: Run the tests (PASS), plus** `src/services/chat-static-mcp.integration.test.ts`.
- [ ] **Step 6: Commit:** `feat(policy): decide MCP approvals from the server setting and tool annotations`.

### Task 13: "What asks first" in the connector panel

**Files:**
- Create: `cockpit/areas/capabilities/connectors/WhatAsksFirst.tsx`
- Modify: `cockpit/areas/capabilities/connectors/ConnectorPanel.tsx` (saved MCP servers only)
- Modify: `apps/gateway/src/services/capability-connectors-projection.ts`
  - add `approvalPosture?: McpApprovalPosture` to `CapabilityConnectorItem` in Task 1's contract
  - fill it from `server.policy.approvalPosture`
- Test: `cockpit/areas/capabilities/connectors/WhatAsksFirst.test.tsx`

**Interfaces:**
- Consumes: `updateMcpServerPolicy` (`mcp-operations.ts:132`) with the full current policy plus `approvalPosture` and `expectedRevision`.

**Copy:**
- Heading: "What asks first".
- The three choices, as a radio group:
  - "Everything asks: I ask before every action."
  - "Reading is free: I ask before it creates or changes anything." This one is marked "Recommended".
  - "Nothing asks: changes run without asking; deleting or removing still asks."
- When the setting is unset, the current-state line reads "Now: asks the first time each tool is used". No radio is preselected.
- A 409 shows "Changed elsewhere. Reload to see the latest."
- The panel's tool list (Task 10) gains a label per tool for the chosen setting, "Asks first" or "Runs freely", computed with the same rule as Task 12. Use `mcpCallAsksFirst` from Task 12, so the cockpit and the engine can't disagree. Have `McpToolRecord` returned by `fetchMcpTools` carry `annotations` (Task 11).

- [ ] **Step 1: Write the failing tests:**
  - `it("labels each tool Asks first or Runs freely for the chosen setting")`.
  - `it("saves the chosen setting with the server's revision")`.
  - `it("shows the older first-use setting without preselecting a choice")`.
  - `it("explains a conflict and reloads")`.
- [ ] **Step 2: Run them and confirm they fail.** **Step 3: Implement it.** **Step 4: Run the tests (PASS), then the copy and semantics guards (PASS).**
- [ ] **Step 5: Commit:** `feat(cockpit): choose what a connector asks first`. Then open PR 1b.

---

# PR 1c: One-button install

### Task 14: Approval skip covers Capabilities

**Files:**
- Modify: `packages/contracts/src/change-plan.ts:71`: `ChangePlanOriginSurface = "chat" | "settings" | "system" | "capabilities"`. Fix any exhaustive maps typecheck reports.
- Modify: `apps/gateway/src/services/evolution-control-plane-operator-approval-skip.ts:29` (`eventFor`): replace `plan.origin.surface !== "settings"` with `!OPERATOR_SAVE_SURFACES.has(plan.origin.surface)`, where `OPERATOR_SAVE_SURFACES = new Set(["settings", "capabilities"])`
- Modify: `apps/mission-control-next/src/cockpit/areas/settings/SettingsApprovalSkipControl.tsx:17-22`: the copy names "your own changes in Settings and Capabilities"
- Test: `apps/gateway/src/services/evolution-control-plane-service.test.ts` (the "operator Settings approval skip" block, around line 630); `SettingsApprovalSkipControl` test

- [ ] **Step 1: Write the failing tests:**
  - `it("skips approval for a Capabilities operator save when the setting is on")`: the plan completes and its history has `operator_approval_skipped`.
  - `it("waits in Inbox for a Capabilities save when the setting is off")`: `status` is `"awaiting_approval"` and `requiredAction.kind` is `"approval"`.
  - `it("always asks under remote_hardened")`.
  - `it("never skips a chat-surface plan")`.
- [ ] **Step 2: Run them and confirm they fail.** **Step 3: Implement it, and rebuild contracts.** **Step 4: Run the tests (PASS).**
- [ ] **Step 5: Commit:** `feat(gateway): let the operator approval skip cover Capabilities`.

### Task 15: Pin local MCP templates

**Files:**
- Modify: `apps/gateway/src/services/mcp-server-templates.ts`: pin `context7`, `gpt-researcher` and `openspec` to exact versions. Use the current published versions at implementation time (`npm view @upstash/context7-mcp version`; for the uvx packages, the latest release on PyPI). `playwright` stays `@0.0.80`.
- Test: `apps/gateway/src/services/mcp-server-templates.test.ts` (create it if missing)

- [ ] **Step 1: Write the failing test.** `it("pins every local template to an exact version")`: for each `transport === "stdio"` template that runs `npx` or `uvx`, the package argument matches `/@\d+\.\d+\.\d+$/` (npx) or `/==\d+(\.\d+)*$/` (uvx), and none contains `@latest`.
- [ ] **Step 2: Run it and confirm it fails.** **Step 3: Pin the versions.** **Step 4: Run it (PASS).**
- [ ] **Step 5: Commit:** `fix(mcp): pin the local MCP templates to exact versions`.

### Task 16: Install Change Plan adapter and route

**Files:**
- Modify: `packages/contracts/src/capability-connectors.ts`: add

```ts
export interface ConnectorInstallRequest { templateId: string; enableChatConnectors: boolean }
export interface ConnectorInstallResponse { templateId: string; changePlanReceipt: ChangePlanReceipt }
```

Use the receipt type that `PATCH /api/v1/settings` returns (`mission-control-shared/src/api/types.ts:428`). Move it to contracts if it isn't there already.
- Create: `apps/gateway/src/services/connector-install-change-plan-adapter.ts`: `class ConnectorInstallChangePlanAdapter implements EvolutionControlPlaneAdapter<ConnectorInstallRequest>`, mirroring `CapabilityPackChangePlanAdapter`. Register it next to that adapter at `gateway-service.ts:3319`.
- Modify: `apps/gateway/src/routes/capability-connectors.ts`: add `POST /api/v1/capabilities/connectors/install`
- Test: `apps/gateway/src/services/connector-install-change-plan-adapter.test.ts`, `apps/gateway/src/routes/capability-connectors.test.ts`

**Adapter rules:**
- **Risk:** `danger`.
- **Validation** (a readable 409 with a plain `field`, nothing changed): the template must be visible and not excluded, `authType` must be `none` or `oauth2` (`token` gives field `"needsApiKey"`), and no saved server may match its label ignoring case (field `"alreadyInstalled"`).
- **Apply**, in order:
  1. Add the template's `networkHosts` that are missing from the runtime `networkAllowlist`.
  2. Create the MCP server from the template with `enabled: false` and the template's policy plus `approvalPosture: "reads_free"`.
  3. If `enableChatConnectors` is true and `chatStaticMcpV1Enabled` is off, turn the flag on.

**Route details:**
- Body: `z.object({ templateId: z.string().min(1).max(200), enableChatConnectors: z.boolean() }).strict()`.
- Rate limit: `{ max: 10, timeWindow: "1 minute" }`.
- Actor: `{ workspaceId, actorId: <same derivation as dashboard.ts:771-821>, surface: "capabilities" }`.
- Flow: `evolution.create` → `confirm(..., { operatorSettingsSave: true })`. It returns 202 `ConnectorInstallResponse`.

- [ ] **Step 1: Write the failing tests:**
  - `it("adds only missing hosts, creates the server switched off, and sets Reading is free")`.
  - `it("turns on MCP in Chat only when asked and currently off")`.
  - `it("refuses an API-key template and changes nothing")`.
  - `it("refuses a template already saved under a different letter case")`.
  - Route: `it("returns a receipt that waits in Inbox when the skip setting is off")` and `it("completes when the skip setting is on")`.
  - Route: `it("rejects extra body fields")`.
- [ ] **Step 2: Run them and confirm they fail.** **Step 3: Implement it.** **Step 4: Run the tests (PASS), plus** `get-routes-publish-sweep.test.ts` **and** `capability-pack-change-plan-adapter` **tests (PASS).**
- [ ] **Step 5: Commit:** `feat(gateway): install a connector from its template through one Change Plan`.

### Task 17: Install flow hook

**Files:**
- Modify: `packages/mission-control-shared/src/api/capability-connectors.ts`: add `installCapabilityConnector(input: ConnectorInstallRequest): Promise<ConnectorInstallResponse>`
- Create: `cockpit/areas/capabilities/connectors/use-connector-install.ts`
- Test: `cockpit/areas/capabilities/connectors/use-connector-install.test.tsx`, plus a shared client test for the POST

**Interfaces:**
- Consumes:
  - `installCapabilityConnector`
  - `fetchChangePlan`, with the polling pattern from `features/native-routes/settings/use-settings-change.tsx`
  - `fetchCapabilityConnectors`
  - `startReviewedMcpOAuth`, `completeReviewedMcpOAuth`, `updateMcpServer` and `connectReviewedMcpServer` (`mcp-operations.ts`)
  - the BroadcastChannel `goatcitadel-mcp-oauth-return` (`features/native-routes/settings/mcp-oauth-return.ts`)
- Produces:

```ts
export type ConnectorInstallStep = "plan" | "approval" | "sign_in" | "finish_sign_in" | "switch_on" | "connect";
export type ConnectorInstallState =
  | { phase: "idle" }
  | { phase: "working"; step: ConnectorInstallStep }
  | { phase: "waiting_inbox"; approvalId: string }
  | { phase: "signing_in"; authorizeUrl: string; signInHost: string; scopes: string[] }
  | { phase: "done"; serverId: string }
  | { phase: "failed"; step: ConnectorInstallStep; message: string; changed: string[] };
export function useConnectorInstall(item: CapabilityConnectorItem): {
  state: ConnectorInstallState;
  start(options: { enableChatConnectors: boolean }): void;
  /** For a saved server: Reconnect re-runs sign-in (then switch on and connect); Try again re-runs connect. */
  resume(from: "sign_in" | "connect"): void;
  submitManualCode(code: string, state: string): void;
  cancel(): void;
};
```

The panel wires "Reconnect" (sign_in_expired or needs_sign_in) to `resume("sign_in")` and "Try again" (broken) to `resume("connect")`.

**Sequence:**
1. `plan`: install.
2. If the receipt is `awaiting_approval`, go to `waiting_inbox` and poll until the plan completes or is rejected. Rejected means `failed`, with `changed: []`.
3. Refetch the connectors and find the item with this `templateId` to get `serverId` and `serverRevision`.
4. For OAuth templates: start the reviewed OAuth flow and wait for the return. Only a message whose `state` matches the pending state is accepted. Then complete it.
5. `switch_on`: `updateMcpServer({ enabled: true })`.
6. `connect`: `connectReviewedMcpServer`.
7. `done`.

The OAuth return still lands on `/settings/connections#mcp-oauth-return…`, whose Settings page forwards it over the BroadcastChannel to this tab, so the return route doesn't change. `changed` lists what already happened in plain words, for example "Allowed mcp.linear.app" or "Saved Linear, switched off".

- [ ] **Step 1: Write the failing tests:**
  - `it("runs install, sign-in, switch on and connect in order when the skip is on")`: the call order is asserted.
  - `it("waits in Inbox with the approval id and resumes when approved")`.
  - `it("ignores a sign-in return with a different state")`: the phase stays `signing_in` and `completeReviewedMcpOAuth` is not called.
  - `it("reports the switch-on step and what changed when enabling fails")`: the phase is `failed`, the step is `"switch_on"`, `changed` is non-empty, and `done` is never reached.
  - `it("cancel leaves the server saved but switched off and says so")`.
  - `it("Reconnect starts at sign-in for a saved server and skips the install plan")`: `installCapabilityConnector` is not called.
- [ ] **Step 2: Run them and confirm they fail.** **Step 3: Implement it.** **Step 4: Run the tests (PASS).**
- [ ] **Step 5: Commit:** `feat(cockpit): one-button connector install flow`.

### Task 18: Install panel and Install action

**Files:**
- Create: `cockpit/areas/capabilities/connectors/ConnectorInstallPanel.tsx`
- Modify: `connector-view.ts`: for available rows, `connectorAction` returns `{ kind: "install", label: "Install" }`, or `"Set up"` when `reason` is `needs_api_key` or `missing_sign_in_setup`. Update its test table.
- Modify: `ConnectorPanel.tsx`: available items render `ConnectorInstallPanel`.
- Test: `cockpit/areas/capabilities/connectors/ConnectorInstallPanel.test.tsx`

**Panel content:**
- "What it lets GoatCitadel do": the description, plus the template's risk notes as plain sentences.
- "How it connects": the sign-in host (`describeAuthorizeHost`) and the hosts to allow. For on-device templates, the exact command and the network warning from Task 10.
- "What asks first": "Reading is free. Before it creates or changes anything, I ask you in Chat. You can change this later."
- When `item.chat.blockedBy === "mcp_in_chat_off"`, a pre-ticked checkbox: "Also let Chat use connectors". When it is `"background_runs_off"`, a plain note instead of the checkbox, using the cockpit's existing wording for that feature.
- The primary button reads "Sign in and install" for OAuth or "Install" otherwise. API-key templates get no primary button: they get "Needs an API key" plus "Set up in Settings".
- Progress shows as a step list with the live state.
- `waiting_inbox` shows "Waiting on you in Inbox", with "Open in Inbox" linking to `/inbox?approvalId=<id>`.
- `signing_in` shows "Finish signing in in your browser", the "Open sign-in page" link, and the manual code and state fields behind a disclosure.
- `failed` names the step and lists `changed`.
- `done` swaps to the Manage view.

- [ ] **Step 1: Write the failing tests:**
  - `it("shows the sign-in host and the hosts it will allow")`.
  - `it("offers no Install for an API-key app")`.
  - `it("pre-ticks Also let Chat use connectors when MCP in Chat is off")`.
  - `it("shows Waiting on you in Inbox with a link")`.
  - `it("names the failed step and what changed")`.
- [ ] **Step 2: Run them and confirm they fail.** **Step 3: Implement it.** **Step 4: Run the tests (PASS).**
- [ ] **Step 5: Run the PR checks.** Run mc-next `typecheck`, `perf:check`, the gateway tests from Tasks 14–16, and `git diff --check`. Then get browser proof against the sandbox gateway: install a no-auth vendor template end to end with the skip setting on, and see it wait in Inbox with the setting off. Take desktop and phone screenshots.
- [ ] **Step 6: Commit:** `feat(cockpit): install connectors from the Capabilities panel`. Then open PR 1c.

---

## Spec coverage for Phase 1

| Spec requirement | Task |
|---|---|
| Capabilities in the main navigation, tabs as routes | 7, 8 |
| Shared search with tab badge, data-drawn placeholder, "+N" filter overflow | 8, 9 |
| Two-column row cards, one state and one action per row, state groups | 6, 9 |
| One merged connector list from the Gateway; exclusions; label merge | 1–3 |
| "On this device" with exact command, warning and pinned versions | 2, 10, 15 |
| Not available in Chat / hidden in workspace never shown as plain Connected | 2, 9, 10 |
| Side panel for details, Manage, tool list, Remove (danger, confirmed), Advanced setup link | 10, 13 |
| Add your own (custom MCP setup inside the panel); linkable items (`?item=`) | 10 |
| Reconnect and Try again on saved servers | 17 |
| Optimistic switch with per-row rollback; conflict reload | 5, 10 |
| Hermes-style switch as the standard; DESIGN.md exception | 5, 6 |
| Approval skip follows #572, extended to Capabilities; `remote_hardened` asks | 14 |
| One-button governed install with progress, Inbox wait and plain failures | 16–18 |
| "Also let Chat use connectors", pre-ticked | 16, 18 |
| What asks first: three settings, default Reading is free, saved servers unchanged | 11–13, 16 |
| Partial failures shown, never 0 | 3, 9 |

**Deferred from the spec, and why:**
- **API-key connectors install through Settings for now.** The spec says secrets go to the Vault, but no Gateway path accepts MCP key values today (MCP keys come from the process environment and are copied to the OS keychain on connect). A key owner for connectors needs its own design. Until then, those rows say "Needs an API key" and link to Settings.
- **"Open on the last tab used"** waits until a second tab exists (Phase 2).
