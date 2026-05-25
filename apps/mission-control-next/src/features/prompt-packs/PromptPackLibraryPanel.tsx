import { ClipboardCopy } from "lucide-react";

export interface PromptPackLibraryPanelProps {
  isOpsVariant: boolean;
  packs: Array<{ packId: string; name: string; testCount: number }>;
  selectedPackId: string | null;
  onSelectPack: (packId: string) => void;
}

export function PromptPackLibraryPanel({
  isOpsVariant,
  packs,
  selectedPackId,
  onSelectPack,
}: PromptPackLibraryPanelProps) {
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
