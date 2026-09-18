# MCP credential write receipts

Windows MCP OAuth and environment enrollment now use a distinct
`receipt-v1:<version UUID>` credential account suffix when the canonical staging
owner is present. Existing account names and values remain readable. Unsupported
platforms retain their existing write path and do not advertise receipt recovery.

The staging transaction creates an independent write UUID before calling the
credential helper. Access and refresh tokens share that write identity but occupy
separate immutable accounts. The credential value and write UUID are serialized
together inside the same PasswordVault slot. Ordinary consumers receive only the
original value, with its exact whitespace preserved. The envelope is bounded to
48 KiB of ASCII-safe JSON, including escaped Unicode code units so Windows console
code pages cannot alter the value. Values and their digests never enter staging, retirement, audit,
or generic request metadata. The raw envelope reaches the helper through stdin,
not command arguments or environment variables.

## Recovery and retirement

An unacknowledged version remains unpublishable. After its original ten-minute
window, maintenance may inspect a new-format slot through its original Windows
host/account custodian. The helper reports only whether the exact registered
write UUID is present. It never returns the credential value to reconciliation.

A matching envelope proves that the immutable helper's single `Add` operation
stored this version. This permits recovery when helper output or the subsequent
database acknowledgement was lost. Recovery rechecks the canonical staging
identity and all current credential bindings after the OS read. It atomically
records the terminal stage and permanent retirement; it never activates the
abandoned OAuth request or environment binding. Competing database writers are
fenced by compare-and-set, and failed retirement rolls back the stage change.

Retirement retains the original custodian and write UUID. The deletion helper
checks both before removing the captured credential. Missing retired slots can
acknowledge a prior deletion; mismatched slots remain untouched. A lost deletion
acknowledgement keeps the permanent tombstone and can be reconciled after restart.
Generic secret write/delete methods refuse the new receipt namespace.

Queue rotation is bounded fairness bookkeeping. It preserves another
reconciler's winning queue when its compare-and-set loses, without discarding
already committed credential outcomes. Credential transaction conflicts defer
that version to a later pass; other failures remain explicitly counted.

## Compatibility and remaining limits

- New receipts use private staging/retirement format 3 in existing
  `system_settings` records. Older format 1/2 records are parsed without being
  rewritten or assigned invented custody. No SQL migration or user-data rewrite
  is required.
- Missing receipts, missing slots before a proven completed write, foreign
  custody, legacy/unindexed credentials, and custody migration still require
  reconciliation. Age or an absent slot cannot prove that a suspended helper
  will never write. These cases do not authorize deletion.
- This protects the canonical immutable-write protocol. It does not establish
  isolation from arbitrary code running as the same OS user or a machine
  administrator.
- Older binaries do not understand the new account suffix. A rollback requiring
  those credentials needs an explicit reconnect through that version's own
  setup flow; no in-place conversion is attempted.
- Local proof uses synthetic vault objects, mocked helper transport, disposable
  SQLite databases, actual PostgreSQL RPC workers, and loopback token endpoints.
  Actual PasswordVault mutation, installed custody, and live-provider acceptance
  remain unproven.

Evidence: [comparison implementation status](testing/COMPARISON_IMPLEMENTATION_STATUS.md#mcp-completed-write-receipt-recovery).
