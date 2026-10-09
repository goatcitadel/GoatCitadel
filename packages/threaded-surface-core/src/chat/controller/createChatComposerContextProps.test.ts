import { expect, it, vi } from "vitest";
import { createChatComposerContextProps } from "./createChatComposerContextProps";
type Input = Parameters<typeof createChatComposerContextProps>[0];
it.each([false, true])("allows only clearing retained context intent; historical=%s keeps immutable inspection", historical => {
 const owner = { supported: true, selectedAttachmentIds: ["retained"], canMutate: true, toggleSelection: vi.fn(), clearSelection: vi.fn(), attach: vi.fn(), detach: vi.fn(), requestKnowledgeSnapshot: vi.fn(), reload: vi.fn() };
 const inspection = { status: "ready", source: "frozen-profile" };
 const props = createChatComposerContextProps({ externalSourceAttachments: owner, historicalModeActive: historical, blockHistoricalMutation: () => historical, providerRouting: {}, routePreflight: {}, chatSessionRailPresentation: {}, surfaceState: {}, palette: {}, sessionData: {}, contextActions: {}, oneShotContext: {}, capabilityProfileInspection: inspection } as unknown as Input);
 const controls = props.externalSourceControls!;
 controls.onToggleSelect("new"); expect(owner.toggleSelection).not.toHaveBeenCalled(); controls.onToggleSelect("retained"); expect(owner.toggleSelection).toHaveBeenCalledTimes(historical ? 0 : 1);
 controls.onAttach({ sourceId: "s", importId: "i", itemId: "x" }); controls.onDetach("retained"); controls.onRequestKnowledgeSnapshot("retained");
 expect(owner.attach).toHaveBeenCalledTimes(historical ? 0 : 1); expect(owner.detach).toHaveBeenCalledTimes(historical ? 0 : 1); expect(owner.requestKnowledgeSnapshot).toHaveBeenCalledTimes(historical ? 0 : 1);
 expect(props.capabilityProfileInspection).toBe(inspection); expect(controls.selectedAttachmentIds).toEqual(["retained"]);
});
