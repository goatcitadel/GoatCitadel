# Scripts inventory

Scripts is a Cockpit navigation destination for recorded creations in the selected workspace. The Gateway owns the projection; the browser never scans files or reconstructs ownership.

## Owner audit

- Managed Files: `ManagedProjectFileRepository` owns current project heads and immutable revisions. Existing session controls, policy checks and revision checks still own reads. A matching saved tool receipt supplies source-session provenance when available; missing provenance is shown explicitly.
- Library artifacts: `ChatGeneratedArtifactRepository` owns generated content, versions and session/turn provenance. Scripts references these records and uses the existing artifact reader.
- Library Files: this browses an installation shared root, not a selected workspace. Scripts therefore includes only successful recorded `fs.write`, `artifacts.create`, `documents.create` and `presentations.create` results. It never scans that root or treats arbitrary user files as agent creations. Reads still go through the Files owner and its realpath jail. Outputs outside that root can be found through their source conversation.
- Tool outputs: `ChatToolArtifactRepository` retains tool-run/session/turn provenance; its existing reader performs path and scope checks and public redaction.
- Code Mode: `CodeModeRunRepository` owns the code artifact and run bindings. Scripts references the immutable source artifact and calls the existing hash-verifying preview. Execution, approvals and recovery are unchanged.

## Retention policy

New and existing references default to Permanent (no Scripts cleanup). Temporary is an operator label only. Neither state schedules expiration or removes anything. The API reports `expiresAt: null`, and the page says no expiration is scheduled. There is no new pruning job. Any future cleanup policy must explicitly review scope, file ownership, user-file protection and immutable evidence before it can delete content.

Labels are persisted through the existing System Settings repository under a workspace-and-reference hash. Compare-and-set versions prevent stale updates; the operator, workspace, reference and resulting version are audited. Labels do not rewrite artifacts, file revisions, execution hashes or provenance.

The bounded inventory reads up to 1,000 recent records per supported path. It does not discover arbitrary shell-created files, unrecorded external artifacts, or infer ownership from filenames. Managed heads can lack source-session provenance; their project action remains available. The UI reports these coverage limits instead of claiming a complete filesystem inventory.
