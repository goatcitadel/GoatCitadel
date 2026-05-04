# Mission Control Next UI Functionality Coverage Review

Date: 2026-05-04
Scope: `apps/mission-control-next` after the Claude Design convergence pass.

## Summary

The redesigned Mission Control Next shell keeps the major GoatCitadel capabilities reachable, but some controls are now intentionally behind the `+` composer menu, context drawer, route pages, or posture-specific right panels. That is the right product direction for a smaller default UI, but it creates UX risk when a lifecycle action is both common and easy to forget. The main confirmed gap in this pass was single-session archive/restore: the controller and Session drawer already supported it, but active threads had no first-class header action.

This pass adds a compact `Archive` / `Restore` action to the active thread header and keeps full session management in the context drawer.

## Coverage Matrix

| Area | Core functionality | Current visible entrypoint | Hidden or advanced entrypoint | Missing or weak affordance | Backing route/API | Priority |
| --- | --- | --- | --- | --- | --- | --- |
| Chat | Fast conversation, follow-ups, attachments, web mode, model/provider, stream stop/retry | Top posture nav, session rail, compact composer, provider/model controls, turn actions | `+` composer menu, context drawer, turn details | Chat can still feel visually sparse with no right workbench; keep the compact context rail as the default filler | Chat session APIs, threaded surface controller | Medium |
| Chat lifecycle | Archive/restore, pin, rename, folder/tags, project assignment, delete, export | New header `Archive` / `Restore`, context drawer Session tab | Session drawer for pin, rename, folder/tags, project, delete, snapshot, binding | Three-dot session menu would reduce drawer trips for rename/pin/move/export | `archiveChatSession`, `restoreChatSession`, `updateChatSession`, `pinChatSession` | High |
| Composer | Send, plan mode, attach files, prompt presets, voice, image, URL knowledge, quick web research, skill mentions | Textarea, `+`, paperclip, Plan, primary send action | `+` menu, `$` skill suggestions, contextual route controls | `+` menu should stay compact and avoid becoming a second drawer | Threaded composer + chat execution APIs | Medium |
| Inline blockers | Approvals and user-input prompts block the composer until resolved or dismissed | Inline blocking prompt near thread bottom | Global Ops approvals remain visible | Needs continued browser proof with real pending approvals and `Esc` dismissal | Approval/user-input state from threaded controller | High |
| Cowork | Task board, active run overview, blockers, delegation, retry/stop, operator actions | Cowork posture, right workflow panel, top nav task routes | Context drawer and Ops routes | Verify every long-running run state has an obvious resume/stop/retry path in the compact panel | Cowork view model, delegation/run APIs | High |
| Code | Project binding/import, worktree, editor, save/discard, diff, helper runs, artifacts | Code posture, collapsible code workbench/right editor panel | Session drawer binding and Code route actions | Needs deeper manual proof against real worktree sessions | Code workbench/view model APIs | High |
| Projects | Project list/detail, grouped Chat/Cowork/Code sessions, new session per project, posture navigation | Projects route and top nav | Session rail project filters, session drawer project assignment | Project-level create actions should stay visible without reintroducing dashboard bulk | Chat project/session APIs | Medium |
| Library | Agents, skills, memory, knowledge/files, artifacts, prompt packs | Library top route | Route-specific tabs/actions | Audit should continue for old dashboard-style pages that missed the new density rules | Library route APIs | Medium |
| Ops | Approvals, runtime, diagnostics, costs, activity, sessions | Ops top route and global status strip | Context drawer run details, Ops subroutes | Global approval visibility is preserved, but route density should be checked page by page | Ops/runtime/event APIs | High |
| Settings | Providers, integrations, channels, MCP, workspaces, access/tools/budget | Settings top route | Settings subroutes and drawers | Provider and integration setup must remain beginner-readable despite tighter chrome | Settings/runtime config APIs | High |

## Fixes Implemented In This Pass

- Added a visible active-thread lifecycle action:
  - `Archive` for active sessions.
  - `Restore` for archived sessions.
  - Pending labels become `Archiving...` or `Restoring...`.
- Reused the existing `handleToggleArchiveSession` path and existing archive/restore APIs.
- Updated the archive/restore handler so sessions that leave the current rail view clear the active selection and refresh the rail.
- Kept the Session drawer as the full management surface for rename, folder, tags, project assignment, pin, archive/restore, delete, snapshot export, and external binding.
- Added render coverage for active-session `Archive` and archived-session `Restore`.

## Follow-Up Recommendations

1. Add a compact three-dot session menu in the thread header for rename, pin, move to project, export snapshot, and delete.
2. Run a real-browser pending approval test to verify the inline blocker, global Ops visibility, and `Esc` dismissal together.
3. Do a focused Code workbench pass with a real imported project to verify editor collapse, file tree, save/discard, diff, and helper runs.
4. Audit Library/Ops/Settings for any remaining old dashboard cards that visually conflict with the Claude Design shell.
5. Add a lightweight Chat right-side context mode that makes empty chat sessions feel less barren without adding Cowork/Code complexity.
