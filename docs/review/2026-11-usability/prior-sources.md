# Prior findings register: sources and counts

`prior-register.json` is built by `tools/build-register.cjs` from five earlier sources. Every row starts at `verdict: null`; Tasks 3 to 5 fill the verdicts. The counts below are the script's own output.

## Counts

| source | rows in source | already fixed, skipped | out of scope, skipped | imported | merged away | final |
|---|---|---|---|---|---|---|
| ledger-233 | 233 | 0 | 0 | 233 | 0 | 233 |
| followup-157/new-157 | 157 | 115 | 0 | 42 | 0 | 42 |
| followup-157/older-206 | 206 | 178 | 0 | 28 | 1 | 27 |
| comprehensive-138 | 138 | 0 | 52 | 86 | 1 | 85 |
| parity-routes | 64 | 0 | 25 | 39 | 0 | 39 |
| owed-live | 35 | 0 | 0 | 35 | 1 | 34 |
| total | 833 | 293 | 77 | 463 | 3 | 460 |

Imported minus merged away is 460, the register's length. Rows by area: capabilities 18, chat 116, first-run 15, global 120, inbox 21, library 20, messaging 16, settings 86, system 26, work 22. No row has area `projects` (the only project route, `projects/root`, has its own Cockpit page).

## Rebuild

```
node docs/review/2026-11-usability/tools/build-register.cjs --ledger docs/ux/cockpit-remediation/remediation-ledger.json --followup-data <followup-data.js> --followup-status <followup-status.js> --comp-ledger <findings-ledger-closure-957.json> --comp-areas docs/review/2026-11-usability/prior-comp-areas.json --parity docs/ux/cockpit-remediation/classic-parity-inventory.json --owed docs/review/2026-11-usability/prior-owed-live.json --merges docs/review/2026-11-usability/prior-merges.json --out docs/review/2026-11-usability/prior-register.json
```

Hand-written inputs, all in this directory: `prior-owed-live.json` (owed-live rows), `prior-comp-areas.json` (area of every comprehensive row, or the reason it is skipped), `prior-merges.json` (merges and cross-references). The two follow-up scripts are the page data of the published "Cockpit follow-up review" (`window.VERIFY`, `window.FINDINGS`, `window.STATUS`), downloaded for this review and kept outside tracked files.

## Row ids

`priorId` keeps each source's own id. Two sources reuse ids for different defects: the older 206-finding audit numbers its rows `CH-01`, `GL-01` and so on, exactly like the 2026-10-03 teardown in the ledger. The ledger keeps the plain id; a colliding row from the older audit gets the suffix `~fu206` (122 of its 206 ids collide; 21 of its 28 imported rows were renamed, and `sourceId` holds the original id). Ids minted here: `PR-<route slug>` for parity routes, `OL-<nn>` for owed-live rows in file order. A merged row keeps one primary `priorId` and lists the others in `priorIds`; its `source` is then an array. `seeAlso` lists rows that touch the same screen or defect but were kept apart.

## Per source

**ledger-233.** All 233 rows imported (219 teardown findings of 2026-10-03 plus the 14 parity findings `N-01` to `N-14`). Kept: id, title, severity, acceptance criterion (as `criterion`). The ledger's own status fields are copied to `sourceStatus`; none was used to skip a row, because the brief asks for every row. Area comes from the id prefix (`NV` and `GL` are `global`, `FR` is `first-run`); `N-xx` areas were set by hand from each row's screen.

