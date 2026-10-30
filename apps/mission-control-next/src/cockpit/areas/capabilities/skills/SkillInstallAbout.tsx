import { findShippedSkillPack, type CapabilitySkillInstall } from "@goatcitadel/contracts";
import { Section } from "../../../ui/Section";
import { TechnicalDetails } from "../../../ui/TechnicalDetails";
import { blockerLines } from "./skill-check-copy";
import { asksForLines, SKIP_OFF_NEXT, SKIP_ON_NEXT } from "./skill-install-view";

/** Where the checked skill comes from: one of GoatCitadel's packs with its program and origin, or a Git host. */
function SourceLines({ install }: { install: CapabilitySkillInstall }) {
  const { source } = install;
  if (source.kind === "git") {
    return (
      <>
        <p>{source.host ? `A Git repository on ${source.host}` : "A Git repository"}</p>
        <TechnicalDetails>
          <p className="font-mono">{source.sourceRef}</p>
          {source.commit ? <p className="font-mono">{source.commit}</p> : null}
        </TechnicalDetails>
      </>
    );
  }
  const pack = findShippedSkillPack(source.packId);
  return (
    <>
      <p>A skill pack that ships with GoatCitadel</p>
      {pack ? (
        <>
          <p>
            Needs the{" "}
            <a
              href={pack.setupUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-accent underline-offset-2 hover:underline"
            >
              {pack.requiresCli}
            </a>{" "}
            program on the computer running GoatCitadel.
          </p>
          <p>
            Adapted from {pack.upstream} ({pack.license})
          </p>
        </>
      ) : null}
    </>
  );
}

/** What GoatCitadel's checks found: passed, or one plain line per reason it can't be installed. */
function CheckLines({ install }: { install: CapabilitySkillInstall }) {
  if (install.step !== "blocked") return <p>Passed GoatCitadel&apos;s checks</p>;
  return (
    <>
      <ul className="space-y-1">
        {blockerLines(install.blockers).map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
      {install.blockers.length > 0 ? (
        <TechnicalDetails label="Show details">
          <p className="font-mono">{install.blockers.join(", ")}</p>
        </TechnicalDetails>
      ) : null}
    </>
  );
}

/**
 * What the operator judges before installing a checked skill: what it does (when the source says), where it comes
 * from, what it asks for, what GoatCitadel's checks found and, while it can still be installed, what happens next.
 * `skip` is the operator's setting to skip approvals for their own changes; unknown (it couldn't be read) leaves the
 * last line out.
 */
export function SkillInstallAbout({ install, skip }: { install: CapabilitySkillInstall; skip: boolean | undefined }) {
  return (
    <div className="space-y-4 text-sm text-fg-secondary">
      {install.description ? (
        <Section title="What it does" headingLevel={3}>
          <p>{install.description}</p>
        </Section>
      ) : null}
      <Section title="Where it comes from" headingLevel={3}>
        <div className="space-y-1">
          <SourceLines install={install} />
        </div>
      </Section>
      <Section title="What it asks for" headingLevel={3}>
        <ul className="space-y-1">
          {asksForLines(install.asksFor).map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      </Section>
      <Section title="Checks" headingLevel={3}>
        <div className="space-y-1">
          <CheckLines install={install} />
        </div>
      </Section>
      {install.step === "check_passed" && skip !== undefined ? (
        <Section title="What happens next" headingLevel={3}>
          <p>{skip ? SKIP_ON_NEXT : SKIP_OFF_NEXT}</p>
        </Section>
      ) : null}
    </div>
  );
}
