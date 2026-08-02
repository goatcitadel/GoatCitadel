import type {
  AgentProfileRecord,
  ChatGeneratedArtifactRecord,
  ChatProjectRecord,
  NoteRecord,
  SkillListItem,
  ThreadKnowledgeAttachmentRecord,
} from "@goatcitadel/contracts";
import { hashRunVariableSchema } from "@goatcitadel/contracts";
import { fetchFilesList, fetchPromptPacks, fetchPromptPackTests } from "@goatcitadel/mission-control-shared/api/client";
import { fetchChatGeneratedArtifacts } from "@goatcitadel/mission-control-shared/api/chat";
import { listNotes } from "@goatcitadel/mission-control-shared/api/personal-ops";
import type { ChatModelProviderOption } from "@goatcitadel/mission-control-shared/components/ChatModelPicker";
import { useEffect, useMemo, useRef, useState } from "react";
import type { CommandCatalogItem } from "./useChatSessionData";
import type { CommandSuggestionItem } from "../chat-command-suggestions";
import {
  ComposerPaletteSourceRegistry,
  createUrlPaletteItem,
  rankComposerPaletteItems,
  type ComposerPaletteItem,
  type ComposerPaletteMode,
  type ComposerPaletteSourceDefinition,
  type ComposerPaletteSourceFailure,
} from "./composer-palette";

const PALETTE_SEARCH_DEBOUNCE_MS = 140;
const PALETTE_FILE_LIMIT = 250;

export interface ChatComposerPaletteState {
  items: ComposerPaletteItem[];
  failures: ComposerPaletteSourceFailure[];
  loading: boolean;
}

interface BuildSourcesInput {
  commandCatalog: CommandCatalogItem[];
  inlineCommandSuggestions: CommandSuggestionItem[];
  providerOptions: ChatModelProviderOption[];
  agents: AgentProfileRecord[];
  installedSkills: SkillListItem[];
  projects: ChatProjectRecord[];
  knowledgeAttachments: ThreadKnowledgeAttachmentRecord[];
  externalSourcesAvailable: boolean;
  typedRunVariablesEnabled: boolean;
  documentEditingEnabled?: boolean;
  sessionId?: string;
  loadFiles?: typeof fetchFilesList;
}

