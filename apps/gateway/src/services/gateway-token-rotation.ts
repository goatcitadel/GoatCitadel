import fs from "node:fs";
import { createHash } from "node:crypto";
import { logger } from "@goatcitadel/gateway-core";
import {
  applyLocalEnvValue,
  readLocalEnvVar,
  resolveWritableEnvFilePath,
  syncCredentialDirectory,
  upsertLocalEnvVar,
  wasLoadedFromLocalEnv,
  writeCredentialFileAtomicSync,
} from "../env-file.js";
import type { ConfigGenerationProviderSecretVerification } from "./config-generation-service.js";
import { createProviderSecretVerification, verifyProviderSecret } from "./provider-secret-persistence.js";

const TOKEN_KEY = "GOATCITADEL_AUTH_TOKEN";
const rotationLog = logger.child("gateway-token-rotation");

export interface GatewayTokenRotationReceipt {
  previous: ConfigGenerationProviderSecretVerification;
  replacement: ConfigGenerationProviderSecretVerification;
}

function rotationPath(envPath: string, generationId: string): string {
  // Hash the generation identifier so even a malformed marker cannot select another path.
  const id = createHash("sha256").update(generationId).digest("hex");
  return `${envPath}.gateway-token-${id}.pending`;
}

export function stageGatewayTokenRotation(
  rootDir: string,
  generationId: string,
  previous: string,
  replacement: string,
): GatewayTokenRotationReceipt {
  const envPath = resolveWritableEnvFilePath({ rootDir });
  if (!envPath) throw new Error("The Gateway credential file is unavailable.");
  const receipt = {
    previous: createProviderSecretVerification(previous),
    replacement: createProviderSecretVerification(replacement),
  };
  writeCredentialFileAtomicSync(rotationPath(envPath, generationId), replacement, true);
  return receipt;
}

export function discardGatewayTokenRotation(rootDir: string, generationId: string): void {
  const envPath = resolveWritableEnvFilePath({ rootDir });
  if (!envPath) return;
  try {
    fs.rmSync(rotationPath(envPath, generationId), { force: true });
  } catch (error) {
    // The generation receipt controls promotion even when an abandoned file remains.
    rotationLog.warn("could not remove staged Gateway credential", {
      generationId,
      code: error instanceof Error && "code" in error ? error.code : undefined,
    });
  }
}

export function recoverGatewayTokenRotation(
  rootDir: string,
  generationId: string,
  receipt: GatewayTokenRotationReceipt,
): void {
  const options = { rootDir };
  const saved = readLocalEnvVar(TOKEN_KEY, options);
  if (!saved.path) throw new Error("The Gateway credential file is unavailable.");
  const inherited = process.env[TOKEN_KEY];
  const fromFile = wasLoadedFromLocalEnv(TOKEN_KEY, saved.path);
  if (inherited !== undefined && !fromFile && !verifyProviderSecret(inherited, receipt.replacement)) {
    throw new Error("The launch environment overrides the committed Gateway token rotation.");
  }
  if (!saved.value || !verifyProviderSecret(saved.value, receipt.replacement)) {
    if (!saved.value || !verifyProviderSecret(saved.value, receipt.previous)) {
      throw new Error("The saved Gateway token changed before rotation recovery.");
    }
    const replacement = fs.readFileSync(rotationPath(saved.path, generationId), "utf8");
    if (
      !verifyProviderSecret(replacement, receipt.replacement) ||
      !upsertLocalEnvVar(TOKEN_KEY, replacement, options).updated
    ) {
      throw new Error("The committed Gateway token rotation could not be recovered.");
    }
  }
  const installed = readLocalEnvVar(TOKEN_KEY, options).value;
  if (!installed || !verifyProviderSecret(installed, receipt.replacement)) {
    throw new Error("The recovered Gateway token could not be verified.");
  }
  syncCredentialDirectory(saved.path);
  if (fromFile || inherited === undefined) applyLocalEnvValue(TOKEN_KEY, installed, saved.path);
  discardGatewayTokenRotation(rootDir, generationId);
}
