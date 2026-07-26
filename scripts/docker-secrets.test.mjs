import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  PLACEHOLDER_AUTH_TOKEN,
  validateDistinctDockerSecrets,
  validateRequiredDockerSecret,
} from "./lib/docker-secrets.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("validateRequiredDockerSecret accepts long nontrivial random-looking values", () => {
  assert.equal(
    validateRequiredDockerSecret(
      "GOATCITADEL_AUTH_TOKEN",
      "0123456789abcdefghijklmnopqrstuvwxyzABCDEFG",
      PLACEHOLDER_AUTH_TOKEN,
    ),
    null,
  );
});

test("validateRequiredDockerSecret rejects blank, placeholder, short, and trivial values", () => {
  assert.match(validateRequiredDockerSecret("GOATCITADEL_AUTH_TOKEN", "", PLACEHOLDER_AUTH_TOKEN) ?? "", /required/);
  assert.match(
    validateRequiredDockerSecret("GOATCITADEL_AUTH_TOKEN", PLACEHOLDER_AUTH_TOKEN, PLACEHOLDER_AUTH_TOKEN) ?? "",
    /placeholder/,
  );
  assert.match(
    validateRequiredDockerSecret("GOATCITADEL_AUTH_TOKEN", "short", PLACEHOLDER_AUTH_TOKEN) ?? "",
    /at least 32/,
  );
  assert.match(
    validateRequiredDockerSecret(
      "GOATCITADEL_AUTH_TOKEN",
      "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      PLACEHOLDER_AUTH_TOKEN,
    ) ?? "",
    /too weak/,
  );
});

test("validateDistinctDockerSecrets rejects reused token/password values", () => {
  const value = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFG";
  assert.match(
    validateDistinctDockerSecrets("GOATCITADEL_AUTH_TOKEN", value, "GOATCITADEL_POSTGRES_PASSWORD", value) ?? "",
    /must be different/,
  );
  assert.equal(
    validateDistinctDockerSecrets(
      "GOATCITADEL_AUTH_TOKEN",
      value,
      "GOATCITADEL_POSTGRES_PASSWORD",
      "different-0123456789abcdefghijklmnopqrstuvwxyz",
    ),
    null,
  );
});

test("Docker build context excludes local state and generated build or coverage outputs", async () => {
  const dockerignore = await readFile(path.join(repoRoot, ".dockerignore"), "utf8");
  const patterns = new Set(
    dockerignore
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#")),
  );

  assert.equal(patterns.has("target"), true, "root Rust target output must stay out of Docker build contexts");
  assert.equal(patterns.has("**/target"), true, "nested Rust target output must stay out of Docker build contexts");
  assert.equal(patterns.has(".worktrees"), true, "runtime and review worktrees must stay out of Docker build contexts");
  for (const generatedPattern of [
    "apps/*/coverage",
    "apps/*/coverage-*",
    "packages/*/coverage",
    "packages/*/coverage-*",
    "apps/*/dist",
    "packages/*/dist",
    "apps/**/bin",
    "apps/**/obj",
    "**/*.tsbuildinfo",
  ]) {
    assert.equal(
      patterns.has(generatedPattern),
      true,
      `${generatedPattern} output must stay out of Docker build contexts`,
    );
  }
  assert.equal(
    patterns.has("!config/llm-model-metadata.json"),
    true,
    "the public runtime model catalog must remain available inside clean Docker images",
  );

  const orderedPatterns = dockerignore
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
  const lastReincludeIndex = orderedPatterns.reduce(
    (latest, pattern, index) => (pattern.startsWith("!") ? index : latest),
    -1,
  );
  for (const finalPrunePattern of [".git", ".claude", ".worktrees", "node_modules", "**/node_modules", "artifacts"]) {
    assert.ok(
      orderedPatterns.lastIndexOf(finalPrunePattern) > lastReincludeIndex,
      `${finalPrunePattern} must be repeated after re-inclusions so BuildKit can prune it without traversal`,
    );
  }
});

test("Docker clean-context build compiles config-sync workspace dependencies before config materialization", async () => {
  const dockerfile = await readFile(path.join(repoRoot, "Dockerfile"), "utf8");
  const installIndex = dockerfile.indexOf("RUN pnpm install --frozen-lockfile");
  const dependencyBuildIndex = dockerfile.indexOf("RUN pnpm --filter @goatcitadel/gateway-core... build");
  const configSyncIndex = dockerfile.indexOf("RUN pnpm config:sync");
  const fullBuildIndex = dockerfile.indexOf("RUN pnpm build");

  assert.ok(installIndex >= 0, "Dockerfile must install the frozen workspace before building");
  assert.ok(
    dependencyBuildIndex > installIndex,
    "Dockerfile must compile config-sync workspace dependencies after installation",
  );
  assert.ok(
    configSyncIndex > dependencyBuildIndex,
    "Dockerfile must not run config:sync against stale or absent host dist outputs",
  );
  assert.ok(fullBuildIndex > configSyncIndex, "Dockerfile must retain the complete workspace build after config sync");
});

test("Docker runtime copy assigns non-root ownership without recursively rechowning the full workspace", async () => {
  const dockerfile = await readFile(path.join(repoRoot, "Dockerfile"), "utf8");

  assert.match(
    dockerfile,
    /COPY --from=builder --chown=goatcitadel:goatcitadel \/app \/app/u,
    "runtime files must receive final ownership during the cross-stage copy",
  );
  assert.doesNotMatch(
    dockerfile,
    /chown -R goatcitadel:goatcitadel \/app(?:\s|\\)/u,
    "the runtime layer must not recursively walk and rechown the complete dependency tree",
  );
  assert.match(
    dockerfile,
    /ARG GOATCITADEL_UID=10001[\s\S]*ARG GOATCITADEL_GID=10001[\s\S]*useradd --uid "\$\{GOATCITADEL_UID\}"/u,
    "the non-root runtime identity must stay stable across image upgrades so persistent volumes retain ownership",
  );
});

test("Compose forwards the command through the Postgres shell guard", async () => {
  const compose = await readFile(path.join(repoRoot, "docker-compose.yaml"), "utf8");

  assert.match(
    compose,
    /exec docker-entrypoint\.sh "\$\$0" "\$\$@"/u,
    "sh -c receives the first Compose command argument as $0 and must forward it to the official entrypoint",
  );
  assert.doesNotMatch(
    compose,
    /exec docker-entrypoint\.sh "\$\$@"/u,
    "forwarding only $@ makes the guarded Postgres container exit cleanly without starting the server",
  );
});

test("Compose exposes the Docker host alias for local providers on every supported engine", async () => {
  const compose = await readFile(path.join(repoRoot, "docker-compose.yaml"), "utf8");

  assert.match(
    compose,
    /extra_hosts:\s+- "host\.docker\.internal:host-gateway"/u,
    "containerized GoatCitadel must be able to resolve the host runtime alias on Linux as well as Docker Desktop",
  );
});

test("Compose persists mutable config and env-backed provider secrets across container recreation", async () => {
  const compose = await readFile(path.join(repoRoot, "docker-compose.yaml"), "utf8");

  assert.match(
    compose,
    /GOATCITADEL_LOCAL_ENV_FILE:\s*\/app\/data\/\.env/u,
    "env-backed provider secrets must use the persistent, non-root-owned data volume",
  );
  assert.match(
    compose,
    /- goatcitadel-config:\/app\/config/u,
    "runtime config generations and onboarding settings must survive container recreation",
  );
  assert.match(compose, /^\s{2}goatcitadel-config:\s*$/mu, "the persistent config volume must be declared");
});