export function buildChatComposerPaletteSources(input: BuildSourcesInput): ComposerPaletteSourceDefinition[] {
  const sources: ComposerPaletteSourceDefinition[] = [
    {
      id: "commands",
      label: "Commands",
      load: () => {
        const specific: ComposerPaletteItem[] = input.inlineCommandSuggestions
          .filter((entry) => entry.command.startsWith("/"))
          .map((entry) => ({
            ...entry,
            source: "commands" as const,
            sourceLabel: entry.sourceLabel ?? "Command",
            availabilityLabel: entry.availabilityLabel ?? "Available",
            action: entry.action ?? ({ type: "insert_command", value: entry.applyValue } as const),
          }));
        const seen = new Set(specific.map((entry) => entry.command));
        const catalog: ComposerPaletteItem[] = input.commandCatalog
          .filter((entry) => !seen.has(entry.command))
          .map((entry) => ({
            key: `command-${entry.usage}`,
            command: entry.command,
            description: entry.description,
            applyValue: entry.command,
            source: "commands",
            sourceLabel: "Command",
            availabilityLabel: "Available",
            action: { type: "insert_command", value: entry.command },
            keywords: [entry.usage],
          }));
        return [...specific, ...catalog];
      },
    },
    {
      id: "models",
      label: "Models",
      load: () =>
        input.providerOptions.flatMap((provider) => {
          if (provider.disabled) return [];
          return provider.models.map((model) => ({
            key: `model-${provider.providerId}-${model}`,
            command: model,
            description: `Use ${model} from ${provider.label}.`,
            applyValue: `/model ${provider.providerId}/${model}`,
            source: "models" as const,
            sourceLabel: "Model",
            availabilityLabel: describeProviderAvailability(provider),
            action: { type: "select_model" as const, providerId: provider.providerId, model },
            keywords: [provider.providerId, provider.label, `/model ${provider.providerId}/${model}`],
          }));
        }),
    },
    {
      id: "agents",
      label: "Active agents",
      load: () =>
        input.agents
          .filter((agent) => agent.lifecycleStatus === "active" && Boolean(agent.presetDefaults?.presetLabel))
          .map((agent) => ({
            key: `agent-${agent.agentId}`,
            command: agent.presetDefaults?.presetLabel ?? agent.name,
            description: agent.presetDefaults?.presetSummary ?? agent.summary,
            applyValue: agent.agentId,
            source: "agents",
            sourceLabel: "Agent preset",
            availabilityLabel: agent.status === "active" ? "Active" : "Available",
            action:
              input.typedRunVariablesEnabled &&
              agent.presetDefaults?.runVariableSchema &&
              agent.presetDefaults.promptFraming
                ? {
                    type: "open_template_form" as const,
                    invocation: {
                      ownerKind: "agent_preset" as const,
                      ownerId: agent.agentId,
                      ownerRevision: agent.updatedAt,
                      schemaHash: hashRunVariableSchema(agent.presetDefaults.runVariableSchema),
                    },
                    schema: agent.presetDefaults.runVariableSchema,
                    template: agent.presetDefaults.promptFraming,
                    defaults: agent.presetDefaults.runVariableDefaults,
                  }
                : { type: "select_preset" as const, agentId: agent.agentId },
            keywords: [agent.agentId, agent.name, agent.title, ...agent.aliases, ...agent.specialties],
          })),
    },
    {
      id: "prompt_packs",
      label: "Prompt packs",
      load: async () => {
        const packs = (await fetchPromptPacks(200)).items.filter((pack) => Boolean(pack.runVariableSchema));
        const testsByPack = await Promise.all(
          packs.map(async (pack) => ({ pack, tests: (await fetchPromptPackTests(pack.packId, 2000)).items })),
        );
        return testsByPack.flatMap(({ pack, tests }) =>
          tests.map((test) => ({
            key: `prompt-pack-${pack.packId}-${test.testId}`,
            command: `${pack.name}: ${test.title}`,
            description: test.prompt.slice(0, 180),
            applyValue: test.testId,
            source: "prompt_packs" as const,
            sourceLabel: "Prompt pack",
            availabilityLabel: "Validated form",
            action: {
              type: "open_template_form" as const,
              invocation: {
                ownerKind: "prompt_pack" as const,
                ownerId: pack.packId,
                ownerRevision: pack.updatedAt,
                templateId: test.testId,
                schemaHash: pack.runVariableSchemaHash ?? hashRunVariableSchema(pack.runVariableSchema!),
              },
              schema: pack.runVariableSchema!,
              template: test.prompt,
            },
            keywords: [pack.packId, test.code],
          })),
        );
      },
    },
    {
      id: "skills",
      label: "Callable skills",
      load: () =>
        input.installedSkills
          .filter((skill) => skill.state === "enabled" && skill.callable === true)
          .map((skill) => ({
            key: `skill-${skill.skillId}`,
            command: `$${skill.skillId}`,
            description: skill.name,
            applyValue: `$${skill.skillId}`,
            source: "skills",
            sourceLabel: "Callable skill",
            availabilityLabel: skill.trustLabel ?? "Callable",
            action: { type: "insert_command", value: `$${skill.skillId}` },
            keywords: [skill.name, ...(skill.tags ?? []), ...skill.keywords],
          })),
    },
    {
      id: "projects",
      label: "Projects",
      load: () =>
        input.projects
          .filter((project) => project.lifecycleStatus === "active")
          .map((project) => ({
            key: `project-${project.projectId}`,
            command: project.name,
            description: project.description || project.workspacePath,
            applyValue: project.projectId,
            source: "projects",
            sourceLabel: "Project",
            availabilityLabel: "Switch with confirmation",
            action: { type: "switch_project", projectId: project.projectId, projectName: project.name },
            keywords: [project.projectId, project.workspacePath],
          })),
    },
    {
      id: "files",
      label: "Workspace files",
      load: async ({ workspaceId }) => {
        const response = await (input.loadFiles ?? fetchFilesList)(".", PALETTE_FILE_LIMIT, { workspaceId });
        return response.items.map((file) => ({
          key: `file-${file.relativePath}`,
          command: file.relativePath,
          description: `${formatBytes(file.size)} · modified ${formatTimestamp(file.modifiedAt)}`,
          applyValue: file.relativePath,
          source: "files",
          sourceLabel: "Workspace file",
          availabilityLabel: "Ready to attach",
          action: { type: "attach_file", relativePath: file.relativePath },
          keywords: [file.relativePath.split(/[\\/]/u).at(-1) ?? file.relativePath],
        }));
      },
    },
    {
      id: "knowledge",
      label: "Knowledge attachments",
      load: () =>
        input.knowledgeAttachments
          .filter((attachment) => attachment.ingestStatus !== "failed")
          .map((attachment) => ({
            key: `knowledge-${attachment.attachmentId}`,
            command: attachment.title,
            description: attachment.sourceRef,
            applyValue: attachment.attachmentId,
            source: "knowledge",
            sourceLabel: "Knowledge",
            availabilityLabel: attachment.ingestStatus === "ready" ? "Attached" : "Indexing",
            action: { type: "attach_context", attachmentId: attachment.attachmentId },
            keywords: [attachment.sourceType, attachment.retrievalMode],
          })),
    },
  ];

  if (input.documentEditingEnabled) {
    sources.push({
      id: "documents",
      label: "Notes and artifacts",
      load: async ({ workspaceId }) => {
        const settled = await Promise.allSettled([
          listNotes(workspaceId),
          fetchChatGeneratedArtifacts({ workspaceId, sessionId: input.sessionId, limit: 200 }),
        ]);
        const notes = settled[0]?.status === "fulfilled" ? settled[0].value.items : [];
        const artifacts = settled[1]?.status === "fulfilled" ? settled[1].value.items : [];
        if (settled.every((result) => result.status === "rejected")) {
          throw settled[0]?.status === "rejected" ? settled[0].reason : new Error("Document sources unavailable");
        }
        return [
          ...notes.map(
            (note: NoteRecord): ComposerPaletteItem => ({
              key: `note-${note.noteId}`,
              command: note.title,
              description: note.body.slice(0, 180),
              applyValue: note.noteId,
              source: "documents",
              sourceLabel: "Personal note",
              availabilityLabel: `Revision ${note.revision}`,
              action: {
                type: "attach_document",
                documentKind: "personal_note",
                documentId: note.noteId,
                label: note.title,
              },
              keywords: note.tags,
            }),
          ),
          ...artifacts.map(
            (artifact: ChatGeneratedArtifactRecord): ComposerPaletteItem => ({
              key: `artifact-${artifact.artifactId}`,
              command: artifact.title,
              description: `${artifact.kind} artifact · version ${artifact.version}`,
              applyValue: artifact.artifactId,
              source: "documents",
              sourceLabel: "Generated artifact",
              availabilityLabel: "Include in next turn",
              action: {
                type: "attach_document",
                documentKind: "generated_artifact",
                documentId: artifact.artifactId,
                label: artifact.title,
              },
              keywords: [artifact.kind, artifact.language ?? ""],
            }),
          ),
        ];
      },
    });
  }

  if (input.externalSourcesAvailable) {
    sources.push({
      id: "external_sources",
      label: "External sources",
      load: () => [
        {
          key: "external-source-attach",
          command: "Attach imported external source",
          description: "Open the existing governed external-source attachment form in Chat.",
          applyValue: "",
          source: "external_sources",
          sourceLabel: "External source",
          availabilityLabel: "Operator attachment flow",
          action: { type: "launch_external_source" },
          keywords: ["codex", "claude", "import"],
        },
      ],
    });
  }
  return input.typedRunVariablesEnabled ? sources : sources.filter((source) => source.id !== "prompt_packs");
}