**followup-157.** Source data: `window.FINDINGS` (the 157 new findings), `window.VERIFY` (the 206 older findings re-checked) and `window.STATUS` (later per-finding state). A row is skipped when its current state is fixed: the state in `STATUS` when there is one, otherwise the review verdict.
- New 157: 115 fixed and skipped, 42 imported (28 open, 5 partial, 9 deferred). Matches the expectation.
- Older 206: the review verdicts were 149 fixed, 8 "fixed" with a caveat, 41 open, 5 regressed and 3 deferred (the expected 41, 5 and 3 = 49). `STATUS` later marks 23 of those 49 fixed (22 open, 1 regressed), leaving 26. Two rows with a review verdict of fixed (`CH-11`, `CH-24`) have a later `STATUS` of deferred and partial and are imported too, so 28 are imported: 16 open (12 open, 4 regressed), 7 partial and 5 deferred by their current state. 178 are skipped: 147 fixed by the review, 8 fixed with a caveat, 23 fixed since. One imported row (`CH-24`) is merged away, so 27 remain.
- Titles are the first sentence of the follow-up page's problem text (the page has no title field). `criterion` is the page's suggested fix.

**comprehensive-138.** The ledger is `findings-ledger-closure-957.json` in the comprehensive-review-20261102 worktree (the newest closure ledger; 138 findings; read only). 86 rows are imported and 52 skipped as out of scope. The rule is in `prior-comp-areas.json`: a row is imported when an operator can meet the symptom through the Cockpit, Chat, the desktop app, a messaging channel or a configured integration. Skipped: pure storage (10), CI, packaging and test-harness rows (32), documentation claims (2), and backend-protocol, hardening or source-hygiene rows with no Cockpit symptom (8). Every row there is "candidate implemented, focused proof" in that worktree; whether the fix reached `PINNED_SHA` is for the verdict to establish. Severity is mapped P1 to High, P2 to Medium, P3 to Low (`sourceStatus.sourceSeverity` keeps the original). Five rows have no title; the first sentence of the trigger is used.

**parity-routes.** `classic-parity-inventory.json` lists 64 routes, and every one has the same `destination_status` (`native_candidate_requires_action_parity`) and `parity_verified: false`; it has no field that says partial, link-out or missing. The rule used: import a route when its Cockpit destination is not a dedicated page of its own, that is, it is folded into an area root (for example Cowork pages to `/chat`), it is a section of a combined page (a `#anchor`), or its release scope is experimental. 39 routes are imported (10 folded into an area root, 25 sections of a combined page, 4 experimental); 25 routes whose destination is a dedicated page (for example `ops/quality` to `/system/quality`, or `library/files` to the same path) are skipped and counted as out of scope. No route links out to Classic as its Cockpit destination (checked against the 2026-10-19 hand-off slice in the inventory).

**owed-live.** 35 rows typed by hand: 11 from the operator checklist in `docs/review/2026-10-cockpit-verification-gaps.md` (cross-browser smoke, real browsers, screen readers, real models, packaged app, SY-02 re-test, gateway outage, long session, first-answer baseline, nightly dispatch, large-data run), plus 24 live checks owed from merged work: Review answer, deep research truncation (#682), native skill import, Code Mode PDF, one-click Settings approvals (#625), Firecrawl base URL and allowlist, vendor MCP connector, Google desktop sign-in, ten messaging channels end to end (Discord, Slack, Telegram, Google Chat, Teams, WhatsApp, LINE, Matrix, QQBot, WeCom), Inbox approvals with no workspace, four plugin-panel copy items, and the skill-id collision refusal. Severity is `n/a`.

## Merges

Merged only when two rows are clearly the same defect on the same screen.
- `SY-02` (ledger) absorbs `OL-06` (the fresh-install re-test of that very finding).
- `CH-R09` (follow-up new finding) absorbs `CHAT-ORG-SAVE-001` (comprehensive) and `CH-24~fu206` (older audit): the Chat Folder and Tags form infers its save result from the draft.
- 27 pairs or groups are cross-referenced with `seeAlso` and kept apart, among them the owed-live rows that name the teardown ids their check would settle (for example `OL-03` with `NV-05`, `OL-07` with `NV-20`).
- A same-source near duplicate (`N-03` and `ST-11`, the blank Models "Get started" panel) is cross-referenced, not merged.
