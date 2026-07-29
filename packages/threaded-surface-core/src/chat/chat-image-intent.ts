const IMAGE_CREATION_VERB = /\b(?:create|generate|make|draw|render|produce|design|paint|illustrate|sketch)\b/i;
const IMAGE_CREATION_WITH_NOUN =
  /\b(?:create|generate|make|draw|render|produce|design|paint|illustrate|sketch)\s+(?:me\s+)?(?:(?:an?|the|some)\s+)?(?:(?!(?:of|about|for|from|with|this|that|these|those)\b)[\w-]+\s+){0,4}(?:image|picture|pic|photo|illustration|drawing|artwork|poster|wallpaper|avatar|logo|icon|sticker|banner|cover|thumbnail|scene|visual)\b/i;
const IMAGE_OF_REQUEST =
  /\b(?:image|picture|pic|photo|illustration|drawing|artwork|poster|wallpaper|avatar|logo|icon|sticker|banner|cover|thumbnail|scene|visual)\s+of\b/i;
const SHOW_ME_IMAGE_REQUEST =
  /\bshow\s+(?:me\s+)?(?:an?\s+|the\s+|some\s+)?(?:image|picture|pic|photo|illustration|drawing|artwork|poster|wallpaper|avatar|logo|icon|sticker|banner|cover|thumbnail|scene|visual)\s+of\b/i;
const DIRECT_DRAW_SUBJECT_REQUEST =
  /^(?:(?:please|kindly)\s+|(?:(?:can|could|would|will)\s+you\s+)(?:please\s+)?)?(?:draw|paint|sketch|illustrate)\s+(?:me\s+)?(?:an?\s+|the\s+|some\s+)?\w+/i;
const QUESTION_ABOUT_IMAGE_CREATION = /^\s*(?:how|what|why|when|where)\b/i;
const TEXT_ARTIFACT_ABOUT_IMAGES =
  /\b(?:prompt|caption|alt text|description|writeup|markdown|html|code)\b.{0,48}\b(?:image|picture|pic|photo|illustration|drawing|artwork|poster|wallpaper|avatar|logo|icon|sticker|banner|cover|thumbnail|scene|visual)\b|\b(?:image|picture|pic|photo|illustration|drawing|artwork|poster|wallpaper|avatar|logo|icon|sticker|banner|cover|thumbnail|scene|visual)\b.{0,48}\b(?:prompt|caption|alt text|description|writeup|markdown|html|code)\b/i;
const SEARCH_OR_ANALYSIS_REQUEST =
  /\b(?:find|search|research|look\s+up|download|open|save|analy[sz]e|review|describe|caption|ocr|transcribe|classify|plan|teach|learn|tutorial|instructions?)\b/i;
const SOFTWARE_IMAGE_FEATURE_REQUEST =
  /\bimage\s+(?:api|button|carousel|component|download|file|generation|model|pipeline|preview|prompt|route|tool|upload|viewer)\b/i;
const NON_VISUAL_DRAW_REQUEST = /\bdraw\s+(?:a\s+)?(?:conclusion|conclusions|comparison|line|boundary|attention)\b/i;

export function detectImageGenerationIntent(draft: string): boolean {
  const normalized = draft.trim().replace(/\s+/g, " ");
  if (!normalized || normalized.startsWith("/")) {
    return false;
  }

  if (QUESTION_ABOUT_IMAGE_CREATION.test(normalized)) {
    return false;
  }

  if (TEXT_ARTIFACT_ABOUT_IMAGES.test(normalized)) {
    return false;
  }

  if (SEARCH_OR_ANALYSIS_REQUEST.test(normalized)) {
    return false;
  }

  if (SOFTWARE_IMAGE_FEATURE_REQUEST.test(normalized) && !IMAGE_OF_REQUEST.test(normalized)) {
    return false;
  }

  if (SHOW_ME_IMAGE_REQUEST.test(normalized)) {
    return true;
  }

  if (IMAGE_OF_REQUEST.test(normalized) && !SEARCH_OR_ANALYSIS_REQUEST.test(normalized)) {
    return true;
  }

  if (IMAGE_CREATION_VERB.test(normalized) && IMAGE_CREATION_WITH_NOUN.test(normalized)) {
    return true;
  }

  return DIRECT_DRAW_SUBJECT_REQUEST.test(normalized) && !NON_VISUAL_DRAW_REQUEST.test(normalized);
}
