# Memory Temperature Design

Sulcus-inspired design spike for GoatCitadel memory behavior. This is intentionally doc-only in the first pass.

Last updated: 2026-03-22

## Goal

Add a lightweight "memory temperature" layer over GoatCitadel's current memory context and QMD primitives so retrieval can weight recent, frequently reused, and strongly related memories without pretending cold memories disappeared.

## Existing Foundation

- Memory context composition already exists and is operator-visible through the gateway memory routes.
- QMD and related memory-run data already exist as a structured source of retrieval signals.
- Daily memory flush behavior already prunes expired and old state without redefining the whole memory model.

## Proposed Temperature Signals

1. Recency
   Recent memories start warmer and cool over time.

2. Recall pressure
   Memories that are repeatedly retrieved or cited cool more slowly.

3. Related-memory diffusion
   When one memory is recalled, closely related memories receive a smaller heat bump.

4. Cold-memory folding
   Very cold memories should be candidates for summary folding rather than hard deletion when they still matter historically.

## Operator-Visible Metadata

- `heatScore`: current temperature value used during retrieval ranking.
- `lastRecalledAt`: latest known retrieval or citation event.
- `stalenessBand`: human-readable bucket such as `hot`, `warm`, `cool`, or `cold`.
- `foldedIntoSummaryId`: optional pointer when a cold memory has been compressed into a summary artifact.

## Retrieval Behavior

- Temperature should reweight ranking, not become a deny-list.
- Cold memories can still surface when they are the best semantic match.
- Retrieval responses should stay honest about stale or weakly supported memory.

## Storage Approach

- Keep storage local-first and compatible with current memory routes and admin controls.
- Avoid a second memory database.
- Prefer additive metadata on existing memory records or adjacent indexes.

## First Implementation Slice

1. Add heat and staleness metadata to the memory model without changing retrieval behavior yet.
2. Capture heat bumps from retrieval and citation events.
3. Surface operator-visible heat data in memory admin views.
4. Add summary-fold candidates for very cold records after operator review.

## Non-Goals

- Replacing QMD.
- Introducing a second long-term memory subsystem.
- Auto-deleting memories based only on temperature.
