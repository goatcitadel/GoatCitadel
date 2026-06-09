import { ClipboardCopy } from "lucide-react";

export interface PromptPackLibraryPanelProps {
  isOpsVariant: boolean;
  packs: Array<{ packId: string; name: string; testCount: number }>;
  selectedPackId: string | null;
  onSelectPack: (packId: string) => void;
  compact?: boolean;
}

export function PromptPackLibraryPanel({
  isOpsVariant,
  packs,
  selectedPackId,
  onSelectPack,
  compact = false,
}: PromptPackLibraryPanelProps) {
  const selectedPack = packs.find((pack) => pack.packId === selectedPackId);
  const selectValue = selectedPack?.packId ?? "";

  if (compact) {
    return (
      <section className="mc-pp-panel mc-pp-pack-picker">
        <div className="mc-pp-section-heading">
          <div>
            <h4>{isOpsVariant ? "Quality pack" : "Pack library"}</h4>
            <p>
              {selectedPack
                ? `${selectedPack.name} - ${selectedPack.testCount} test${selectedPack.testCount === 1 ? "" : "s"}`
                : "Select a pack to begin."}
            </p>
          </div>
          <ClipboardCopy size={16} />
        </div>
        <label className="mc-pp-field">
          <span>Prompt pack</span>
          <select
            aria-label="Prompt pack"
            value={selectValue}
            disabled={packs.length === 0}
            onChange={(event) => {
              if (event.target.value) {
                onSelectPack(event.target.value);
              }
            }}
          >
            {!selectedPack ? (
              <option value="">{packs.length === 0 ? "No packs available" : "Select a pack"}</option>
            ) : null}
            {packs.map((pack) => (
              <option key={pack.packId} value={pack.packId}>
                {pack.name} ({pack.testCount})
              </option>
            ))}
          </select>
        </label>
      </section>
    );
  }

  return (
    <section className="mc-pp-panel">
      <div className="mc-pp-section-heading">
        <div>
          <h4>Pack library</h4>
          <p>
            {isOpsVariant
              ? "Switch packs without leaving the active quality review."
              : "Stay on one pack while you work through tests and reviews."}
          </p>
        </div>
        <ClipboardCopy size={16} />
      </div>
      <div className="mc-pp-pack-list" role="list" aria-label="Prompt packs">
        {packs.map((pack) => (
          <button
            key={pack.packId}
            type="button"
            className={`mc-pp-pack-item${selectedPackId === pack.packId ? " active" : ""}`}
            onClick={() => onSelectPack(pack.packId)}
          >
            <span className="mc-pp-pack-copy">
              <strong>{pack.name}</strong>
              <span>{pack.testCount} tests</span>
            </span>
          </button>
        ))}
      </div>
    </section>
  );
}
