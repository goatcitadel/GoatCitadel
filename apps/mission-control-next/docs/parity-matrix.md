# Mission Control Next Parity Matrix

Updated: 2026-05-18

Current note: this matrix is a historical parity ledger for the initial Mission Control Next cutover. The live
release route set, including native Library capability routes and Settings permissions/workspaces coverage, is
derived from `src/app/route-model.ts` and checked by `scripts/verification/lib/release-surface-manifest.mjs`.

Status legend:

- `mapped`: the gateway family has an explicit destination in `mission-control-next`
- `implemented`: the destination exists in the new shell today
- `verified`: covered by automated or manual proof in this implementation pass

| Gateway family | New home | mapped | implemented | verified | Notes |
| --- | --- | --- | --- | --- | --- |
| `chat.projects`, `chat.sessions`, `chat.messages`, `chat.attachments`, `chat.misc`, `chat.tools` | `/chat` | yes | yes | partial | Reused through the existing `ChatPage` with the new shell and path router. |
| `chat.delegate`, `orchestration`, `assembly`, `tasks` | `/cowork`, `/cowork/tasks`, `/cowork/board` | yes | yes | partial | Cowork defaults to the cowork surface; tasks and board have dedicated destinations. |
| `code-mode`, `chat/workbench/*` | `/code` | yes | yes | partial | Code uses the next-shell threaded workbench with Code Mode run detail, approvals, permission profile, override, artifact hash, and sandbox posture evidence. |
| `agents`, `skills`, `capabilities`, `knowledge`, `memory` | `/library/agents`, `/library/skills`, `/library/capabilities`, `/library/knowledge`, `/library/memory` | yes | yes | partial | Library routes now include native next-shell destinations for skills, capabilities, knowledge, curator, agents, and memory alongside artifact/file views. |
| `files`, generated artifacts, prompt-pack catalog/export | `/library/files`, `/library/artifacts`, `/library/prompt-packs` | yes | yes | partial | File/artifact browsing and prompt packs now share the Library area. |
| `approvals`, `events`, `sessions-list`, `costs`, `dashboard` observe/schedule endpoints | `/ops/*` plus shell status strip | yes | yes | partial | Ops routes wrap approvals, activity, sessions, schedules, spend, and runtime health. |
| `auth`, `secrets`, `onboarding`, `workspaces`, `permissions`, `hooks`, `llm`, `llamacpp`, `mesh`, `npu`, `voice`, `addons` | `/settings/*` | yes | yes | partial | Settings routes map to General, Runtime, Workspaces, Permissions, Add-ons, and related hubs. |
| `integrations`, `integration-webhooks`, `connectors`, `mcp`, `comms` | `/settings/integrations`, `/settings/channels`, `/settings/mcp` | yes | yes | partial | Integration families have explicit settings homes instead of top-level shell clutter. |
| `tools`, `tools-invoke` | `/settings/tools` plus contextual trace/inspector | yes | yes | partial | Tool policy is explicit; invocation stays contextual inside reused work surfaces. |
| `durable`, `improvement`, `prompt-packs` test/benchmark/report routes, `ui-change-risk`, `dev-diagnostics`, `dev-verification`, `daemon`, `admin`, `docs` | `/ops/improvement`, `/library/prompt-packs`, `/ops/diagnostics` | yes | yes | partial | Prompt-pack quality routes now canonicalize into Library prompt packs; diagnostics remains in Ops. |
| `voice`, `media`, attachment preview | `/chat` plus `/ops/runtime` | yes | yes | partial | Chat stays the operator-facing home; runtime visibility stays in Ops. |
| `health`, `gateway-events` | shell boot/status + `/ops/runtime` | yes | yes | partial | Gateway readiness blocks the shell; SSE/runtime state is visible in the strip and Ops. |

## Redirect Coverage

| Legacy location shape | New behavior | implemented | verified |
| --- | --- | --- | --- |
| `?tab=dashboard&surface=chat|cowork|code` | redirects to `/chat`, `/cowork`, `/code` | yes | yes |
| `?space=operate&page=tasks` | redirects to `/cowork/tasks` | yes | yes |
| `?space=observe&page=activity&tab=scheduler` | redirects to `/ops/schedules` | yes | yes |
| `?space=observe&page=artifacts&tab=files` | redirects to `/library/files` | yes | yes |
| `?space=configure&page=settings&tab=providers` | redirects to `/settings/providers` | yes | yes |
| `?space=configure&page=settings&tab=permissions` | redirects to `/settings/permissions` | yes | yes |
| `?space=configure&page=settings&tab=workspaces` | redirects to `/settings/workspaces` | yes | yes |
| `?space=configure&page=agents&tab=board` | redirects to `/cowork/board` | yes | yes |

## Remaining Follow-On Work

- Replace any remaining compatibility adapters with purpose-built next-shell views incrementally, starting with Ops diagnostics.
- Add dedicated manual proof for the mobile drawer and desktop inspector behavior.
- Keep visual fixtures current as new next-shell routes are added; the current release-surface visual manifest covers the canonical route set.