export function useChatComposerPaletteController(
  input: BuildSourcesInput & {
    enabled: boolean;
    active: boolean;
    sessionKey: string;
    workspaceId: string;
    mode: ComposerPaletteMode;
    query: string;
  },
): ChatComposerPaletteState {
  const [state, setState] = useState<ChatComposerPaletteState>({ items: [], failures: [], loading: false });
  const generationRef = useRef(0);
  const {
    agents,
    commandCatalog,
    documentEditingEnabled,
    externalSourcesAvailable,
    inlineCommandSuggestions,
    installedSkills,
    knowledgeAttachments,
    loadFiles,
    projects,
    providerOptions,
    sessionId,
    typedRunVariablesEnabled,
  } = input;
  const registry = useMemo(
    () =>
      new ComposerPaletteSourceRegistry(
        buildChatComposerPaletteSources({
          agents,
          commandCatalog,
          documentEditingEnabled,
          externalSourcesAvailable,
          inlineCommandSuggestions,
          installedSkills,
          knowledgeAttachments,
          loadFiles,
          projects,
          providerOptions,
          sessionId,
          typedRunVariablesEnabled,
        }),
      ),
    [
      agents,
      commandCatalog,
      documentEditingEnabled,
      externalSourcesAvailable,
      inlineCommandSuggestions,
      installedSkills,
      knowledgeAttachments,
      loadFiles,
      projects,
      providerOptions,
      sessionId,
      typedRunVariablesEnabled,
    ],
  );

  useEffect(() => {
    const generation = ++generationRef.current;
    if (!input.enabled || !input.active) {
      setState((current) =>
        current.items.length > 0 || current.failures.length > 0 || current.loading
          ? { items: [], failures: [], loading: false }
          : current,
      );
      return;
    }
    setState((current) => ({ ...current, loading: true }));
    const timer = globalThis.setTimeout(() => {
      void registry
        .search({
          sessionKey: input.sessionKey,
          workspaceId: input.workspaceId,
          mode: input.mode,
          query: input.query,
        })
        .then((result) => {
          if (generationRef.current !== generation) return;
          const urlItem = createUrlPaletteItem(input.query);
          setState({
            items: urlItem
              ? rankComposerPaletteItems([...result.items, urlItem], input.mode, input.query).slice(0, 24)
              : result.items,
            failures: result.failures,
            loading: false,
          });
        });
    }, PALETTE_SEARCH_DEBOUNCE_MS);
    return () => globalThis.clearTimeout(timer);
  }, [input.active, input.enabled, input.mode, input.query, input.sessionKey, input.workspaceId, registry]);

  return state;
}

function describeProviderAvailability(provider: ChatModelProviderOption): string {
  switch (provider.modelProbeState) {
    case "ready":
      return "Available";
    case "fallback":
      return "Suggested catalog";
    case "error":
      return "Last known catalog";
    case "empty":
      return "Catalog empty";
    default:
      return "Not checked";
  }
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${Math.round(value / 1024)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

function formatTimestamp(value: string): string {
  const timestamp = new Date(value);
  return Number.isNaN(timestamp.getTime()) ? "time unavailable" : timestamp.toLocaleDateString();
}
