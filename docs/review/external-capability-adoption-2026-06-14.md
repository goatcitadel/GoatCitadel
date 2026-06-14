# External Capability Adoption - 2026-06-14

This note records the implementation boundary for the external capability roadmap. It is not a public product claim and does not replace `docs/1_0_CONTRACT.md`, `docs/CANONICAL_RUNTIME_STATE_MODEL.md`, or live implementation truth.

## Landed in this slice

- `docs.ingest` now parses local PDF, DOCX, XLSX, CSV, and text files through the existing native ingestion path.
- Unsupported binary formats fail clearly instead of producing silent empty chunks.
- Ingestion metadata keeps `rawContentStored: false` and now records parser provenance.
- Knowledge chunks can store embedding metadata per chunk.
- `memory.write`, `docs.ingest`, `embeddings.index`, and `embeddings.query` now use the shared local embedding provider path.
- Transformers.js is the default runtime provider; pseudo embeddings are retained as an explicit test/degraded fallback and are reported as `pseudo-embedding`.
- Promptfoo red-team config and garak-shaped JSONL probe corpora are previewed as review-only, non-callable eval assets.

## Observability path

Current implementation already has an Ops Quality export with OTEL-shaped spans at `/api/v1/ops/quality/export?format=otel_json`. That remains a diagnostic projection, not canonical runtime state.

Next code slice should add manual instrumentation around Gateway-owned high-value events:

- provider/model calls
- durable run transitions
- tool and MCP invocation
- approvals
- memory recall/proposal
- document ingestion
- embedding jobs

Implementation rules:

- Keep durable records canonical.
- Keep spans bounded, redacted, and identifier-linked.
- Add OTLP export disabled by default, enabled by config.
- Evaluate Phoenix or another local viewer only after useful spans exist.

## Red-team/eval payload path

The prompt-pack harness remains authoritative. Imported external payloads must remain review assets until the operator explicitly imports and activates them.

Copy natively:

- Promptfoo red-team structural preview.
- Garak probe rows as non-callable payload candidates.
- Small checked-in fixtures for importer behavior.

Do not adopt:

- Provider calls during preview.
- Auto-promotion from imported payload to callable eval/run state.
- External eval framework replacing GoatCitadel prompt-pack gates.

## ToolHive MCP Study

Sources checked on 2026-06-14:

- ToolHive repository: https://github.com/stacklok/toolhive
- ToolHive docs: https://docs.stacklok.com/toolhive/
- Network isolation guide: https://docs.stacklok.com/toolhive/guides-cli/network-isolation
- Registry guide: https://docs.stacklok.com/toolhive/guides-ui/registry
- ToolHive catalog: https://github.com/stacklok/toolhive-catalog
- Registry Server: https://github.com/stacklok/toolhive-registry-server

Copy natively:

- Per-MCP-server health and permission summaries in GoatCitadel Library/Ops.
- Registry UX concepts: curated entries, role/use-case grouping, and operator-visible default permission profiles.
- Provenance labels and signing/attestation fields as review evidence on MCP server entries.
- Endpoint/tool filtering summaries surfaced before activation.

Optional sidecar:

- Containerized MCP process isolation for servers that benefit from Docker/Podman boundaries.
- Registry aggregation for large teams that need custom catalogs and audit trails.
- Kubernetes/vMCP-style aggregation for shared-host or enterprise deployments.

Do not adopt:

- Do not replace `mcp-runtime`.
- Do not replace Gateway policy, OAuth token handling, approval flow, audit, or network allowlists.
- Do not collapse `inspectableCatalog` and `callableCatalog`.
- Do not imply that ToolHive-style container isolation replaces path jails, auth, approvals, or deny-wins policy.

## Durable queue decision

No pg-boss, Graphile, Hatchet, or Temporal dependency is adopted in this slice.

Rationale:

- `DurableRunService` already owns leases, worker lifecycle, boot recovery, dead letters, diagnostics, and verification lanes.
- There is no current evidence in this slice of queue contention, multi-process worker limits, Postgres-only deployment pressure, or operational complexity that justifies replacing the existing worker.
- Queue frameworks remain reference designs until a concrete pain signal appears.

## Required follow-up proof lanes

- `pnpm --filter @goatcitadel/policy-engine exec vitest run src/ingestion-backends.coverage.test.ts src/tool-executor-tail.coverage.test.ts`
- `pnpm --filter @goatcitadel/storage exec tsx --test src/knowledge-repo.test.ts`
- `pnpm --filter @goatcitadel/policy-engine exec tsc --noEmit --pretty false`
- Gateway prompt-pack parser tests after eval preview changes.
- Repo-wide `pnpm typecheck`, `pnpm verify:fast`, `pnpm docs:check`, and `git diff --check` before merging a full branch.
