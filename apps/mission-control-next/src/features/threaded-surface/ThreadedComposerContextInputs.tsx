import type { MissionThreadedActiveSessionSurfaceProps } from "@goatcitadel/threaded-surface-core";

export function ThreadedComposerContextInputs({
  props,
  composerActionDisabled,
}: {
  props: MissionThreadedActiveSessionSurfaceProps;
  composerActionDisabled: boolean | undefined;
}) {
  const presetOptions = props.presetOptions ?? [];
  const knowledgeUrlDraft = props.knowledgeUrlDraft ?? "";
  const knowledgeUrlMode = props.knowledgeUrlMode ?? "retrieval";
  return (
    <>
      {presetOptions.length > 0 ? (
        <div className="mc-next-composer-plus-section">
          <label htmlFor="threaded-composer-preset">Preset</label>
          <div className="mc-next-composer-preset-row">
            <select
              id="threaded-composer-preset"
              value={props.selectedPresetId}
              disabled={composerActionDisabled}
              onChange={(event) => {
                if (!composerActionDisabled) {
                  props.onPresetChange?.(event.target.value);
                }
              }}
            >
              <option value="">Choose preset</option>
              {presetOptions.map((preset) => (
                <option key={preset.value} value={preset.value}>
                  {preset.label}
                </option>
              ))}
            </select>
            <button
              type="button"
              className="mc-next-composer-inline-button"
              disabled={composerActionDisabled || !props.selectedPresetId}
              onClick={() => {
                if (!composerActionDisabled) {
                  props.onApplyPreset?.();
                }
              }}
            >
              Apply
            </button>
          </div>
        </div>
      ) : null}
      <div className="mc-next-composer-plus-section">
        <label htmlFor="threaded-composer-knowledge-url">Knowledge URL</label>
        <div className="mc-next-composer-knowledge-url-row">
          <input
            id="threaded-composer-knowledge-url"
            value={knowledgeUrlDraft}
            disabled={composerActionDisabled}
            onChange={(event) => {
              if (!composerActionDisabled) {
                props.onKnowledgeUrlDraftChange?.(event.target.value);
              }
            }}
            placeholder="Attach a URL"
          />
          <select
            value={knowledgeUrlMode}
            disabled={composerActionDisabled}
            aria-label="Knowledge URL mode"
            onChange={(event) => {
              if (!composerActionDisabled) {
                props.onKnowledgeUrlModeChange?.(event.target.value as typeof knowledgeUrlMode);
              }
            }}
          >
            <option value="retrieval">Use retrieval</option>
            <option value="full_text">Read in full</option>
          </select>
          <button
            type="button"
            className="mc-next-composer-inline-button"
            disabled={composerActionDisabled || !knowledgeUrlDraft.trim()}
            onClick={() => {
              if (!composerActionDisabled) {
                props.onAttachKnowledgeUrl?.();
              }
            }}
          >
            Attach source
          </button>
        </div>
      </div>
    </>
  );
}
