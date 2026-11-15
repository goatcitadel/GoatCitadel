import { ClassicOwnerLink } from "../../../ui/ClassicOwnerLink";
import { Section } from "../../../ui/Section";

/**
 * Skill evaluation runs (scenarios, a baseline and an improvement run) exist only in the classic view's Library. The
 * panel says so and links there, so a skill's page does not read as if nothing can test it.
 */
export function SkillEvaluationLink({ skillId }: { skillId: string }) {
  return (
    <Section title="Evaluation" headingLevel={3}>
      <p className="text-sm text-fg-secondary">
        Evaluation runs try a skill on test scenarios, a baseline and an improvement run before you rely on it. They are
        only in the classic view.
      </p>
      <ClassicOwnerLink
        href="/library/skills"
        scope={JSON.stringify(["skill-evaluation", skillId])}
        label="Run skill evaluations · classic view"
      />
    </Section>
  );
}
