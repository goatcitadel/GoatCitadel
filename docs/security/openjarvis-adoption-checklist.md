# OpenJarvis-Inspired Adoption Checklist

Last updated: 2026-05-29

This checklist keeps OpenJarvis-inspired ideas aligned with GoatCitadel runtime truth, policy, and operator control.

## Runtime Telemetry

- Record measured gateway latency only from actual runtime calls.
- Treat token counts, cost, power, energy, accelerator utilization, and memory use as optional fields.
- Label every metric as `live`, `cached`, `estimated`, or `unavailable`.
- Do not synthesize hardware metrics when a local engine does not expose them.
- Do not claim unsupported local-engine invocation. Catalog entries may be advisory-only.

## Provider Advice And Eval Proof

- Provider advice is advisory-only and must not mutate routing, keys, or model settings.
- Eval proof may use existing measurements and operator quality scores, but must not call paid or local providers implicitly.
- Pareto results must preserve missing data as unavailable rather than treating it as a hidden zero.
- Cost estimates must disclose synthetic usage or provider-reported usage provenance.

## Skill Import

- Imported skills are inspectable, not callable, until governed activation.
- Script files and risky script indicators remain non-executable by default.
- External tool declarations must map to governed capabilities before use.
- Source provenance should include provider, source reference, captured time, and a non-callable-until-activated flag.

## Memory Benchmarks

- Retrieval benchmarks are read-only diagnostics.
- Benchmarks may compose context and report latency, QMD status, citation count, token estimates, and overlap score.
- Benchmarks must not write learned memory, decisions, entities, relations, or maintenance records.

## Public Claims

- Do not claim hostile-code sandboxing for Code Mode.
- Do not claim full local inference maturity from optional sidecars or advisory local engine catalog rows.
- Do not claim remote MCP transport invocation unless implemented and verified.
- Do not claim release, screenshot, backup restore, or eval evidence that was not actually produced.
