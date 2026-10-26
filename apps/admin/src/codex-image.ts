import {
  codexImage as generateImage,
  codexImageModel,
  ImageGenerationError,
} from "@ren-ai/image-generation";
import type { Portrait } from "@ren-ai/personas";
import { GenerationError, operation, protect } from "./logging.ts";
import { reserveGeneration } from "./seeding-budget.ts";

export async function codexImage({
  key,
  prompt,
  references,
  format,
  style,
  fetcher,
}: {
  key: string;
  prompt: string;
  references: readonly Portrait[];
  format: "sheet" | "image";
  style: string;
  fetcher: typeof fetch;
}): Promise<Portrait> {
  return operation("generation.api", { model: codexImageModel, style }, async () => {
    protect(
      key,
      prompt,
      ...references.map((reference) => Buffer.from(reference.bytes).toString("base64")),
    );
    return generateImage({
      key,
      prompt,
      references,
      size: format === "sheet" ? "1536x1024" : "1024x1280",
      outputFormat: "png",
      fetcher,
      beforeDispatch: () => reserveGeneration(codexImageModel, prompt, references.length),
    }).catch((cause) => {
      if (cause instanceof ImageGenerationError)
        throw Object.assign(new GenerationError(cause.message, cause.fields), { cause });
      throw cause;
    });
  });
}
