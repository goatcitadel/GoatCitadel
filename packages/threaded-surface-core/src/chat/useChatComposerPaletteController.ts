import { useEffect, useMemo, useRef, useState } from "react";
import { getGatewayApiBaseUrl } from "@goatcitadel/mission-control-shared/api/client-core";
import {
  getGatewayCallerScopeRevision,
  getGatewayAccessRevision,
} from "@goatcitadel/mission-control-shared/api/access-scope";
import {
  rankComposerPaletteItems,
  type ComposerPaletteItem,
  type ComposerPaletteSourceFailure,
  type ComposerPaletteMode,
} from "./composer-palette.js";
import type { BuildSourcesInput } from "./composer-palette-source-types.js";
export { buildChatComposerPaletteSources } from "./composer-palette-source-builders.js";
const PALETTE_SEARCH_DEBOUNCE_MS = 140;
type PaletteSourceCode = typeof import("./composer-palette-source-code.js");
let paletteSourceCodePromise: Promise<PaletteSourceCode> | null = null;
function loadComposerPaletteSourceCode(): Promise<PaletteSourceCode> {
  return (paletteSourceCodePromise ??= import("./composer-palette-source-code.js").catch((cause: unknown) => {
    paletteSourceCodePromise = null;
    throw cause;
  }));
}

export interface ChatComposerPaletteState {
  items: ComposerPaletteItem[];
  failures: ComposerPaletteSourceFailure[];
  loading: boolean;
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
    workspaceExplorerAvailable,
  } = input;

  const callerRevision = getGatewayCallerScopeRevision();
  const accessRevision = getGatewayAccessRevision();
  const gatewayBase = getGatewayApiBaseUrl();
  const registryOwner = useMemo(
    () => ({
      input: {
        agents,
        commandCatalog,
        externalSourcesAvailable,
        inlineCommandSuggestions,
        installedSkills,
        knowledgeAttachments,
        projects,
        providerOptions,
        typedRunVariablesEnabled,
        ...(workspaceExplorerAvailable !== undefined ? { workspaceExplorerAvailable } : {}),
        ...(documentEditingEnabled !== undefined ? { documentEditingEnabled } : {}),
        ...(loadFiles ? { loadFiles } : {}),
        ...(sessionId !== undefined ? { sessionId } : {}),
      },
      callerRevision,
      accessRevision,
      gatewayBase,
      workspaceId: input.workspaceId,
      sessionKey: input.sessionKey,
      runtime: null as ReturnType<PaletteSourceCode["createComposerPaletteSourceCode"]> | null,
    }),
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
      workspaceExplorerAvailable,
      callerRevision,
      accessRevision,
      gatewayBase,
      input.workspaceId,
      input.sessionKey,
    ],
  );
  const registryOwnerRef = useRef(registryOwner);
  registryOwnerRef.current = registryOwner;
  const searchIdentity = useMemo(
    () => ({ registryOwner, enabled: input.enabled, active: input.active, mode: input.mode, query: input.query }),
    [registryOwner, input.enabled, input.active, input.mode, input.query],
  );
  const searchIdentityRef = useRef(searchIdentity);
  searchIdentityRef.current = searchIdentity;
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

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
    let cancelled = false;
    const scopeCurrent = () =>
      mountedRef.current &&
      registryOwnerRef.current === registryOwner &&
      searchIdentityRef.current.enabled &&
      searchIdentityRef.current.active &&
      getGatewayCallerScopeRevision() === registryOwner.callerRevision &&
      getGatewayAccessRevision() === registryOwner.accessRevision &&
      getGatewayApiBaseUrl() === registryOwner.gatewayBase;
    const searchCurrent = () =>
      !cancelled &&
      scopeCurrent() &&
      searchIdentityRef.current === searchIdentity &&
      generationRef.current === generation;
    const requireCurrentScope = () => {
      if (!scopeCurrent())
        throw new DOMException("Composer palette scope changed before its sources could load.", "AbortError");
    };
    setState((current) => ({ ...current, loading: true }));
    const timer = globalThis.setTimeout(() => {
      void (async () => {
        try {
          if (!searchCurrent()) return;
          const code = await loadComposerPaletteSourceCode();
          if (!searchCurrent()) return;
          const runtime = (registryOwner.runtime ??= code.createComposerPaletteSourceCode(
            registryOwner.input,
            requireCurrentScope,
          ));
          const result = await runtime.search({
            sessionKey: input.sessionKey,
            workspaceId: input.workspaceId,
            mode: input.mode,
            query: input.query,
          });
          if (!searchCurrent()) return;
          setState(result);
        } catch {
          if (!searchCurrent()) return;
          setState({
            items: [],
            failures: [
              {
                source: "commands",
                sourceLabel: "Composer palette",
                message: "Composer palette couldn't load. Open it again to retry.",
              },
            ],
            loading: false,
          });
        }
      })();
    }, PALETTE_SEARCH_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      globalThis.clearTimeout(timer);
    };
  }, [
    input.active,
    input.enabled,
    input.mode,
    input.query,
    input.sessionKey,
    input.workspaceId,
    registryOwner,
    searchIdentity,
  ]);

  // While a new search runs, keep showing the previous results, narrowed to the typed text right away.
  const { mode, query } = input;
  return useMemo(
    () => (state.loading ? { ...state, items: rankComposerPaletteItems(state.items, mode, query) } : state),
    [mode, query, state],
  );
}
