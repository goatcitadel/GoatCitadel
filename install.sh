#!/usr/bin/env bash
set -euo pipefail

REPO_URL="https://github.com/goatcitadel/GoatCitadel.git"
BASE_DIR="${HOME}/.GoatCitadel"
APP_DIR="${BASE_DIR}/app"
BIN_DIR="${BASE_DIR}/bin"
INSTALL_METHOD="git"
NO_PATH_UPDATE="0"
SKIP_VOICE="0"
VOICE_MODEL="base.en"
PNPM_VERSION="10.31.0"
WORKSPACE_RUNTIME_BUILD_PACKAGES=(
  "@goatcitadel/contracts"
  "@goatcitadel/extensions-sdk"
  "@goatcitadel/memory-core"
  "@goatcitadel/storage"
  "@goatcitadel/gateway-core"
  "@goatcitadel/mesh-core"
  "@goatcitadel/orchestration"
  "@goatcitadel/skills"
  "@goatcitadel/policy-engine"
)
MANAGED_LOCAL_CONFIG_PATHS=(
  "config/assistant.config.json"
  "config/tool-policy.json"
  "config/budgets.json"
  "config/llm-providers.json"
  "config/cron-jobs.json"
  "config/goatcitadel.json"
  "config/private-beta.profile.json"
)
PRESERVED_MANAGED_CONFIG_DIR=""
PRESERVED_MANAGED_CONFIG_PATHS=()

print_help() {
  cat <<'EOF'
GoatCitadel installer

Usage:
  install.sh [options]

Options:
  --repo <url>              Repository URL (default: https://github.com/goatcitadel/GoatCitadel.git)
  --install-dir <path>      Base install directory (default: ~/.GoatCitadel)
  --install-method <name>   Install method (supported: git)
  --no-path-update          Do not modify shell profile PATH
  --skip-voice              Skip managed local voice runtime install
  --voice-model <modelId>   Managed starter voice model (default: base.en)
  --help                    Show this help

Examples:
  curl -fsSL https://raw.githubusercontent.com/goatcitadel/GoatCitadel/main/install.sh | bash
  curl -fsSL https://raw.githubusercontent.com/goatcitadel/GoatCitadel/main/install.sh | bash -s -- --install-method git
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo)
      REPO_URL="${2:-}"
      shift 2
      ;;
    --install-dir)
      BASE_DIR="${2:-}"
      APP_DIR="${BASE_DIR}/app"
      BIN_DIR="${BASE_DIR}/bin"
      shift 2
      ;;
    --install-method)
      INSTALL_METHOD="${2:-}"
      shift 2
      ;;
    --no-path-update)
      NO_PATH_UPDATE="1"
      shift
      ;;
    --skip-voice)
      SKIP_VOICE="1"
      shift
      ;;
    --voice-model)
      VOICE_MODEL="${2:-}"
      shift 2
      ;;
    --help|-h)
      print_help
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      print_help
      exit 1
      ;;
  esac
done

if [[ "${INSTALL_METHOD}" != "git" ]]; then
  echo "Unsupported --install-method '${INSTALL_METHOD}'. Only 'git' is currently supported." >&2
  exit 1
fi

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1" >&2
    exit 1
  fi
}

announce_install_step() {
  local title="$1"
  local what="$2"
  local why="$3"
  echo "${title}"
  echo "  What: ${what}"
  echo "  Why: ${why}"
}

install_workspace_dependencies() {
  announce_install_step \
    "Installing workspace dependencies..." \
    "GoatCitadel's local package graph and command shims under node_modules/.bin" \
    "GoatCitadel build, doctor, and verification commands depend on local tools like tsc, tsx, vitest, and other workspace executables."
  if pnpm --dir "${APP_DIR}" install --frozen-lockfile; then
    return 0
  fi
  echo "Frozen-lockfile install failed. GoatCitadel will retry with --no-frozen-lockfile so it can refresh lock metadata and restore the local toolchain if manifests moved ahead of pnpm-lock.yaml." >&2
  pnpm --dir "${APP_DIR}" install --no-frozen-lockfile
}

