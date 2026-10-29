/** The Skills tab. For now it holds only its heading; the installed skills list is added to it in a later change. */
export function SkillsTab() {
  return (
    <section aria-labelledby="capabilities-skills-heading" className="space-y-2">
      <h2 id="capabilities-skills-heading" className="text-lg font-semibold text-fg">
        Skills
      </h2>
      <p className="text-sm text-fg-secondary">The skills GoatCitadel&apos;s AI can use.</p>
    </section>
  );
}
