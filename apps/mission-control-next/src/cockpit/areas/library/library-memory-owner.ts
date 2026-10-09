import { canonicalJsonString, type MemoryItemRecord } from "@goatcitadel/contracts";
import { fetchMemoryItems } from "@goatcitadel/mission-control-shared/api/memory";

/** Bounded canonical lookup through the lifecycle owner, never structured-entity inference. */
export async function readLibraryMemoryItem(itemId: string, workspaceId: string): Promise<MemoryItemRecord | null> {
  let cursor: string | undefined;
  for (let page = 0; page < 20; page += 1) {
    const result = await fetchMemoryItems({ workspaceId, status: "all", limit: 500, cursor });
    const item = result.items.find(value => value.itemId === itemId);
    if (item) {
      const legacy = item.metadata.workspaceId;
      if ((item.workspaceId && item.workspaceId !== workspaceId) || (legacy !== undefined && legacy !== workspaceId) || (item.workspaceId && legacy !== undefined && item.workspaceId !== legacy)) throw new Error("This memory item has inconsistent workspace evidence.");
      return item;
    }
    if (!result.nextCursor) return null;
    cursor = result.nextCursor;
  }
  throw new Error("Memory lookup exceeded the bounded enumeration window. The selected item is not confirmed; use the detailed memory owner.");
}
export const sameMemoryItem = (a: MemoryItemRecord, b: MemoryItemRecord) => canonicalJsonString(a) === canonicalJsonString(b);
