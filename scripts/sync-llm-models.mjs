import fs from "node:fs/promises";
import path from "node:path";

const gatewayUrl = (process.env.GOATCITADEL_GATEWAY_URL || "http://127.0.0.1:8787").replace(/\/+$/, "");
const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
const outputDir = path.resolve("artifacts", "llm-models");

async function requestJson(url) {
  const response = await fetch(url, {
    headers: {
      accept: "application/json",
    },
  });
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}: ${await response.text()}`);
  }
  return response.json();
}

function deriveSuggestedDefault(providerId, currentDefault, modelIds) {
  if (!Array.isArray(modelIds) || modelIds.length === 0) {
    return undefined;
  }
  if (modelIds.includes(currentDefault)) {
    return currentDefault;
  }
  if (providerId === "google") {
    const googleExact = currentDefault.startsWith("models/")
      ? currentDefault
      : `models/${currentDefault}`;
    if (modelIds.includes(googleExact)) {
      return googleExact;
    }
  }
  const suffixMatch = modelIds.find((id) => id === currentDefault || id.endsWith(`/${currentDefault}`));
  return suffixMatch;
}

function markdownCell(value) {
  return String(value ?? "").replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

function buildMarkdown(report) {
  const lines = [
    "# LLM Model Sync Report",
    "",
    `Gateway: ${report.gatewayUrl}`,
    `Generated: ${report.generatedAt}`,
    "",
    "| Provider | Secret | Current Default | Status | Source | Suggested Default | Models | Warning |",
    "| --- | --- | --- | --- | --- | --- | ---: | --- |",
  ];

  for (const item of report.providers) {
    lines.push(
      `| ${markdownCell(item.providerId)} | ${markdownCell(item.hasSecret ? item.secretSource : "none")} | ${markdownCell(item.currentDefault)} | ${markdownCell(item.status)} | ${markdownCell(item.source)} | ${markdownCell(item.suggestedDefault)} | ${item.modelCount ?? 0} | ${markdownCell(item.warning)} |`,
    );
  }

  const mismatches = report.providers.filter((item) => item.status === "mismatch");
  if (mismatches.length > 0) {
    lines.push("", "## Mismatched defaults", "");
    for (const item of mismatches) {
      lines.push(`- \`${item.providerId}\`: current \`${item.currentDefault}\`, suggested \`${item.suggestedDefault}\``);
    }
  }

  const failures = report.providers.filter((item) => item.status === "error");
  if (failures.length > 0) {
    lines.push("", "## Discovery errors", "");
    for (const item of failures) {
      lines.push(`- \`${item.providerId}\`: ${item.error}`);
    }
  }

  return `${lines.join("\n")}\n`;
}

async function main() {
  const [status, config] = await Promise.all([
    requestJson(`${gatewayUrl}/api/v1/dev/verification/status`),
    requestJson(`${gatewayUrl}/api/v1/llm/config`),
  ]);

  const providerConfig = new Map((config.providers ?? []).map((provider) => [provider.providerId, provider]));
  const report = {
    gatewayUrl,
    generatedAt: new Date().toISOString(),
    providers: [],
  };

  for (const provider of status.providers ?? []) {
    const current = providerConfig.get(provider.providerId);
    const record = {
      providerId: provider.providerId,
      label: provider.label,
      hasSecret: provider.hasSecret,
      secretSource: provider.source,
      currentDefault: current?.defaultModel,
      status: "not_configured",
      suggestedDefault: undefined,
      modelCount: 0,
      models: [],
      source: undefined,
      warning: undefined,
      error: undefined,
    };

    if (!provider.hasSecret) {
      report.providers.push(record);
      continue;
    }

    try {
      const response = await requestJson(`${gatewayUrl}/api/v1/llm/models?providerId=${encodeURIComponent(provider.providerId)}`);
      const modelIds = (response.items ?? []).map((item) => item.id).filter(Boolean);
      record.models = modelIds;
      record.modelCount = modelIds.length;
      record.source = response.source;
      record.warning = response.warning;
      record.suggestedDefault = deriveSuggestedDefault(provider.providerId, current?.defaultModel, modelIds);
      if (record.suggestedDefault && record.suggestedDefault === current?.defaultModel) {
        record.status = "ok";
      } else if (record.suggestedDefault) {
        record.status = "mismatch";
      } else {
        record.status = "unresolved";
      }
    } catch (error) {
      record.status = "error";
      record.error = error instanceof Error ? error.message : String(error);
    }

    report.providers.push(record);
  }

  await fs.mkdir(outputDir, { recursive: true });
  const jsonPath = path.join(outputDir, `${timestamp}.json`);
  const latestPath = path.join(outputDir, "latest.json");
  const markdownPath = path.join(outputDir, `${timestamp}.md`);
  const latestMarkdownPath = path.join(outputDir, "latest.md");
  await fs.writeFile(jsonPath, JSON.stringify(report, null, 2));
  await fs.writeFile(latestPath, JSON.stringify(report, null, 2));
  const markdown = buildMarkdown(report);
  await fs.writeFile(markdownPath, markdown);
  await fs.writeFile(latestMarkdownPath, markdown);

  console.log(`LLM model sync report written to ${jsonPath}`);
  for (const item of report.providers) {
    console.log(
      `${item.providerId}: ${item.status}` +
      (item.suggestedDefault ? ` (suggested: ${item.suggestedDefault})` : "") +
      (item.error ? ` (${item.error})` : ""),
    );
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
