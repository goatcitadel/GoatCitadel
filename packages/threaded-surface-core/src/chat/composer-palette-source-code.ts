import { fetchFilesList, fetchPromptPacks, fetchPromptPackTests } from "@goatcitadel/mission-control-shared/api/client";
import { fetchChatGeneratedArtifacts } from "@goatcitadel/mission-control-shared/api/chat";
import { listNotes } from "@goatcitadel/mission-control-shared/api/personal-ops";
import type { BuildSourcesInput } from "./composer-palette-source-types.js";
import type { ComposerPaletteSearchInput } from "./composer-palette.js";
import { buildChatComposerPaletteSources, type PaletteReadOperations } from "./composer-palette-source-builders.js";
import {
  ComposerPaletteSourceRegistry,
  rankComposerPaletteItems,
  createUrlPaletteItem,
} from "./composer-palette-search-code.js";
const canonicalReads: PaletteReadOperations = {
  fetchFilesList,
  fetchPromptPacks,
  fetchPromptPackTests,
  fetchChatGeneratedArtifacts,
  listNotes,
};

export function createComposerPaletteSourceCode(input: BuildSourcesInput, requireCurrentScope: () => void) {
  const guarded =
    <Args extends unknown[], Result>(read: (...args: Args) => Result) =>
    (...args: Args): Result => {
      requireCurrentScope();
      return read(...args);
    };
  const reads: PaletteReadOperations = {
    fetchFilesList: guarded(canonicalReads.fetchFilesList),
    fetchPromptPacks: guarded(canonicalReads.fetchPromptPacks),
    fetchPromptPackTests: guarded(canonicalReads.fetchPromptPackTests),
    fetchChatGeneratedArtifacts: guarded(canonicalReads.fetchChatGeneratedArtifacts),
    listNotes: guarded(canonicalReads.listNotes),
  };
  const sources = buildChatComposerPaletteSources(
    input.loadFiles ? { ...input, loadFiles: guarded(input.loadFiles) } : input,
    reads,
  );
  const registry = new ComposerPaletteSourceRegistry(sources);
  return {
    search: async (search: ComposerPaletteSearchInput) => {
      requireCurrentScope();
      const result = await registry.search(search);
      requireCurrentScope();
      const urlItem = createUrlPaletteItem(search.query);
      return {
        items: urlItem
          ? rankComposerPaletteItems([...result.items, urlItem], search.mode, search.query).slice(0, 24)
          : result.items,
        failures: result.failures,
        loading: false as const,
      };
    },
  };
}
