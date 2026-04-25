#!/usr/bin/env node
import { randomBytes } from "node:crypto";

const args = new Set(process.argv.slice(2));
const dockerEnv = args.has("--docker-env") || args.size === 0;

if (!dockerEnv) {
  console.error("Usage: node scripts/generate-docker-secrets.mjs [--docker-env]");
  process.exit(1);
}

const authToken = randomSecret();
let postgresPassword = randomSecret();
while (postgresPassword === authToken) {
  postgresPassword = randomSecret();
}

console.log(`GOATCITADEL_AUTH_TOKEN=${authToken}`);
console.log(`GOATCITADEL_POSTGRES_PASSWORD=${postgresPassword}`);

function randomSecret() {
  return randomBytes(32).toString("base64url");
}
