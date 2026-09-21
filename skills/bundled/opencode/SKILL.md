---
name: opencode
description: "Delegate a scoped coding or review task to an operator-configured OpenCode CLI and inspect its reported changes in Chat. Use when the operator explicitly requests OpenCode."
metadata:
  version: "0.1.0"
  tags: [code, external-agent, opencode]
  tools: [shell.exec, git.status, git.diff, fs.read]
  keywords: [opencode, use opencode, delegate to opencode]
---

# OpenCode

Use OpenCode as an optional external coding agent through Gateway-governed
`shell.exec`. GoatCitadel remains the owner of the Chat turn, approvals, process
cancellation, and captured evidence. OpenCode owns its own agent session and
provider configuration. Its file-change reports require independent verification.

## When to use

- The operator explicitly requests OpenCode for implementation, review, or debugging.
- A concrete objective, approved project directory, and verification criteria are available.

Do not use for ordinary Chat or silently substitute it for the selected model.
Do not run it when shell policy, workspace scope, or required approval blocks it.

## Inputs

Required: objective, absolute project directory, review versus implementation scope.
Optional: explicit `provider/model`, an OpenCode session ID returned by this same
project's previous run, and a time limit (default 300000 ms, maximum 900000 ms).
For follow-up, use the recorded session ID; never `--continue`, which can select
an unrelated session. Do not attach secrets or private files outside approved scope.

## Prerequisites

1. Use `shell.exec` with `command: "opencode --version"` to check the executable.
2. OpenCode must already have operator-configured provider authentication. If it
   needs setup, explain that the operator can install the official CLI and run
   `opencode auth login` in their terminal. Never read its credential files,
   request credentials in Chat, install it silently, or copy Gateway credentials.
3. Inspect `git.status` and relevant files. Preserve existing work. Use an existing
   approved isolated checkout where available; do not create one without authority.

## Workflow

1. State the task, directory, chosen agent (`plan` for review, `build` for authorized
   implementation), optional model, time limit, and success criteria. The normal
   shell approval covers the external process and its scope. It is not a separate
   approval for each internal OpenCode tool. OpenCode's permissions still apply.
2. Invoke the CLI directly with `shell.exec`, JSON event output, and explicit cwd:

   ```json
   {
     "command": "opencode run --format json --agent plan -- \"Review the retry logic; report findings without editing files.\"",
     "cwd": "C:\\projects\\example-project",
     "timeoutMs": 300000
   }
   ```

   For implementation, use `--agent build` only within the authorized scope.
   Place optional `--model provider/model` and `--session ses_...` before `--`.
   Quote each argument for the shell tool's argument parser; never interpolate
   shell expansions, chain commands, or wrap the invocation in another shell.
   Prefer `opencode.exe` on Windows if an installed command shim cannot execute.
3. Keep the call in the foreground: it captures output and remains attached to
   Chat cancellation. `shell.exec_background` discards output and is unsuitable.
   Chat shows the running process; structured steps and diffs arrive when it exits.
4. Inspect the exit code, JSON errors, incomplete/truncated output, and reported
   session ID. A zero exit code is not proof that the requested task succeeded.
   Noninteractive OpenCode may reject internal permission prompts: report the
   block rather than adding `--auto`, `--yolo`, `--dangerously-skip-permissions`,
   or changing permissions to allow everything.
5. Independently inspect `git.diff` and run the scoped verification. On timeout or
   cancellation, inspect partial changes before any retry; do not blindly replay.

## Output contract

Report the OpenCode session ID, actual command outcome, reported changes versus
verified diff, verification results, and remaining work. The UI's file list and
step labels are external agent reports, not canonical file receipts or proof of
tests passing. This integration is trusted local process execution, not a hostile
code sandbox. Ordinary process cwd validation does not jail every child action.

## Boundaries and related skills

Keep deny-wins, approvals, grants, workspace controls, and environment scrubbing.
Do not auto-activate capabilities, widen filesystem/network access, commit, push,
publish, or install dependencies merely to make a delegated task succeed.
Use `coding` for native implementation, `qa` for verification, and `planning` for
task decomposition. Upstream references: https://opencode.ai/docs/cli/ and
https://github.com/anomalyco/opencode. This skill is authored for GoatCitadel;
it follows the optional CLI-delegation pattern also used by Hermes.
