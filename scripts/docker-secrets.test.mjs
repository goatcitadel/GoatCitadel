import test from "node:test";
import assert from "node:assert/strict";
import {
  PLACEHOLDER_AUTH_TOKEN,
  validateDistinctDockerSecrets,
  validateRequiredDockerSecret,
} from "./lib/docker-secrets.mjs";

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
  assert.match(
    validateRequiredDockerSecret("GOATCITADEL_AUTH_TOKEN", "", PLACEHOLDER_AUTH_TOKEN) ?? "",
    /required/,
  );
  assert.match(
    validateRequiredDockerSecret("GOATCITADEL_AUTH_TOKEN", PLACEHOLDER_AUTH_TOKEN, PLACEHOLDER_AUTH_TOKEN) ?? "",
    /placeholder/,
  );
  assert.match(
    validateRequiredDockerSecret("GOATCITADEL_AUTH_TOKEN", "short", PLACEHOLDER_AUTH_TOKEN) ?? "",
    /at least 32/,
  );
  assert.match(
    validateRequiredDockerSecret("GOATCITADEL_AUTH_TOKEN", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", PLACEHOLDER_AUTH_TOKEN) ??
      "",
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