is_managed_mutable_path() {
  local path="$1"
  for managed in "${MANAGED_LOCAL_CONFIG_PATHS[@]}"; do
    if [[ "${managed}" == "${path}" ]]; then
      return 0
    fi
  done
  return 1
}

preserve_managed_config_for_update() {
  mapfile -t dirty_paths < <(git -C "${APP_DIR}" status --porcelain --untracked-files=no | awk 'NF { print substr($0, 4) }')

  local unexpected=()
  local path
  for path in "${dirty_paths[@]}"; do
    if ! is_managed_mutable_path "${path}"; then
      unexpected+=("${path}")
    fi
  done
  if [[ "${#unexpected[@]}" -gt 0 ]]; then
    echo "Update blocked because the installed checkout has non-config tracked changes: ${unexpected[*]}" >&2
    exit 1
  fi

  local existing_paths=()
  for path in "${MANAGED_LOCAL_CONFIG_PATHS[@]}"; do
    if [[ -f "${APP_DIR}/${path}" ]]; then
      existing_paths+=("${path}")
    fi
  done
  if [[ "${#existing_paths[@]}" -eq 0 ]]; then
    return 0
  fi

  PRESERVED_MANAGED_CONFIG_DIR="$(mktemp -d "${TMPDIR:-/tmp}/goatcitadel-update.XXXXXX")"
  PRESERVED_MANAGED_CONFIG_PATHS=("${existing_paths[@]}")
  for path in "${existing_paths[@]}"; do
    mkdir -p "${PRESERVED_MANAGED_CONFIG_DIR}/$(dirname "${path}")"
    cp "${APP_DIR}/${path}" "${PRESERVED_MANAGED_CONFIG_DIR}/${path}"
  done
  for path in "${dirty_paths[@]}"; do
    git -C "${APP_DIR}" restore --source=HEAD -- "${path}"
  done
}

restore_preserved_managed_config() {
  if [[ -z "${PRESERVED_MANAGED_CONFIG_DIR}" ]]; then
    return 0
  fi
  local path
  for path in "${PRESERVED_MANAGED_CONFIG_PATHS[@]}"; do
    mkdir -p "${APP_DIR}/$(dirname "${path}")"
    cp "${PRESERVED_MANAGED_CONFIG_DIR}/${path}" "${APP_DIR}/${path}"
  done
}

require_cmd git
require_cmd node
require_cmd corepack
COREPACK_BIN="$(command -v corepack)"

mkdir -p "${BASE_DIR}" "${BIN_DIR}"

if [[ -d "${APP_DIR}/.git" ]]; then
  echo "Updating existing GoatCitadel install in ${APP_DIR}..."
  git -C "${APP_DIR}" fetch --all --prune
  preserve_managed_config_for_update
  git -C "${APP_DIR}" pull --ff-only
  restore_preserved_managed_config
else
  if [[ -d "${APP_DIR}" ]]; then
    echo "Removing non-git directory at ${APP_DIR}..."
    rm -rf "${APP_DIR}"
  fi
  echo "Cloning GoatCitadel from ${REPO_URL}..."
  git clone "${REPO_URL}" "${APP_DIR}"
fi

announce_install_step \
  "Preparing pnpm (${PNPM_VERSION})..." \
  "the managed pnpm launcher for GoatCitadel's workspace" \
  "GoatCitadel uses pnpm to materialize local package binaries and run workspace build, doctor, and verification commands."
corepack enable >/dev/null 2>&1 || true
corepack prepare "pnpm@${PNPM_VERSION}" --activate

install_workspace_dependencies
for workspace_package in "${WORKSPACE_RUNTIME_BUILD_PACKAGES[@]}"; do
  echo "Building runtime package ${workspace_package}..."
  pnpm --dir "${APP_DIR}" --filter "${workspace_package}" build
