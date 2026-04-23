import { ActionButton } from "../../components/ActionButton";
import { HelpHint } from "../../components/HelpHint";
import { Panel } from "../../components/Panel";

type MemoryItemRecord = {
  itemId: string;
  namespace: string;
  title: string;
  content: string;
  pinned: boolean;
  status: "active" | "forgotten";
  lifecycleState: "active" | "expired" | "forgotten";
  updatedAt: string;
  ttlOverrideSeconds?: number;
  expiresAt?: string;
};

type MemoryHistoryRecord = {
  changeId: string;
  changeType: string;
  actorId?: string;
  createdAt: string;
};

export function MemoryLifecycleAdminPanel(props: {
  memoryAdminEnabled: boolean;
  memoryAdminError: string | null;
  memoryItems: MemoryItemRecord[];
  selectedMemoryItemId: string | null;
  selectedMemoryItem: MemoryItemRecord | null;
  memoryHistory: MemoryHistoryRecord[];
  memoryBusyItemId: string | null;
  onInspect: (itemId: string) => void;
  onTogglePin: (itemId: string, pinned: boolean) => void;
  onRequestForget: (item: { itemId: string; title: string }) => void;
}) {
  const {
    memoryAdminEnabled,
    memoryAdminError,
    memoryItems,
    selectedMemoryItemId,
    selectedMemoryItem,
    memoryHistory,
    memoryBusyItemId,
    onInspect,
    onTogglePin,
    onRequestForget,
  } = props;

  return (
    <Panel
      title={
        <>
          Memory Lifecycle Admin
          <HelpHint
            label="Memory lifecycle admin help"
            text="This panel lets you inspect, pin, and forget saved memory records directly. It is for operator review, not normal day-to-day chatting."
          />
        </>
      }
      subtitle="Inspect, pin, and forget saved memory records directly when lifecycle admin is enabled."
    >
      {!memoryAdminEnabled ? (
        <p className="office-subtitle">
          Memory lifecycle admin is disabled right now. File inventory and QMD context tracking are still available
          above.
        </p>
      ) : memoryAdminError ? (
        <p className="error">{memoryAdminError}</p>
      ) : memoryItems.length === 0 ? (
        <p className="office-subtitle">No memory lifecycle records available.</p>
      ) : (
        <div className="split-grid">
          <div>
            <table className="gc-data-table">
              <thead>
                <tr>
                  <th>Title</th>
                  <th>Namespace</th>
                  <th>
                    Status
                    <HelpHint
                      label="Memory status help"
                      text="Active memory can influence future replies. Forgotten memory stays in history but should no longer be reused. Pinned memory stays favored until you unpin it."
                    />
                  </th>
                  <th>Updated</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {memoryItems.slice(0, 80).map((item) => (
                  <tr key={item.itemId} className={item.itemId === selectedMemoryItemId ? "row-selected" : ""}>
                    <td>{item.title}</td>
                    <td>{item.namespace}</td>
                    <td>
                      {item.status}
                      {item.lifecycleState !== item.status ? ` (${item.lifecycleState})` : ""}
                      {item.pinned ? " • pinned" : ""}
                    </td>
                    <td>{new Date(item.updatedAt).toLocaleString()}</td>
                    <td className="actions">
                      <ActionButton label="Inspect" onClick={() => onInspect(item.itemId)} />
                      <ActionButton
                        label={item.pinned ? "Unpin" : "Pin"}
                        disabled={memoryBusyItemId === item.itemId}
                        onClick={() => onTogglePin(item.itemId, item.pinned)}
                      />
                      <ActionButton
                        label="Forget"
                        danger
                        disabled={item.status === "forgotten" || memoryBusyItemId === item.itemId}
                        onClick={() => onRequestForget({ itemId: item.itemId, title: item.title })}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div>
            <h4>{selectedMemoryItem ? selectedMemoryItem.title : "Select a memory item"}</h4>
            {selectedMemoryItem ? (
              <>
                <p>
                  <strong>Item ID:</strong> {selectedMemoryItem.itemId}
                </p>
                <p>
                  <strong>Status:</strong> {selectedMemoryItem.status}
                </p>
                <p>
                  <strong>Lifecycle state:</strong> {selectedMemoryItem.lifecycleState}
                </p>
                <p>
                  <strong>
                    TTL Override
                    <HelpHint
                      label="TTL override help"
                      text="Optional per-item expiration in seconds. Blank means the normal memory lifecycle rules apply instead."
                    />
                  </strong>
                  : {selectedMemoryItem.ttlOverrideSeconds ?? "-"}
                </p>
                <p>
                  <strong>Expires At:</strong>{" "}
                  {selectedMemoryItem.expiresAt ? new Date(selectedMemoryItem.expiresAt).toLocaleString() : "-"}
                </p>
                <pre>{selectedMemoryItem.content}</pre>
              </>
            ) : null}
            <h4>Change History</h4>
            {memoryHistory.length === 0 ? (
              <p className="office-subtitle">
                No history loaded yet. Inspect an item to see pin, forget, and edit events.
              </p>
            ) : null}
            <ul className="compact-list">
              {memoryHistory.map((event) => (
                <li key={event.changeId}>
                  <strong>{event.changeType}</strong> · {new Date(event.createdAt).toLocaleString()}
                  {event.actorId ? ` · ${event.actorId}` : ""}
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}
    </Panel>
  );
}
