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
