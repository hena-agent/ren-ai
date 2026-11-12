import { validatePortrait, type Portrait } from "@ren-ai/personas";
import { GenerationError, operation, protect, validationFailure } from "./logging.ts";
import { networkError } from "./generation-network.ts";
import { rigArtworkDirection, rigOutfitDirection } from "./rig-artwork-models.ts";
import {
  imageProviders,
  imageModelId,
  type ImageConnections,
  type ImageModelSelection,
} from "./image-model.ts";
import { imageModelRequest } from "./image-model-request.ts";
import { imageModelResponse } from "./image-model-response.ts";
import { rigFaceDirection } from "./rig-face-generation.ts";

export type RigArtworkGenerator = (
  model: ImageModelSelection,
  description: string,
  instructions: string,
  reference: Portrait,
  target?: "body" | "outfit" | "face",
) => Promise<Portrait>;

export function createRigArtworkGenerator(
  connections: ImageConnections,
  fetcher = fetch,
): RigArtworkGenerator {
  return (selection, description, instructions, reference, target = "body") => {
    const model = imageModelId(selection.provider, selection.model);
    const key = connections[selection.provider];
    const direction =
      target === "face"
        ? rigFaceDirection
        : target === "outfit"
          ? rigOutfitDirection
          : rigArtworkDirection;
    const prompt = `${direction}\n\nCHARACTER:\n${description}\n\nOPTIONAL OPERATOR REQUEST:\n${instructions}`;
    const encodedReference = Buffer.from(reference.bytes).toString("base64");
    const secrets = [
      key,
      description,
      instructions,
      prompt,
      encodedReference,
      `data:${reference.mimeType};base64,${encodedReference}`,
    ];
    protect(...secrets);
    return operation("rig.artwork.generate", { model, style: "anime" }, async () => {
      if (!key.trim())
        throw new GenerationError(`${imageProviders[selection.provider].key} is required`, {
          model,
          code: "missing_key",
        });
      validatePortrait(reference);
      const request = imageModelRequest(selection, key, prompt, reference);
      let response: Response;
      try {
        response = await fetcher(request.url, {
          method: "POST",
          headers: request.headers,
          body: request.body,
          redirect: "manual",
          signal: AbortSignal.timeout(120_000),
        });
      } catch (cause) {
        throw networkError(cause, model, secrets);
      }
      if (!response.ok)
        throw new GenerationError("Artwork provider request failed", {
          model,
          status: response.status,
          code: "http_error",
        });
      try {
        return await imageModelResponse(response, selection.provider, selection.outputFormat);
      } catch (cause) {
        throw validationFailure(
          "Invalid artwork provider response",
          { model, code: "invalid_response" },
          cause,
        );
      }
    });
  };
}
