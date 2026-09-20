# Windows daily installation and updates

The native Windows host owns update checks, preferences, notifications, and downloads. It can check GitHub from the tray or startup recovery screen even when the Gateway cannot start. Settings → General contains the same controls; the shell shows an update badge.

## Channels and installation

- **Preview** discovers complete unsigned Windows prereleases from successful main builds. This is the first daily-use rollout.
- **Stable** requires published stable releases with authenticated release certificates from the existing protected signed-release workflow. Until one qualifies, the app says **No stable release available.**
- Checks run on startup and every 30 minutes, and can be requested manually. Successful results use GitHub ETags; rate-limit backoff and notification snoozing persist across restarts.
- **Remind me tomorrow** suppresses notifications for 24 hours, including newer previews. The Settings panel remains available.
- Downloads require a click. The host checks architecture, fixed GitHub asset locations, size, and SHA-256, then stores the installer under the installation's runtime/updates directory. Show installer rechecks its bytes.
- Checksum verification and signed release evidence are separate signals. An unsigned Preview has no publisher-signing claim. Windows notification registration is optional; the host falls back to an in-app message.
- The app never executes an installer or restarts automatically. Close it and run the verified installer yourself when ready. Integrated installation remains deferred until protected signing and upgrade acceptance are proven.

Preferences live at `<installation>/runtime/updates/preferences.json`. The native bridge accepts a fixed set of requests only from the exact installed Mission Control origin; renderer-provided URLs, file paths, and installer execution requests are rejected.

## Preview publishing

The workflow .github/workflows/desktop-preview.yml is separate from the signed release workflow. It runs after a successful main-push **Verification Fast** run, rechecks the workflow identity and exact commit, and rejects a commit superseded on main before publication.

Both Windows x64 and ARM64 must pass verify:desktop, build using the existing host/bundle/installer scripts, and pass the existing unsigned installer lifecycle smoke. Build jobs have read-only repository permissions. The publication job validates both architectures and their exact-commit manifests before creating a visible release.

Each run creates:

- version `0.1.0-preview.<buildSequence>.0`, where buildSequence = workflow run ID × 1000 + attempt
- unique prerelease tag `preview-<run ID>-<attempt>`
- both installers and adjacent SHA-256 sidecars
- release notes with source commit and proof-run links
- desktop-update.json, schema version 1, binding the commit, sequence, channel, architecture, installer sizes and hashes

Assets are uploaded to a draft. Publication occurs only after all expected assets are present with matching sizes. Reruns use a new tag; the workflow never overwrites an existing release. Repository administrators should enable GitHub immutable releases and protect the preview tags against manual replacement. Unsigned Preview metadata is not cryptographic publisher identity.

The signed producer and its protected environment, signing credentials, and exact-SHA release certificate requirements are unchanged. Stable discovery authenticates that existing certificate with the packaged, pinned Sigstore verifier without starting the Gateway.

## Preparing a daily profile

Keep the development checkout separate from %LOCALAPPDATA%\GoatCitadel. Target managed ports are Gateway **8788**, Mission Control **5175**, and bundled PostgreSQL **45433**.

Persist Gateway/UI settings at `<installation>/runtime/launcher-settings.json`:

~~~json
{ "schemaVersion": 1, "gatewayPort": 8788, "uiPort": 5175 }
~~~

The launcher honors the profile's database configuration, passes its actual Gateway origin into the packaged UI, and refuses an occupied port owned by another runtime. Explicit external-runtime URL overrides retain their existing attachment semantics.

Use scripts/packaging/windows-daily-profile.mjs after building the Gateway. The tool supports the standard local bundled PostgreSQL layout and the older standard SQLite profile. It fails on linked profile paths, custom data layouts, pending config transactions, shared destination paths, existing destinations, and unsupported newer schemas.

~~~powershell
node scripts/packaging/windows-daily-profile.mjs backup --source 'F:\code\personal-ai' --output '<independent backup directory>\development.backup' --pg-bin 'C:\Program Files\PostgreSQL\16\bin'
node scripts/packaging/windows-daily-profile.mjs backup --source "$env:LOCALAPPDATA\GoatCitadel\runtime-root" --output '<independent backup directory>\installed-sqlite.backup'
node scripts/packaging/windows-daily-profile.mjs verify --backup '<independent backup directory>\development.backup'
node scripts/packaging/windows-daily-profile.mjs restore --backup '<independent backup directory>\development.backup' --profile '<new empty staging directory>' --pg-bin 'C:\Program Files\PostgreSQL\16\bin' --port 45433
~~~

PostgreSQL backups use an exported consistent snapshot; SQLite uses the online backup API and an integrity check. Every copied payload file is hashed and verified. Configuration, local secret files, skills, workspace content and metadata are included. Database directories, caches, process logs, node_modules and Git internals are excluded. Keychain credentials stay in the same Windows user's secure store.

Restore checks the compiled application's migration registry, creates a new independent PostgreSQL cluster, restores the dump, compares record counts, disables copied schedules and integrations, publishes configuration through the existing generation owner, and stops its own temporary database process. The original profile is never written. A .daily-profile-pending-review marker prevents the packaged launcher from starting an unreviewed copy.

Backups taken while development is running are preparation snapshots. Before final cutover, coordinate a maintenance window and take a fresh snapshot so subsequent development changes are not lost. Review daily-migration-review.json, credential references, copied unfinished runs, workspace/output paths, and ownership of schedules. Do not start two copies of an active integration or schedule.

After that review, stop only the owned installed processes, retain the old runtime-root separately, promote the prepared profile, persist the managed ports, remove the review marker, and bootstrap the first updater-capable installer manually. Select Preview explicitly. Verify fresh launch, Gateway readiness, history, settings, credential access, and a real chat before enabling selected schedules/integrations in the daily copy. Keep development's corresponding automation disabled while daily owns it.

Application transaction recovery and preserved data are not a database downgrade mechanism. Restoring a prior app does not reverse forward database migrations.

## Acceptance evidence

Required focused checks include Windows host tests, updater policy/download failure tests, launcher ownership tests, UI/bridge tests, Preview manifest tests, profile-backup verification, a real PostgreSQL restore rehearsal, relevant typechecks, verify:desktop, verify:install, and browser checks.

The release acceptance journey still requires two actual clean builds: install A, publish B through passing CI, receive a notification, snooze across a restart, download, manually upgrade, and verify B plus preserved history/settings. Mock bridge UI screenshots and local unit tests do not establish that journey. Do not promote Preview or claim a live upgrade until it has been observed.
