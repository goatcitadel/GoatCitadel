export const DOCKER_SECRET_MIN_LENGTH = 32;
export const PLACEHOLDER_AUTH_TOKEN = "change-this-goatcitadel-token";
export const PLACEHOLDER_POSTGRES_PASSWORD = "change-this-postgres-password";

const COMMON_WEAK_SECRET_PATTERN = /^(password|postgres|goatcitadel|secret|token|changeme)$/i;

export function validateRequiredDockerSecret(name, value, placeholder) {
  const normalized = value?.trim() ?? "";
  if (!normalized) {
    return `${name} is required. Set it to a long random value before running docker compose.`;
  }
  if (normalized === placeholder) {
    return `${name} still uses the documented placeholder. Replace it before startup.`;
  }
  if (normalized.length < DOCKER_SECRET_MIN_LENGTH) {
    return `${name} must be at least ${DOCKER_SECRET_MIN_LENGTH} characters long.`;
  }
  if (/^(.)\1+$/.test(normalized) || COMMON_WEAK_SECRET_PATTERN.test(normalized)) {
    return `${name} is too weak. Generate a fresh random value before startup.`;
  }
  return null;
}

export function validateDistinctDockerSecrets(leftName, leftValue, rightName, rightValue) {
  const left = leftValue?.trim();
  const right = rightValue?.trim();
  if (left && right && left === right) {
    return `${leftName} and ${rightName} must be different random values.`;
  }
  return null;
}
