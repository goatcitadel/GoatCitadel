# OpenCode in GoatCitadel

GoatCitadel supports optional OpenCode delegation from Chat through the bundled
`opencode` skill. It uses the existing shell policy, approvals, cwd validation,
redacted process environment, output capture, and cancellation. No provider
credentials are copied from GoatCitadel to OpenCode.

## Setup and use

Install the official [OpenCode CLI](https://opencode.ai/docs/cli/) on the Gateway
host and configure its provider with `opencode auth login` in a terminal. Make the
CLI available to the Gateway service account. A desktop terminal's PATH and home
directory may differ from the Gateway's. On Windows a directly invocable
`opencode.exe` is preferable to an npm command shim.

After the usual skill catalog reload, select `opencode` through the existing Chat
skill picker or explicitly ask, “Use OpenCode to review this project.” Skill
selection does not install the executable, authenticate a provider, grant shell
access, or bypass capability activation. Existing policy and approvals apply.

The skill uses `opencode run --format json --agent plan -- "task"` for review;
authorized implementation can use `build`. It supplies an explicit project cwd
and `timeoutMs` (normally 300000, capped at 900000). The foreground process stays
attached to the turn so stopping Chat kills its process tree. Long-running
background shell commands discard output and are not used by this integration.

Chat displays the process activity while it runs, then an expandable OpenCode
result containing its answer, reported steps, file names, and bounded diff
previews. Captured output remains subject to the shell's output limits and uses
the existing artifact inspector when large.
Partial output, tool errors, and nonzero process exits remain visible. Follow-ups
use the recorded OpenCode session ID explicitly, never a global “continue last.”

## Ownership and limits

The parent shell invocation is the Gateway approval boundary. OpenCode uses its
own permissions for internal tools and its own provider/network configuration.
The process cwd check does not jail all child actions. Run only trusted work in
an operator-approved environment; this is not a hostile-code sandbox or an ACP
permission bridge. Permission prompts in noninteractive OpenCode can be rejected;
the skill reports that block instead of using auto-approval flags.

`externalAgent` in a tool result is a bounded presentation projection from redacted
JSONL. It never creates an approval, durable run, canonical file receipt, or
verification result. Independently inspect the actual diff and run checks before
claiming implementation success. A timeout or cancellation can leave partial
changes, so inspect before retrying. No automatic replay is added.

## Source comparison

Reviewed OpenCode at `ebb7b76eca82342642c78645109e865614533827`, particularly
`packages/opencode/src/cli/cmd/run.ts` and the edit/apply-patch result metadata.
The installed Hermes source reviewed at
`6621e8aa98c0aa90bd20fe4b86c3bbc764b5dffb` uses an OpenCode delegation skill, while
its Desktop transcript uses assistant-ui and Streamdown. OpenCode integration and
transcript presentation are separate concerns. GoatCitadel keeps its existing
React/assistant-ui display owners and adds native result previews without
importing a second application or replacing the Gateway.

## Validation

Protocol fixtures cover errors, incomplete output, mixed sessions, bounds, and
reported file metadata. Process checks cover timeouts, stdin EOF, and cancellation.
Component checks cover expandable diffs and truthful failure display. The existing
`chat-demo.html` includes a clearly labeled OpenCode presentation fixture for
desktop, narrow viewport, light, and dark inspection. Fixtures are not proof of
an installed OpenCode/provider round trip; that requires configured CLI access.
