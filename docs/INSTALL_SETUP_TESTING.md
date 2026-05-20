# GoatCitadel Install, Setup, and Testing

Last updated: 2026-04-24
Target release: `1.0.0`

Related guides:

- [Communication Channel Setup Guide](./COMMUNICATION_CHANNEL_SETUP_GUIDE.md)
- [Plugin SDK Contract](./PLUGIN_SDK_CONTRACT.md)

## Install Paths

GoatCitadel supports three valid install paths:

1. Packaged Windows installer: best for most Windows users and standard 1.0 deployments when using release `.exe` assets.
2. Source bootstrap/manual install: best for contributors, raw GitHub validation, and users running `install.ps1` / `install.sh` from the repo.
3. Docker/Compose: best for a safer single-host or shared-host runtime boundary.

Default local install home is under your user home directory:

- base dir: `~/.GoatCitadel`
- app dir: `~/.GoatCitadel/app`
- launcher dir: `~/.GoatCitadel/bin`

The packaged Windows `.exe` installer also installs the native Mission Control desktop host. Start Menu and desktop shortcuts open the desktop host by default; the host starts the same gateway and web Mission Control runtime behind the scenes and keeps it warm while the app is open. The PowerShell source bootstrap below installs command launchers for a repo checkout; it does not create packaged desktop shortcuts.

The installer-safe launcher surface is the packaged runtime surface: `help`, `status`, `launch`, `up`, `stop`, and `uninstall`. Source-tree commands that shell out to workspace tooling, such as deep verification lanes, require a raw clone with `pnpm install` unless a release note explicitly says that command has been packaged.

When GoatCitadel installs or repairs local tooling for you, it should describe:

- what it is installing
- why that component is needed

Current first-party repair/install flows cover local workspace dependencies, Playwright Chromium, and the managed voice runtime.

You can override the install root:

- PowerShell source bootstrap: `-InstallDir <path>`
- shell source bootstrap: `--install-dir <path>`
- CLI install/update path: `goatcitadel install --install-dir <path>` or `goatcitadel update --install-dir <path>`
- environment fallback: `GOATCITADEL_HOME=<path>`

## Prerequisites

Required:

- Git
- Node.js 22+
- Corepack

Optional:

- Python 3.10+ for the local NPU sidecar
- Playwright Chromium if you plan to use browser automation or refresh screenshots from a raw source clone
- Docker Engine with Compose if you want the containerized deployment path

Quick checks:

```bash
git --version
node --version
corepack --version
```

## Path A: Source Bootstrap

### Windows

The commands below run the source bootstrap script. They clone or update GoatCitadel and add command launchers; they are not the packaged Windows `.exe` installer path.

Safer download-and-run flow:

```powershell
iwr https://raw.githubusercontent.com/goatcitadel/GoatCitadel/main/install.ps1 -OutFile install.ps1
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

Power-user one-liner:

```powershell
iwr -useb https://raw.githubusercontent.com/goatcitadel/GoatCitadel/main/install.ps1 | iex
```

Custom install root:

```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1 -InstallDir "$HOME\\.GoatCitadel"
```

Skip the managed local voice runtime:

```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1 -SkipVoice
```

Shell guidance:

- On Windows, prefer PowerShell for install, doctor, update, and launcher commands.
- Bash commands in this repo are intended for macOS, Linux, or Windows setups with WSL/Git Bash configured correctly.
- If `bash` opens into a Linux home directory or cannot see your repo path, stay on the PowerShell path instead of mixing shells.
- GoatCitadel should only ask Windows users to install or repair tooling through PowerShell unless the user is explicitly running under WSL or a working bash-compatible shell.

### macOS / Linux

Safer download-and-run flow:

```bash
curl -fsSL https://raw.githubusercontent.com/goatcitadel/GoatCitadel/main/install.sh -o install.sh
bash install.sh
```

Power-user one-liner:

```bash
curl -fsSL https://raw.githubusercontent.com/goatcitadel/GoatCitadel/main/install.sh | bash
```

Custom install root:

```bash
bash install.sh --install-dir "$HOME/.GoatCitadel"
```

Choose a different starter voice model:

```bash
bash install.sh --voice-model small.en
```

### Verify the installed launcher

```bash
goatcitadel help
goatcitadel status --json
goatcitadel launch --no-open --json --wait
goatcitadel up
goatcitadel stop --json
goatcitadel uninstall --force
```

Short alias:

```bash
goat help
goat up
goat uninstall --force
```

PowerShell note:

- use `goatcitadel` or `goat`
- onboarding uses the live gateway API, so start with `goat up`
- packaged Windows installer shortcuts open the desktop app by default, but source bootstrap launchers use `goatcitadel launch` to open Mission Control in the browser
- run `pnpm verify:install`, `pnpm verify:desktop`, or `goatcitadel doctor --deep` from a source checkout unless the installed release explicitly advertises those as packaged commands
- GoatCitadel does not install `gc` because PowerShell already uses it as the built-in alias for `Get-Content`
- if `goatcitadel` is not found immediately after install, open a new PowerShell window
- immediate fallback: `& "$HOME\\.GoatCitadel\\bin\\goatcitadel.cmd" onboard`

### Update an existing install

```bash
goatcitadel update
```

### Remove an install completely

Interactive:

```bash
goatcitadel uninstall
```

Non-interactive:

```bash
goatcitadel uninstall --force
```

Short alias:

```bash
goat uninstall --force
```

Notes:

- uninstall removes the configured GoatCitadel base directory, including `app`, `bin`, tools, and local runtime data
- it also removes the launcher PATH registration added by the source bootstrap
- open a new shell after uninstall so PATH changes take effect

## Path B: Manual / Dev Install

Windows contributors can run these repo commands from PowerShell. Use bash only if your shell is already WSL-backed or your Git Bash path translation is working for the repo checkout.

```bash
git clone https://github.com/goatcitadel/GoatCitadel.git
cd GoatCitadel
corepack enable
corepack prepare pnpm@10.31.0 --activate
pnpm install --frozen-lockfile
pnpm config:sync
```

`pnpm config:sync` materializes local `config/*.json` files from the tracked `config/*.example.json` templates and rebuilds `config/goatcitadel.json` if needed.

The default clone keeps the shipped Office runtime assets in-repo. The full Office source provenance bundle is published separately so code-first contributors do not need to pull heavy source kits. See [office-source-manifest.json](./office-source-manifest.json) when you need the original source asset manifest.

### Manual path commands

Use repo scripts directly from a clone:

```bash
pnpm verify:install
pnpm dev
pnpm doctor:deep
pnpm onboarding:tui
```

Notes:

- `pnpm verify:install` boots an isolated temporary gateway + Mission Control stack on open ports, so it works even if another GoatCitadel session is already running.
- `pnpm doctor:deep` is the repo-script form of doctor and avoids pnpm's built-in `doctor` command collision.
- `pnpm doctor:deep` is most useful after you already have GoatCitadel running.

Do not assume the `goatcitadel` launcher exists in a raw clone unless you installed it separately.

## Path C: Docker / Compose

This is the recommended first-party path when you want a stronger runtime boundary than a raw host install, especially for shared-host or remote-access setups.

Important posture notes:

- Docker is an extra isolation layer, not a claim of complete hostile-code sandboxing.
- Keep GoatCitadel auth enabled for any non-loopback deployment.
- The primary compose path uses Postgres by default.

Primary stack:

```powershell
pnpm secrets:docker | Tee-Object -FilePath .env
docker compose up --build
```

The source and packaged launcher can generate the same `.env` content:

```powershell
goatcitadel secrets generate --docker-env | Tee-Object -FilePath .env
docker compose up --build
```

Default endpoints:

- Mission Control: `http://localhost:4173`
- Gateway health: `http://127.0.0.1:8787/health`

The compose file publishes ports on `127.0.0.1` by default. Set `GOATCITADEL_DOCKER_BIND_IP` only when you intentionally want another host/interface to reach the stack.

Set these to generated, non-placeholder values before the stack starts:

- `GOATCITADEL_AUTH_TOKEN`
- `GOATCITADEL_POSTGRES_PASSWORD`
- `GOATCITADEL_ALLOWED_ORIGINS`

The compose file already enables:

- token auth by default
- dedicated Postgres service healthchecks
- non-root container runtime
- dropped Linux capabilities and `no-new-privileges`

### Hostname and browser allowlists

Mission Control is served from a built Vite preview image. If you want to use a non-local hostname, set these at build time and rebuild:

```bash
node scripts/generate-docker-secrets.mjs --docker-env > .env
GOATCITADEL_VITE_ALLOWED_HOSTS=your-host.example \
VITE_GATEWAY_ALLOWED_HOSTS=your-host.example \
docker compose up --build
```

For Tailnet-style hosts, the shipped frontend defaults already allow `.ts.net`.

### SQLite fallback

SQLite remains supported, but it is now a fallback rather than the default recommendation.

To switch the container stack to SQLite, remove the `postgres` service and set:

```env
GOATCITADEL_DATABASE_DRIVER=sqlite
GOATCITADEL_BUNDLED_POSTGRES_ENABLED=false
```

Keep the GoatCitadel `data/` volume mounted so `data/index.db` persists across restarts.

## Configure Providers and Auth

Tracked repo config now ships as templates:

- tracked: `config/*.example.json`
- local runtime copies: `config/*.json`

Fresh installs and raw clones materialize the local runtime copies during setup via `goatcitadel install`, `goatcitadel update`, or `pnpm config:sync`.

Create a local env file for repo-based development or to simplify provider setup:

```bash
cp .env.example .env
```

Windows:

```powershell
Copy-Item .env.example .env -Force
```

At minimum, set one model provider key if you plan to use cloud models:

```env
OPENAI_API_KEY=your_key_here
GLM_API_KEY=your_key_here
MOONSHOT_API_KEY=your_key_here
```

Truth-in-testing notes:

- if secure-store persistence is disabled or unavailable, onboarding and provider bootstrap flows may persist provider secrets into the local `.env` file
- Code Mode v1 is for trusted, operator-governed code only; it is not a hostile-code sandbox claim
- host isolation is best-effort by platform and fails closed only when Code Mode is configured to require it

## Managed Local Voice Runtime

- GoatCitadel installs a managed local whisper.cpp runtime by default unless you pass `--skip-voice`.
- The default starter model is `base.en`.
- Models are downloaded on demand into `~/.GoatCitadel/tools/voice/` and are not committed to the repo.
- Ongoing model management:

```bash
goatcitadel voice status
goatcitadel voice models
goatcitadel voice install --model base.en
goatcitadel voice select small.en
```

Advanced manual overrides still exist for custom whisper setups:

```env
GOATCITADEL_WHISPER_CPP_BIN=
GOATCITADEL_WHISPER_CPP_MODEL_PATH=
GOATCITADEL_WHISPER_CPP_ARGS=
GOATCITADEL_FFMPEG_BIN=
```

### Recommended remote / shared-host posture

If you expose GoatCitadel beyond loopback, set these explicitly:

```env
GATEWAY_HOST=0.0.0.0
GATEWAY_PORT=8787
GOATCITADEL_AUTH_MODE=token
GOATCITADEL_AUTH_TOKEN=<value from goatcitadel secrets generate --docker-env>
GOATCITADEL_WARN_UNAUTH_NON_LOOPBACK=true
GOATCITADEL_ALLOWED_ORIGINS=http://localhost:5173,http://127.0.0.1:5173
GOATCITADEL_VITE_ALLOWED_HOSTS=localhost,127.0.0.1
VITE_GATEWAY_ALLOWED_HOSTS=localhost,127.0.0.1
```

Important:

- non-loopback with weak/no auth is blocked by default
- `GOATCITADEL_ALLOW_UNAUTH_NETWORK=1` is break-glass only
- `GOATCITADEL_ALLOW_REMOTE_APPROVAL_CREATE=1` is break-glass only
- `GOATCITADEL_WARN_UNAUTH_NON_LOOPBACK=false` only suppresses warnings; it does not make the deployment safer
- for the Docker preview image, custom Mission Control host allowlists must be present at image build time, not just container runtime

## Start GoatCitadel

Installed launcher path:

```bash
goatcitadel up
```

Manual repo path:

```bash
pnpm dev
```

`pnpm dev` starts the gateway plus `@goatcitadel/mission-control-next` by default.

Split terminals if needed:

```bash
pnpm dev:gateway
pnpm dev:ui
```

Use `pnpm dev:ui:legacy` when you intentionally want the older `@goatcitadel/mission-control` shell.

Default local endpoints:

- Mission Control: `http://localhost:5173`
- Gateway health: `http://127.0.0.1:8787/health`

Expected health response:

```json
{"status":"ok"}
```

## First-Run Checklist

1. Run doctor.
2. Complete onboarding.
3. Set your active provider and model in Settings.
4. Confirm Chat, Cowork, Code, Projects, Library, Ops, and Settings load cleanly.
5. Test approvals with one intentionally risky action.
6. If you plan to use Discord or Slack, configure those after local validation is clean.

## Validation Gates

Run these before public testing or wider sharing:

```bash
pnpm verify:fast
pnpm coverage:collect
pnpm coverage:gate:production
pnpm --filter @goatcitadel/storage test:postgres
```

For a quicker local smoke subset while iterating, use:

```bash
pnpm verify:repo:hygiene
pnpm verify:storage:migration-parity
pnpm --filter @goatcitadel/extensions-sdk build
pnpm typecheck
pnpm test
pnpm smoke
pnpm build
pnpm coverage:collect
pnpm coverage:gate
```

### External Tester Matrix

Use this matrix when handing the repo to external manual testers:

| Flow | Required setup | Expected proof |
| --- | --- | --- |
| Desktop host | Windows installer or `pnpm desktop:dev` from source | native window loads Mission Control, close-to-tray keeps runtime warm, Open in Browser and logs actions work |
| Installer bootstrap | Installed launcher smoke (`goatcitadel status --json`, `goatcitadel launch --no-open --json --wait`, `goatcitadel stop --json`) or source `pnpm verify:install` | packaged launcher starts/stops the local runtime; source lane proves isolated gateway/UI bootstrap and provider bootstrap behavior |
| Onboarding + shell routes | `goatcitadel up`, then complete onboarding | Chat, Cowork, Code, Projects, Library, Ops, and Settings load without auth/origin errors |
| Chat command flow | any started stack, one session | `/help` or another local command path returns a stable thread/update result without requiring cloud provider access |
| Approval lifecycle | one intentionally risky action or synthetic approval | pending approval appears, resolves cleanly, replay remains inspectable |
| Code Mode v1 | `GOATCITADEL_FEATURE_CODE_MODE_V1_ENABLED=true` | run is approval-gated, sandbox metadata is visible, stdout/stderr artifacts stay bounded, candidate-save path only runs after approval |
| Candidate lifecycle | Code Mode run with `saveCandidateOnSuccess=true` | candidate detail loads, promote/revoke paths update lifecycle state without widening callable surface implicitly |

Tester reminders:

- call out when a flow required a local env secret, a break-glass flag, or an advisory unsandboxed Code Mode run
- do not describe Code Mode as safe for hostile or arbitrary third-party code
- attach the verification artifact path when reporting failures so gateway/UI logs can be traced quickly

For the current `1.0` promise, visible scope, and release gates, use [docs/1_0_CONTRACT.md](./1_0_CONTRACT.md) as the product-level source of truth.

## TUI And Operator Commands

Installed path:

```bash
goatcitadel tui
goatcitadel tools catalog
goatcitadel admin backups list
```

Manual path:

```bash
pnpm tui
pnpm tools -- catalog
pnpm admin -- backups list
```

Backup and restore operators should also know these commands:

```bash
goatcitadel admin backup create --name manual-pre-upgrade
goatcitadel admin backup verify --file <backup-file>
goatcitadel admin backup restore --file <backup-file> --confirm
```

Restore is an offline-only operation: stop any GoatCitadel gateway process serving the same runtime root before running the restore command, then restart the gateway after the command completes.

## Browser Automation Prerequisite

Installer-based installs provision Playwright Chromium automatically.

If you are running from a raw source clone, install Chromium once with:

```bash
pnpm --filter @goatcitadel/policy-engine exec playwright install chromium
```

## Optional: NPU Sidecar

The NPU sidecar is optional experimental infrastructure. It is useful for local runtime experiments, but it is not part of the current `1.0` readiness bar and should not be treated as maturity proof for local inference.

Direct run:

```bash
cd apps/npu-sidecar
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
python server.py
```

Windows activate:

```powershell
.\.venv\Scripts\Activate.ps1
```

CLI wrapper path:

```bash
goatcitadel npu
```

## Optional: Screenshot Refresh

```bash
pnpm screenshots:capture
```

Windows wrapper:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/capture-mission-control-screenshots.ps1
```

This rebuilds the screenshot gallery from a sanitized demo runtime, not your live local data.

## Troubleshooting

### UI loads but API calls fail

1. Confirm the gateway is running.
2. Check `http://127.0.0.1:8787/health`.
3. If auth is enabled, configure credentials in Mission Control Settings.

### Source launcher exists but a command is missing

Re-run:

```bash
goatcitadel update
```

The source bootstrap launcher now delegates directly to the repo CLI, so launcher drift should no longer happen.

### Port 8787 or 5173 is already in use

Stop the conflicting process and restart GoatCitadel.

Windows example for `8787`:

```powershell
$pid = Get-NetTCPConnection -LocalPort 8787 -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -First 1
if ($pid) { Stop-Process -Id $pid -Force }
```

### Provider configured but chat still fails

1. Verify the base URL is OpenAI-compatible.
2. Verify the configured model exists for that provider.
3. Verify the API key exists in the current shell or env file.

### Shared deployment warning

If Mission Control is reachable on LAN, Tailnet, or the public internet, do not run with `GOATCITADEL_AUTH_MODE=none`.