done
echo "Materializing local config from tracked examples..."
pnpm --dir "${APP_DIR}" config:sync
if [[ -f "${APP_DIR}/config/private-beta.profile.example.json" && ! -f "${APP_DIR}/config/private-beta.profile.json" ]]; then
  cp "${APP_DIR}/config/private-beta.profile.example.json" "${APP_DIR}/config/private-beta.profile.json"
fi
announce_install_step \
  "Installing Playwright Chromium runtime..." \
  "the managed Chromium browser used by GoatCitadel browser automation" \
  "Browser tools, screenshot capture, and Playwright-backed verification flows need a local browser runtime to run safely and predictably."
pnpm --dir "${APP_DIR}" --filter "@goatcitadel/policy-engine" exec playwright install chromium
if [[ "${SKIP_VOICE}" != "1" ]]; then
  announce_install_step \
    "Installing managed local voice runtime (${VOICE_MODEL})..." \
    "the managed local whisper.cpp voice runtime" \
    "Voice transcription and local speech features need a downloaded runtime before GoatCitadel can use them."
  if ! pnpm --dir "${APP_DIR}" --filter "@goatcitadel/gateway" run voice:runtime install --model "${VOICE_MODEL}"; then
    echo "Managed voice runtime install failed. Core GoatCitadel install is complete. Repair later with 'goatcitadel voice install'." >&2
  fi
fi

cat > "${BIN_DIR}/goatcitadel" <<EOF
#!/usr/bin/env bash
set -euo pipefail
export GOATCITADEL_HOME="${BASE_DIR}"
export PATH="${BIN_DIR}:\$PATH"
exec node "${APP_DIR}/bin/goatcitadel.mjs" "\$@"
EOF

chmod +x "${BIN_DIR}/goatcitadel"
cp "${BIN_DIR}/goatcitadel" "${BIN_DIR}/goat"
chmod +x "${BIN_DIR}/goat"
cat > "${BIN_DIR}/pnpm" <<EOF
#!/usr/bin/env bash
set -euo pipefail
exec "${COREPACK_BIN}" pnpm "\$@"
EOF
chmod +x "${BIN_DIR}/pnpm"
rm -f "${BIN_DIR}/gc"

if [[ "${NO_PATH_UPDATE}" == "0" ]]; then
  SHELL_NAME="$(basename "${SHELL:-}")"
  PROFILE_FILE=""
  if [[ "${SHELL_NAME}" == "zsh" ]]; then
    PROFILE_FILE="${HOME}/.zshrc"
  elif [[ "${SHELL_NAME}" == "bash" ]]; then
    PROFILE_FILE="${HOME}/.bashrc"
  else
    PROFILE_FILE="${HOME}/.profile"
  fi

  PATH_LINE="export PATH=\"${BIN_DIR}:\$PATH\""
  if [[ -f "${PROFILE_FILE}" ]]; then
    if ! grep -F "${BIN_DIR}" "${PROFILE_FILE}" >/dev/null 2>&1; then
      printf "\n# GoatCitadel\n%s\n" "${PATH_LINE}" >> "${PROFILE_FILE}"
    fi
  else
    printf "# GoatCitadel\n%s\n" "${PATH_LINE}" > "${PROFILE_FILE}"
  fi
fi

echo ""
echo "GoatCitadel install complete."
echo "Install directory: ${APP_DIR}"
echo "Launcher: ${BIN_DIR}/goatcitadel"
echo ""
echo "Run:"
echo "  ${BIN_DIR}/goatcitadel verify install"
echo "  ${BIN_DIR}/goatcitadel up"
echo "  ${BIN_DIR}/goatcitadel onboard"
echo "  ${BIN_DIR}/goatcitadel doctor --deep"
echo "  ${BIN_DIR}/goatcitadel voice status"
echo "  ${BIN_DIR}/goat verify install"
echo "  ${BIN_DIR}/goat up"
echo "  ${BIN_DIR}/goat onboard"
echo "  ${BIN_DIR}/goat doctor --deep"
echo "  ${BIN_DIR}/goat voice status"
echo "  Managed GoatCitadel config is preserved across installer updates."
