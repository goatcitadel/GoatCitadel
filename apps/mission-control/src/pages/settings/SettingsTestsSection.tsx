import { FieldHelp } from "../../components/FieldHelp";
import { Panel } from "../../components/Panel";
import { GCSelect, GCSwitch } from "../../components/ui";

export interface ChatPromptPreset {
  id: string;
  label: string;
  prompt: string;
}

export interface SettingsTestsSectionProps {
  chatPromptPresetId: string;
  onChatPromptPresetIdChange: (id: string) => void;
  chatPromptPresets: ChatPromptPreset[];
  chatPrompt: string;
  onChatPromptChange: (value: string) => void;
  chatUseMemory: boolean;
  onChatUseMemoryChange: (value: boolean) => void;
  chatResponse: string;
  onTestChat: () => void;
}

export function SettingsTestsSection(props: SettingsTestsSectionProps) {
  const {
    chatPromptPresetId,
    onChatPromptPresetIdChange,
    chatPromptPresets,
    chatPrompt,
    onChatPromptChange,
    chatUseMemory,
    onChatUseMemoryChange,
    chatResponse,
    onTestChat,
  } = props;

  return (
    <section id="settings-tests" className="settings-v2-section">
      <Panel
        className="settings-v2-panel"
        title="LLM Test (Unified Routing)"
        subtitle="Test prompts run through GoatCitadel's unified LLM entrypoint without QMD memory context, so the response path reflects the provider's actual upstream API style."
      >
        <FieldHelp>
          Use test prompts to prove the active provider/model path before you rely on it elsewhere. This is the fastest
          way to confirm a provider is responding correctly.
        </FieldHelp>
        <div className="controls-row">
          <label htmlFor="chatPromptPreset">Prompt Preset</label>
          <GCSelect
            id="chatPromptPreset"
            value={chatPromptPresetId}
            onChange={(nextPreset) => {
              onChatPromptPresetIdChange(nextPreset);
              const preset = chatPromptPresets.find((item) => item.id === nextPreset);
              if (preset) {
                onChatPromptChange(preset.prompt);
              }
            }}
            options={[
              ...chatPromptPresets.map((preset) => ({
                value: preset.id,
                label: preset.label,
              })),
              { value: "custom", label: "custom" },
            ]}
          />
        </div>
        <textarea
          rows={4}
          className="full-textarea"
          value={chatPrompt}
          onChange={(event) => onChatPromptChange(event.target.value)}
        />
        <div className="controls-row">
          <GCSwitch
            id="chatUseMemory"
            checked={chatUseMemory}
            onCheckedChange={onChatUseMemoryChange}
            label="Include memory context (QMD)"
          />
        </div>
        <div className="controls-row">
          <button type="button" onClick={onTestChat}>
            Run Test Prompt
          </button>
        </div>
        {chatResponse ? <pre>{chatResponse}</pre> : null}
      </Panel>
    </section>
  );
}
