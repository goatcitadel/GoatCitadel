import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {
  SemanticValidationError,
  ServiceUnavailableError,
  ValidationError,
  type LlamaCppModelManifest,
} from "@goatcitadel/contracts";
import type { LlamaCppInstallDetection } from "./llama-cpp-runtime-service.js";

const SELECTION_TTL_MS = 30 * 60_000;

export interface LlamaCppSetupSelection {
  selectionId: string;
  workspaceId: string;
  modelId: string;
  alias: string;
  modelPath: string;
  command: string;
  modelMtimeMs: number;
  modelBytes: number;
  commandMtimeMs: number;
  expiresAt: string;
}

interface SelectionDeps {
  listModels: () => Promise<LlamaCppModelManifest[]>;
  detectInstall: () => Promise<LlamaCppInstallDetection>;
  custody: {
    setSecret: (account: string, value: string) => void;
    getSecret: (account: string) => string | undefined;
    deleteSecret: (account: string) => void;
  };
}

/** Host paths stay with the Gateway owner; plans carry only an opaque id. */
export class LlamaCppSetupSelectionService {
  public constructor(private readonly deps: SelectionDeps) {}

  public async stage(input: { workspaceId: string; modelId: string; commandPath?: string }) {
    const model = (await this.deps.listModels()).find(
      (item) => item.modelId === input.modelId && item.source === "filesystem" && item.filePath,
    );
    if (!model?.filePath)
      throw new SemanticValidationError("Choose a GGUF discovered under the configured models root.");
    const installed = await this.deps.detectInstall();
    const command = input.commandPath?.trim() || installed.command;
    if (!command || !path.isAbsolute(command) || !/^llama-server(?:\.exe)?$/iu.test(path.basename(command))) {
      throw new SemanticValidationError("Choose an installed llama-server executable, or add it to PATH.");
    }
    const [modelStat, commandStat] = await Promise.all([fs.stat(model.filePath), fs.stat(command)]);
    if (!modelStat.isFile() || !model.filePath.toLowerCase().endsWith(".gguf") || !commandStat.isFile()) {
      throw new SemanticValidationError("The selected model or llama-server executable is not a regular file.");
    }
    const selection: LlamaCppSetupSelection = {
      selectionId: randomUUID(),
      workspaceId: input.workspaceId,
      modelId: input.modelId,
      alias:
        path
          .basename(model.filePath)
          .replace(/\.gguf$/iu, "")
          .replace(/[^A-Za-z0-9._-]+/gu, "-")
          .slice(0, 128)
          .replace(/^-+|-+$/gu, "") || "local-model",
      modelPath: await fs.realpath(model.filePath),
      command: await fs.realpath(command),
      modelMtimeMs: modelStat.mtimeMs,
      modelBytes: modelStat.size,
      commandMtimeMs: commandStat.mtimeMs,
      expiresAt: new Date(Date.now() + SELECTION_TTL_MS).toISOString(),
    };
    this.deps.custody.setSecret(account(selection.selectionId), JSON.stringify(selection));
    return {
      selectionId: selection.selectionId,
      modelId: selection.modelId,
      alias: selection.alias,
      modelLabel: path.basename(selection.modelPath),
      commandLabel: path.basename(selection.command),
      expiresAt: selection.expiresAt,
    };
  }

  public async resolve(selectionId: string, workspaceId: string): Promise<LlamaCppSetupSelection> {
    const raw = this.deps.custody.getSecret(account(selectionId));
    if (!raw) throw new ServiceUnavailableError("The managed model selection expired. Choose the files again.");
    let selection: LlamaCppSetupSelection;
    try {
      selection = JSON.parse(raw) as LlamaCppSetupSelection;
    } catch {
      throw new ServiceUnavailableError("The managed model selection is unavailable.");
    }
    if (
      selection.selectionId !== selectionId ||
      selection.workspaceId !== workspaceId ||
      Date.parse(selection.expiresAt) <= Date.now()
    ) {
      throw new ValidationError({ message: "The managed model selection is stale or belongs to another workspace." });
    }
    try {
      const [modelStat, commandStat, modelPath, command] = await Promise.all([
        fs.stat(selection.modelPath),
        fs.stat(selection.command),
        fs.realpath(selection.modelPath),
        fs.realpath(selection.command),
      ]);
      if (
        !modelStat.isFile() ||
        !commandStat.isFile() ||
        modelStat.size !== selection.modelBytes ||
        modelStat.mtimeMs !== selection.modelMtimeMs ||
        commandStat.mtimeMs !== selection.commandMtimeMs ||
        modelPath !== selection.modelPath ||
        command !== selection.command
      )
        throw new Error("changed");
    } catch {
      throw new SemanticValidationError("The selected llama-server or GGUF changed. Choose it again before applying.");
    }
    return selection;
  }

  public discard(selectionId: string): void {
    this.deps.custody.deleteSecret(account(selectionId));
  }
}

function account(selectionId: string): string {
  if (!/^[a-f0-9-]{36}$/iu.test(selectionId)) throw new ValidationError({ message: "Invalid managed selection id." });
  return `llamacpp-setup-selection:${selectionId}`;
}
