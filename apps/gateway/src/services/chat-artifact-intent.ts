/** Ignore negative constraints when looking for an affirmative artifact request.
 * In particular, "report the title; do not write memory" is not a file request. */
function artifactRequestProse(content: string): string {
  return content
    .toLowerCase()
    .replace(/\b(?:do\s+not|don't|don’t|never|without|avoid|no)\b[^.;!?\n]*(?:[.;!?]|$)/gu, " ");
}

export function forbidsArtifactWrites(content: string): boolean {
  return (
    /\b(?:do\s+not|don't|don’t|never|without|avoid)\b[^.;!?\n]*\b(?:create|creating|write|writing|save|saving|change|changing|modify|modifying|generate|generating|export|exporting)\b[^.;!?\n]*\b(?:files?|artifacts?|documents?|decks?|pdfs?|docx|pptx)\b/iu.test(
      content,
    ) || /\bno\s+(?:new\s+)?(?:files?|artifacts?|downloads?)\b/iu.test(content)
  );
}

export function detectDocumentArtifactIntent(content: string): boolean {
  if (forbidsArtifactWrites(content)) return false;
  const prose = artifactRequestProse(content);
  if (hasArtifactInspectionOnlyIntent(prose)) return false;
  if (
    /\b(?:directly|only|just)\s+(?:in\s+)?(?:this\s+)?(?:chat|answer|response)\b|\b(?:inline|in[- ]chat)\b/u.test(prose)
  )
    return false;
  // Presentation formats alone are not persistence intent. A document-only
  // format, explicit file delivery, or an output filename is required.
  return artifactRequestObjects(prose).some(
    ({ verb, object }) =>
      /\b(?:docx?|word\s+doc(?:ument)?|pdf|(?:markdown|md|html|csv|json|text|txt)\s+file|downloadable\s+(?:report|document|file)|file|[\w-]+\.(?:md|txt|csv|json|html?))\b/u.test(
        object,
      ) ||
      (/^(?:save|export|download)$/u.test(verb) &&
        /\b(?:report|brief|memo|handout|worksheet|document|markdown|csv|json|html|text)\b/u.test(object)),
  );
}

export function detectPresentationArtifactIntent(content: string): boolean {
  if (forbidsArtifactWrites(content)) return false;
  const prose = artifactRequestProse(content);
  if (hasArtifactInspectionOnlyIntent(prose)) return false;
  if (
    /\b(?:outline|slide\s+titles?|talking\s+points?)\b/u.test(prose) &&
    !/\b(?:file|download|pptx|powerpoint|export|save)\b/u.test(prose)
  )
    return false;
  return artifactRequestObjects(prose).some(({ object }) =>
    /\b(?:power\s?point|pptx?|(?:slide|pitch|investor|presentation)\s+deck|slides?|presentation)\b/u.test(object),
  );
}

function artifactRequestObjects(prose: string): Array<{ verb: string; object: string }> {
  // Input names in "write a summary of report.pdf" describe the source. Check
  // the requested output before its subject/source phrase, while permitting
  // another explicit creation request later in the same sentence.
  return [
    ...prose.matchAll(
      /\b(create|make|build|generate|put|turn|convert|export|save|write|produce|deliver|present|download)\b/gu,
    ),
  ].map((match) => ({
    verb: match[1]!,
    object:
      prose
        .slice(match.index! + match[0].length)
        .split(/[;!?\n]|\.(?:\s|$)|\b(?:about|from|based on|using|of)\b/u)[0] ?? "",
  }));
}

/** File formats and names identify inputs as well as outputs. An inspection
 * request alone must not synthesize a file-writing tool or artifact obligation. */
export function hasArtifactInspectionOnlyIntent(content: string): boolean {
  const prose = content
    .toLowerCase()
    .replace(/(["'`])[^"'`\r\n]*\.(?:pdf|docx?|pptx?|txt|md|markdown|csv|json|html?)\1/gu, " ")
    .replace(/\S+/gu, (token) =>
      /\.(?:pdf|docx?|pptx?|txt|md|markdown|csv|json|html?)(?=$|[.,;:!?)\]])/u.test(token) ? " " : token,
    );
  const inspection =
    /\b(?:read|inspect|review|summari[sz]e|explain|analy[sz]e|compare|describe|check|parse|validate|open)\b/u.test(
      prose,
    );
  const creation = /\b(?:create|make|build|generate|put|turn|convert|export|save|write|produce|deliver|format)\b/u.test(
    prose,
  );
  return inspection && !creation;
}
