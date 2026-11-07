import { transcribeVoice } from "@goatcitadel/mission-control-shared/api/client";
import { fileToBase64 } from "../settings-page-utils";

export async function transcribeAudioFile(file: File, isCurrent: () => boolean = () => true): Promise<string> {
  if (!isCurrent()) return "";
  const bytesBase64 = await fileToBase64(file);
  if (!isCurrent()) return "";
  const result = await transcribeVoice({ bytesBase64, mimeType: file.type || "audio/wav" });
  return result.text;
}
