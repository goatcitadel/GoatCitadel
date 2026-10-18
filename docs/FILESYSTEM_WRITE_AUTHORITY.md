# Filesystem Write Authority

Model-driven filesystem tools can only write where the operator has allowed it. This document describes which folders those tools may write to, who can change that, and which boundaries no setting can widen.

## Where tools may write

| Scope | What it is | Who changes it |
|---|---|---|
| Runtime write jail (`sandbox.writeJailRoots`) | The runtime's own write area (defaults `./workspace`, `./data`, `./.worktrees`). Workbench, worktrees, memory exports and other runtime services also use it. | Hand-edited in `config/tool-policy.json`. Settings shows it read-only. |
| Operator write roots (`sandbox.operatorWriteRoots`) | Extra folders outside the jail that **only** model-driven filesystem, artifact and browser-output tools may write to, for example a temp folder to clean. Each folder has its own `allowDelete` flag, which is off by default. | **Settings › Safety › Tools › Filesystem write roots**, Chat's `change.request` (`operator_write_root`), or the config file. |

Operator write roots are validated when they are saved and again at every config load. A folder is refused when:

- it is a filesystem, drive or network-share root;
- it is an operating-system or program folder;
- it is the users folder or a whole user profile (folders inside a profile are fine);
- it is a credential or key folder;
- it contains the runtime;
- it is the runtime's config, secrets, Postgres or audit folder;
- it is missing, or is not a folder;
- it reaches any of the above through a link or junction.

Unsafe or duplicate entries in a hand-edited file are ignored at load with a warning. They do not stop startup.

The **OS temp folder** preset (`{ "preset": "os_temp" }`) is resolved on the server at every load. Settings offers it, but it is not enabled by default.

## What a write must pass

All of these apply, in order. Nothing later can widen what an earlier step refused.

1. **Deny-wins and tool availability.** A tool in `tools.deny` is refused everywhere. This includes `fs.delete` and `fs.write`, which are denied by default. Settings › Safety › Tools sets each of `fs.write`, `fs.delete`, `fs.copy`, `fs.move` and `fs.patch` to Denied, Available or Not listed (`tool_global_access`). Un-denying `fs.delete` or `fs.write` is a danger-risk change, because the tool becomes callable, with approval, in **every** write root, including the runtime jail.
2. **Approvals and grants.** Approval rules, permission profiles, Citadel Wards and tool grants still apply unchanged.
3. **Path resolution in the Gateway** (`tool-path-session-scope.ts`, `tool-path-resolution.ts`). Relative paths resolve against the workspace or project. An absolute write path, or a relative path that resolves through a link, is accepted only when it lands in the workspace, the project, the runtime write jail or an admitted operator write root. Reads and the shell working directory (`cwd`) are not widened. Delegated child sessions stay inside their approved scope.
4. **The central write gate** (`packages/policy-engine/src/sandbox/tool-write-gate.ts`). The policy engine runs it as a structural check, and the tool executor runs it again before acting:
   - writes may land in the jail or in any operator root;
   - deletes (`fs.delete`, and the source of `fs.move`) may land only in the jail or in operator roots with `allowDelete`;
   - a write root itself can never be deleted, nor any folder that contains a protected runtime path;
   - **hard-forbidden targets** are refused even inside an allowed root: system, credential and profile locations, plus the runtime config folder, `data/secrets`, `data/postgres`, the configured bundled-Postgres data dir and the audit dir;
   - operator roots are ignored entirely unless the Gateway derived runtime write protection at config load (fail closed).

Operator write roots also count as readable roots, so filesystem tools can list a folder before cleaning it.

## Example: letting Chat clean the OS temp folder

1. In Settings › Safety › Tools › Filesystem write roots, choose **Add OS temp folder** and turn on **Allow delete**.
2. In the same panel, set `fs.delete` to **Available** (danger-risk review).
3. Chat can now delete files inside the temp folder. Each delete still passes approval. Chat cannot delete the temp folder itself, and nothing outside it is affected.

## Not implemented

- A chat approval cannot open a new folder: no path-scoped write grant is minted from an approval. Typing "I approve" in Chat changes nothing. Only the governed Settings and Change Plan paths above widen write scope.
- Shell commands (`shell.exec`, `shell.exec_background`) are not limited by write roots. Their working directory is an execution context, not a write boundary; risky-shell approval and deny rules govern them.
