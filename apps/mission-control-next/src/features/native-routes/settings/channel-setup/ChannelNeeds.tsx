import type { ChannelSetupDefinition, ChannelSetupDraft } from "@goatcitadel/contracts";

/** What to have ready before setting a channel up. Both setup guides show it under their summary. */
export function ChannelNeeds({ items, className = "" }: { items?: readonly string[]; className?: string }) {
  // The list comes from the Gateway, so a definition without one gets no list rather than a crash.
  if (!items?.length) return null;
  return (
    <section aria-label="What you need" className={`space-y-1 ${className}`.trim()}>
      <h4 className="text-sm font-medium">What you need</h4>
      <ul className="ml-5 list-disc space-y-0.5 text-sm text-fg-secondary">
        {items.map((item, index) => (
          <li key={index}>{item}</li>
        ))}
      </ul>
    </section>
  );
}

/** Plain text, not an announcement: it says why the setup-only steps are missing when a saved channel is changed. */
export function ChannelEditingNote({
  definition,
  draft,
  className = "",
}: {
  definition: Pick<ChannelSetupDefinition, "catalog">;
  draft: Pick<ChannelSetupDraft, "lifecycleMode" | "label">;
  className?: string;
}) {
  if (draft.lifecycleMode === "create") return null;
  const name = draft.label?.trim() || definition.catalog.label;
  return (
    <p className={`text-sm text-fg-secondary ${className}`.trim()}>
      {`You're changing ${name}. The steps for setting it up are hidden.`}
    </p>
  );
}
