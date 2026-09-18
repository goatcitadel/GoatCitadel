# Citadel Charter and setup revision contract

Charter edits, Chamber additions, template application, Blueprint import, and
Mason staging compare the reviewed Citadel structure and commit through one
`CitadelRepository.mutateStructure` transaction. A failed setup leaves the prior
Charter and every prior Chamber unchanged. Successful setup replaces the Charter
and adds the proposed Chambers; it retains existing Chambers.

`GET /api/v1/citadels/:citadelId/structure` returns a
`CitadelStructureSnapshot`, including an opaque `revision`, the optional profile,
the Charter or `null`, and Chambers. An empty or legacy Citadel without a profile
is reviewable. The token binds the Citadel identity, profile revision, complete
Charter, and ordered Chambers. Profile edits and lifecycle transitions invalidate
structure reviews. Charter and Chamber writes do not invalidate the separate
[profile revision](CITADEL_RECORD_REVISIONS.md).

The following operator routes require the snapshot's `expectedRevision`:

- `PUT /api/v1/citadels/:citadelId/charter`
- `POST /api/v1/citadels/:citadelId/chambers`
- `POST /api/v1/citadels/:citadelId/from-template`
- `POST /api/v1/citadels/:citadelId/from-blueprint`
- `POST /api/v1/citadels/:citadelId/mason/stage`

Template application also requires `expectedTemplateRevision`, returned with
each item from `GET /api/v1/citadel-templates`. This binds the exact template
contents independently of the destination. Template snapshots materialize model
policy, risk posture, Chamber sensitivity,
and sealing defaults so the review hash binds the same effective settings that
the transaction receives. Blueprint import and Mason staging accept
`{ blueprint, expectedRevision }`; the validation endpoint still accepts
the raw Blueprint. Older callers without the required revisions receive 400.
All successful structure writes acknowledge their own committed snapshot;
Mason staging returns it under `citadel` alongside its review summary.

Malformed revisions fail before persistence. A stale target returns 409 with
`code = WRITE_CONFLICT` and
`details.reason = CITADEL_STRUCTURE_REVISION_CONFLICT`. A changed template uses
`CITADEL_TEMPLATE_REVISION_CONFLICT`. An archived profile rejects structure writes
with `CITADEL_ARCHIVED`; the operator must restore it and review again. A default
Chamber reference must belong to the destination Citadel.

SQLite uses an immediate transaction. PostgreSQL uses a transaction advisory
lock scoped to the Citadel identity, including when no profile row exists, plus
the profile row lock when present. Profile creation, edits, archive/restore, and
the trusted repository Charter/Chamber primitives participate in the same lock.
The Gateway port exposes the atomic command for operator structure writes;
it does not assemble a setup from separate repository calls. This protects
repository writes, not arbitrary SQL outside the owner. No migration is needed.

Charter timestamps advance even for same-value writes and a backwards clock, so
returning to earlier content cannot revive an old revision. The acknowledgement
is captured before releasing the transaction lock. Blueprint schema and secret
validation and Mason review generation run before persistence. Route commit
markers are set after owner acknowledgement, before response serialization.

The Library preserves rejected Charter drafts, refreshes the current structure,
and requires explicit review before rebasing and saving again. Template failures
refresh both the target and template list without retrying. A committed setup
remains saved if its Gatehouse summary cannot load. Blueprint validation captures
the reviewed target revision; conflicts retain the input and require validation
and confirmation again. Changing Citadel scope invalidates pending validation.

Focused SQLite and PostgreSQL tests cover empty-scope binding, stale revisions,
same-value and ABA writes, rollback after a later Chamber insert fails, foreign
default Chamber rejection, profile/lifecycle invalidation, and acknowledgements
followed immediately by a peer commit. Seven pairs of independent connections
contend on empty and populated targets. Route and UI tests cover validation,
operator access, typed conflicts, commit truth, retained drafts, and explicit
retries. `pnpm verify:citadels:revisions` includes profile and structure browser
scenarios against a disposable runtime at desktop and 390 px widths.

Council, membership, Wards, Passages, and Citadel integration grants use the
separate [access-rule revision contract](CITADEL_ACCESS_REVISIONS.md). Vault
changes, global integration/MCP preconditions, and native two-machine acceptance
remain separate work.
