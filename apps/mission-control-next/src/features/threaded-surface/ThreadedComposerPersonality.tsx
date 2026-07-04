import type { MissionThreadedActiveSessionSurfaceProps } from "@goatcitadel/threaded-surface-core";

type ComposerPersonalityView = {
  name: string;
  tone: string;
  scope: string;
  initials: string;
  animated: boolean;
};

export function getComposerPersonality(
  props: MissionThreadedActiveSessionSurfaceProps,
): ComposerPersonalityView | null {
  if (!props.activePersonality) {
    return null;
  }
  const scope = props.activePersonality.scope === "thread_override" ? "Thread override" : "Citadel default";
  return {
    name: props.activePersonality.name,
    tone: props.activePersonality.tone?.trim() || "Conversational presence",
    scope,
    initials: props.activePersonality.avatarLabel?.trim() || getInitials(props.activePersonality.name),
    animated: props.activePersonality.animation === "ambient",
  };
}

function getInitials(value: string): string {
  const words = value
    .split(/\s+/)
    .map((part) => part.trim())
    .filter(Boolean);
  const initials = words
    .slice(0, 2)
    .map((word) => word[0]?.toUpperCase())
    .join("");
  return initials || "AI";
}

export function PersonalityPresenceChip({
  onOpenSettings,
  personality,
}: {
  onOpenSettings?: () => void;
  personality: ComposerPersonalityView;
}) {
  return (
    <button
      type="button"
      className="mc-next-personality-chip"
      disabled={!onOpenSettings}
      onClick={onOpenSettings}
      title="Open Settings > Personalities"
      aria-label={`${personality.name} personality, ${personality.scope}. Open personality settings.`}
    >
      <span
        className="mc-next-personality-avatar"
        data-animated={personality.animated ? "true" : undefined}
        aria-hidden="true"
      >
        <span>{personality.initials}</span>
      </span>
      <span className="mc-next-personality-copy">
        <strong>{personality.name}</strong>
        <span>
          {personality.scope} · {personality.tone}
        </span>
      </span>
    </button>
  );
}
