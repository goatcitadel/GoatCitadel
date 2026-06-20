import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_ARTIFACT_ROOT = path.join(process.cwd(), "artifacts", "verification");
const LATEST_RUN_POINTER_PATH = path.join(DEFAULT_ARTIFACT_ROOT, "latest-run.json");
const MAX_TEXT_SCAN_BYTES = 10 * 1024 * 1024;

const SECRET_PATTERNS = [
  {
    id: "openai-style-key",
    pattern: /\bsk-(?!ant-)[A-Za-z0-9_-]{20,}\b/i,
  },
  {
    id: "anthropic-style-key",
    pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/i,
  },
  {
    id: "github-style-token",
    pattern: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/,
  },
  {
    id: "bearer-token",
    pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}/i,
  },
  {
    id: "authorization-header",
    pattern: /\bAuthorization\s*:\s*(?:Bearer|Basic|ApiKey|Token)\s+\S{8,}/i,
  },
  {
    id: "provider-secret-json",
    pattern: /"(?:apiKey|api_key|authorization|accessToken|access_token)"\s*:\s*"[^"]{16,}"/i,
  },
  {
    id: "provider-secret-env",
    pattern:
      /\b[A-Z0-9_]*(?:API[_-]?KEY|ACCESS[_-]?TOKEN|AUTH[_-]?TOKEN|SECRET|PASSWORD)[A-Z0-9_]*\s*=\s*["']?[^"'\s]{16,}/i,
  },
  {
    id: "provider-secret-url-query",
    pattern:
      /[?&](?:api[_-]?key|access[_-]?token|auth[_-]?token|token|password|secret|client_secret)=([^&#\s]{12,})/i,
  },
];

export async function findArtifactRedactionFindings(rootDir = DEFAULT_ARTIFACT_ROOT) {
  const findings = [];
  let rootStat;
  try {
    rootStat = await fs.stat(rootDir);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return findings;
    }
    throw error;
  }
  if (!rootStat.isDirectory()) {
    return findings;
  }
  for await (const filePath of walkFiles(rootDir)) {
    const stat = await fs.stat(filePath);
    if (stat.size > MAX_TEXT_SCAN_BYTES) {
      continue;
    }
    const content = await fs.readFile(filePath, "utf8").catch(() => undefined);
    if (content === undefined) {
      continue;
    }
    for (const rule of SECRET_PATTERNS) {
      if (rule.pattern.test(content)) {
        findings.push({
          file: path.relative(rootDir, filePath).replaceAll("\\", "/"),
          ruleId: rule.id,
        });
      }
    }
  }
  return findings;
}

async function* walkFiles(dir) {
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walkFiles(entryPath);
    } else if (entry.isFile()) {
      yield entryPath;
    }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const rootDir = process.argv[2] ? path.resolve(process.argv[2]) : await resolveDefaultScanRoot();
  const findings = await findArtifactRedactionFindings(rootDir);
  if (findings.length > 0) {
    console.error("Verification artifact redaction failed:");
    for (const finding of findings) {
      console.error(`- ${finding.file}: ${finding.ruleId}`);
    }
    process.exitCode = 1;
  } else {
    console.log("Verification artifact redaction passed.");
  }
}

async function resolveDefaultScanRoot() {
  const latestRunRoot = await readLatestRunArtifactRoot();
  return latestRunRoot ?? DEFAULT_ARTIFACT_ROOT;
}

async function readLatestRunArtifactRoot() {
  const pointer = await fs.readFile(LATEST_RUN_POINTER_PATH, "utf8").catch(() => undefined);
  if (!pointer) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(pointer);
    if (typeof parsed?.artifactRoot !== "string" || parsed.artifactRoot.trim().length === 0) {
      return undefined;
    }
    const artifactRoot = path.resolve(parsed.artifactRoot);
    const relative = path.relative(DEFAULT_ARTIFACT_ROOT, artifactRoot);
    if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
      return artifactRoot;
    }
  } catch {
    return undefined;
  }
  return undefined;
}
