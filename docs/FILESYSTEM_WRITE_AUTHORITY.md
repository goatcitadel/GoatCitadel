# Filesystem Write Authority

Model-driven filesystem tools can only write where the operator has allowed it. This document describes which folders those tools may write to, who can change that, and which boundaries no setting can widen.

## Where tools may write

| Scope | What it is | Who changes it |
|---|---|---|
| Runtime write jail (`sandbox.writeJailRoots`) | The runtime's own write area (defaults `./workspace`, `./data`, `./.worktrees`). Workbench, worktrees, memory exports and other runtime services also use it. | Hand-edited in `config/tool-policy.json`. Settings shows it read-only. |
| Operator write roots (`sandbox.operatorWriteRoots`) | Extra folders outside the jail that **only** model-driven filesystem, artifact and browser-output tools may write to, for example a temp folder to clean. Each folder has its own `allowDelete` flag, which is off by default. | **Settings › Safety › Tools › Filesystem write roots**, Chat's `change.request` (`operator_write_root`), or the config file. |
| Outside-root writes (`sandbox.outsideRootWriteMode`) | Whether a write outside every write root is blocked (`deny`, the default) or asks the operator (`approval_required`). See [Opening a folder from a Chat approval](#opening-a-folder-from-a-chat-approval). | **Settings › Safety › Tools › Filesystem write roots › Writes outside the write roots** (**Let Chat ask instead** is a danger-risk review), Chat's `change.request` (`outside_root_write_policy`), or the config file. |

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

1. **Deny-wins and tool availability.** A tool in `tools.deny` is refused everywhere. This includes `fs.delete` and `fs.write`, which are denied by default. Settings › Safety › Tools sets each of `fs.write`, `fs.delete`, `fs.copy`, `fs.move` and `fs.patch` to Denied, Available or Not listed (`tool_global_access`). Un-denying `fs.delete` or `fs.write` is a danger-risk change, because the tool becomes callable in **every** write root, including the runtime jail, subject to the effective approval policy.
2. **The Files tool group switch.** With the Files group switched off (`tools.disabledGroups`, changed only by the governed `tool_group_access` Settings change in Capabilities › Tools), the policy engine refuses every `fs.*` tool for the AI right after the deny set, and `tools.allow`, allow grants or a local operator override can't lift it. GoatCitadel's own deliveries skip only this check (see Tool Groups in [CANONICAL_RUNTIME_STATE_MODEL.md](./CANONICAL_RUNTIME_STATE_MODEL.md#tool-groups)). Switching the group back on lifts only the switch, never a deny from step 1. While the group is off, Settings › Safety shows a line at the top of the global filesystem tool access list saying those tool settings have no effect, with a link to the Files group in Capabilities › Tools. Only the Files tools' access is affected: write roots and the outside-root mode still apply to artifact, document, presentation and browser-output writes, which belong to other groups.
3. **Approvals and grants.** Approval rules, permission profiles, Citadel Wards and tool grants still apply unchanged.
4. **Path resolution in the Gateway** (`tool-path-session-scope.ts`, `tool-path-resolution.ts`). For the write tools it maps (`fs.write`, `fs.patch`, `fs.delete`, `fs.move`, the destination of `fs.copy`, artifact, document and presentation creation, browser screenshot/interact outputs, and `git.worktree.create`/`remove`), relative paths resolve against the workspace or project. For artifact, document and presentation creation and browser outputs only, an output path that already starts with the workspace folder name is not nested a second time. An absolute write path, or a relative path that resolves through a link, is accepted only when it lands in the workspace, the project, the runtime write jail or an admitted operator write root. The one exception: with `outsideRootWriteMode` set to `approval_required`, an ordinary (non-delegated) session's absolute write target outside every root is passed on for the policy engine to decide, for `fs.write`, `fs.patch`, the destination of `fs.copy` and `fs.move`, and artifact, document, presentation and browser outputs. Relative escapes are still refused here. Reads and the shell working directory (`cwd`) are not widened. Delegated child sessions stay inside their approved scope; a delegated child without one writes only in the workspace and the runtime write jail, never in an operator write root (not even through a project folder inside one), and a failed delegation lookup refuses the request.
5. **The central write gate** (`packages/policy-engine/src/sandbox/tool-write-gate.ts`). The policy engine runs it as a structural check, and the tool executor runs it again before acting:
   - writes may land in the jail or in any operator root;
   - deletes (`fs.delete`, and the source of `fs.move`) may land only in the jail or in operator roots with `allowDelete`;
   - a write root itself can never be deleted, nor any folder that contains a protected runtime path;
   - **hard-forbidden targets** are refused even inside an allowed root: system, credential and profile locations, plus the runtime config folder, `data/secrets`, `data/postgres`, the configured bundled-Postgres data dir, the audit dir, and the SQLite database file with its `-wal`, `-shm` and `-journal` sidecars;
   - operator roots are ignored entirely unless the Gateway derived runtime write protection at config load (fail closed);
   - a target outside every root is refused unless the policy engine admitted it for this exact call, from a Chat approval or a folder grant (below).

Operator write roots also count as readable roots, so filesystem tools can list a folder before cleaning it.

## Example: letting Chat clean the OS temp folder

1. In Settings › Safety › Tools › Filesystem write roots, choose **Add OS temp folder** and turn on **Allow delete**.
2. In the same panel, set `fs.delete` to **Available** (danger-risk review).
3. Chat can now delete files inside the temp folder. Deletes still go through the effective approval policy: under the default approval modes each delete asks first, but a `bypass` approval mode or a matching allow grant skips that prompt. Chat cannot delete the temp folder itself. Making `fs.delete` available is global, though: deletes also become possible in the runtime write jail and in any other operator write root with `allowDelete`, under the same approval policy.

## Opening a folder from a Chat approval

Off by default. After **Let Chat ask instead** under **Writes outside the write roots** (`outsideRootWriteMode: "approval_required"`), a Chat write that lands outside every write root raises an approval instead of failing. The approval card offers:

- **Approve once** admits that one exact write, once. The policy engine checks the retried call against the targets it recorded when it raised the approval.
- **Approve and open folder**, only when the Gateway can offer a safe folder, also opens one folder for a limited time. The Gateway offers up to three folders: the closest existing folder above the target and up to two of its parents, keeping only those that pass the same safety rules as an operator write root. When none pass (for example a target directly inside a user profile or at a drive root), the card offers only **Approve once**. You pick one folder, a duration (15 minutes, 1 hour by default, or 8 hours) and a scope (**This chat** or **This workspace**).

An opened folder is an expiring `ttl` tool grant whose `writeRoots` constraint holds the folder:

- it covers only the approved tool, in the chosen chat or workspace;
- it is minted only from an approved outside-root approval, at most once per approval, within 15 minutes of the approval, with a lifetime from the database clock and never longer than 24 hours;
- the client sends only the server-issued folder id (`owr_…`), never a path, and the Gateway re-checks it against the approval;
- at every use, the folder is checked again and ignored if it no longer resolves to the same place (for example a swapped junction).

While it lasts, that tool's writes inside the folder run without asking again, unless another rule still requires approval (for example a Citadel Ward). Settings › Safety › Tools lists the grant, shows its folder and the approval it came from, and can revoke it. **Block outside-root writes** sets the mode back to `deny` and makes every open folder inert at once.

These stay blocked whatever the mode, approval or grant:

- deletes outside the write roots, including the source of `fs.move`;
- the hard-forbidden targets listed above;
- network shares and UNC paths, device namespaces, reserved device names, alternate data streams and unexpanded short names;
- writes from delegated child sessions, A2A peers and mesh nodes.

`bypass` approval mode, a pre-approved Code Mode run and an allow grant without `writeRoots` never clear the outside-root prompt. Deny-wins rules and Citadel Wards still apply first.

## Not implemented

- Typing "I approve" in Chat changes nothing. Only the approval card, the governed Settings path and Change Plans widen write scope.
- Shell commands (`shell.exec`, `shell.exec_background`) are not limited by write roots. Their working directory is an execution context, not a write boundary; risky-shell approval and deny rules govern them.
