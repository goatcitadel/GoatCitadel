/** "GoatCitadel Inbox", "GoatCitadel Settings · Models": the same prefix the classic shell uses. */
export function cockpitDocumentTitle(areaLabel: string, section?: string): string {
  const sectionLabel = section ? humanizeSection(section) : "";
  return sectionLabel ? `GoatCitadel ${areaLabel} · ${sectionLabel}` : `GoatCitadel ${areaLabel}`;
}

function humanizeSection(section: string): string {
  const words = decodeURIComponent(section).replace(/[-_]+/g, " ").trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : "";
}
