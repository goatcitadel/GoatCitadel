# Capability self-knowledge

Chat uses two complementary sources to explain GoatCitadel's capabilities:

- A compact shipped operating guide in the base agent prompt. Detailed workflow sections are retrieved by task through `capabilities.explain`.
- A read-only explanation service that combines workspace-scoped inspectable catalogs, representative policy probes, connector status, conversation settings, the current turn's capability selection when present, and Code Mode readiness.

The model-callable tool accepts `query` (1–512 characters) and optional `limit` (1–5). It does not accept caller-selected workspace, account, activation, or policy arguments. The Gateway binds scope from the current session and preserves the invoking actor's policy context.

Results include a version, session/workspace, observation time, bounded matches, source labels, coverage, and relevant workflow sections. The states mean:

| State | Meaning |
| --- | --- |
| `ready` | The checks described in the result passed. For tools, representative policy checks passed; exact arguments and prerequisites still need execution checks. For connectors, local stored status reports configured and available to Chat; no action is authorized. |
| `approval_needed` | A representative tool call requires operator approval; no approval has been granted. |
| `setup_needed` | An observed connection, sign-in, or supported execution prerequisite needs setup. |
| `blocked` | Current policy, selection, execution settings, or observed service state prevent use. |
| `unknown` | A required check failed or the available evidence cannot establish execution readiness. Callable skills remain unknown until their tool and task prerequisites are checked. |

Coverage is `complete` for the bounded search, `partial` when matches or source reads were omitted, `no_match` when the query found none, or `unavailable` when neither catalog nor connectors could be read. These labels are not claims of exhaustive product support. An empty result never establishes that a capability is unsupported.

The service uses existing local owners; it does not contact services, test credentials, activate capabilities, mutate configuration, create approvals, or perform the requested task. It omits raw connector configuration, credential fields, and errors; displayed metadata receives the existing secret redaction. Imported descriptions are data, never instructions. Existing deny-wins policy, approvals, auth, workspace selections, path/network limits, and frozen turn authority remain authoritative.

Native web search and Firecrawl's native fallback do not require optional provider keys. The explanation reads the same browser-defaults owner as execution and checks Firecrawl connection setup only when that backend is selected without native fallback. Tools with additional turn-exposure gates remain unknown without enough admission evidence. Frozen policy denials and approval restrictions are preserved; an explanation never broadens a frozen turn.

`capabilities.explain` is independent of the bounded-discovery feature flag and participates in normal Chat schema selection and policy checks. Manual autonomy, quick-web routing, or a frozen capability profile may still make it unavailable. The base prompt only recommends calling it when callable. Existing `capabilities.search` and `skills.read` feature gates remain unchanged.

Profiles such as Safe may require approval for this read-only inspection. Its approval preview shows the bounded question, result limit and conversation scope, and states that the inspection does not activate capabilities, change settings or perform the requested task. Previously saved inspection approvals can reconstruct that preview through the existing legacy-preview owner. Denying an inspection withholds execution and closes that turn's tool path.

Verification health probes require an environment that permits loopback connections. An execution sandbox can report `EACCES` even when Gateway logs show it listening. The verification helper now reports `EACCES`/`EPERM` immediately and retains the last HTTP status for an actual readiness timeout; ordinary startup connection refusal remains retryable. Do not weaken Gateway auth or network policy to work around a verifier's host restriction.

## Maintenance

Runtime guide content lives in `apps/gateway/src/services/capability-operating-guide.ts`; it is packaged with the Gateway and does not consume the shared operator guidance budget. Keep workflow claims aligned with implementation and the 1.0 contract. Do not put installation-specific availability, secrets, or account information in the guide. Update the guide version and behavioral tests when its contract changes.

The implementation and test owners are `capability-explanation-service.ts`, `capability-explanation-service.test.ts`, `capability-operating-guide.test.ts`, `chat-turn-agent-runner.capability-explanation.test.ts`, and the policy engine's `capability-discovery-tools.test.ts`.
