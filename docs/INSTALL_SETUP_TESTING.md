# GoatCitadel Install, Setup, and Testing

Last updated: 2026-03-05
Target release: `0.6.0-beta.2`

Related guides:

- [Public Share Checklist](./PUBLIC_SHARE_CHECKLIST.md)
- [Communication Channel Setup Guide](./COMMUNICATION_CHANNEL_SETUP_GUIDE.md)
- [Optional Bankr Skill](./OPTIONAL_BANKR_SKILL.md)

## Install Paths

GoatCitadel supports two valid install paths:

1. Installer-first: best for most users and public beta testers.
2. Manual/dev install: best for contributors and raw GitHub validation.

Default installer home is under your user home directory:

- base dir: `~/.GoatCitadel`
- app dir: `~/.GoatCitadel/app`
- launcher dir: `~/.GoatCitadel/bin`

The installer also places a local `pnpm` shim in the launcher directory, so GoatCitadel runtime commands do not require a separate global pnpm install after setup.

You can override the install root:

- PowerShell installer: `-InstallDir <path>`
- shell installer: `--install-dir <path>`
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

Quick checks:

```bash
git --version
node --version
corepack --version
```

## Path A: Installer-First

### Windows

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
goatcitadel verify install
goatcitadel up
goatcitadel onboard
goatcitadel doctor --deep
goatcitadel voice status
```

Short alias:

```bash
goat help
goat verify install
goat up
goat onboard
goat doctor --deep
```

PowerShell note:

- use `goatcitadel` or `goat`
- onboarding uses the live gateway API, so start with `goat up`
- do not use `gc` in PowerShell because it is the built-in alias for `Get-Content`
- if `goatcitadel` is not found immediately after install, open a new PowerShell window
- immediate fallback: `& "$HOME\\.GoatCitadel\\bin\\goatcitadel.cmd" onboard`

### Update an existing install

```bash
goatcitadel update
```

## Path B: Manual / Dev Install

```bash
git clone https://github.com/goatcitadel/GoatCitadel.git
cd GoatCitadel
corepack enable
corepack prepare pnpm@10.31.0 --activate
pnpm install --frozen-lockfile
pnpm config:sync
```

`pnpm config:sync` materializes local `config/*.json` files from the tracked `config/*.example.json` templates and rebuilds `config/goatcitadel.json` if needed.

The default clone keeps the shipped Office runtime assets in-repo. The full Office source provenance bundle is published separately so code-first contributors do not need to pull heavy source kits. See [docs/office-source-manifest.json](/f:/code/personal-ai/docs/office-source-manifest.json) and the corresponding release bundle when you need the original source assets.

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
GOATCITADEL_AUTH_TOKEN=replace-with-long-random-token
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

## Start GoatCitadel

Installed launcher path:

```bash
goatcitadel up
```

Manual repo path:

```bash
pnpm dev
```

Split terminals if needed:

```bash
pnpm dev:gateway
pnpm dev:ui
```

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
4. Confirm Dashboard, Chat, Sessions, and Tool Access load cleanly.
5. Test approvals with one intentionally risky action.
6. If you plan to use Discord or Slack, configure those after local validation is clean.

## Validation Gates

Run these before public testing or wider sharing:

```bash
pnpm typecheck
pnpm test
pnpm smoke
pnpm build
pnpm docs:check
pnpm coverage:collect
pnpm coverage:gate
```

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

## Browser Automation Prerequisite

Installer-based installs provision Playwright Chromium automatically.

If you are running from a raw source clone, install Chromium once with:

```bash
pnpm --filter @goatcitadel/policy-engine exec playwright install chromium
```

## Optional: NPU Sidecar

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

### Installed launcher exists but a command is missing

Re-run:

```bash
goatcitadel update
```

The installer now delegates directly to the repo CLI, so launcher drift should no longer happen.

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
