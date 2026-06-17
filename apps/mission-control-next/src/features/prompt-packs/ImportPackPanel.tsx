import { LoaderCircle, Upload } from "lucide-react";
import { NativeButton } from "@next/features/native-routes/primitives";

export interface ImportPackPanelProps {
  importText: string;
  importing: boolean;
  onSetImportText: (value: string) => void;
  onImport: () => void;
}

export function ImportPackPanel({ importText, importing, onSetImportText, onImport }: ImportPackPanelProps) {
  return (
    <details className="mc-pp-panel mc-pp-panel-collapsible">
      <summary>
        <div>
          <h4>Import a new pack</h4>
          <p>Open only when you want to paste fresh prompt-pack markdown into the workspace.</p>
        </div>
        <Upload size={16} />
      </summary>
      <label className="mc-pp-field">
        <span>Prompt-pack markdown</span>
        <textarea
          rows={7}
          placeholder="Paste prompt-pack markdown here..."
          value={importText}
          onChange={(event) => onSetImportText(event.target.value)}
        />
      </label>
      <div className="mc-pp-inline-actions">
        <NativeButton onClick={onImport} disabled={importing}>
          {importing ? <LoaderCircle size={16} className="mc-spin" /> : <Upload size={16} />}
          Import pack
        </NativeButton>
      </div>
    </details>
  );
}
