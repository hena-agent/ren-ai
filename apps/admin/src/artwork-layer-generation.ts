import { Schema } from "effect";
import { createFalClient } from "@fal-ai/client";
import { PersonaError, validatePortrait, type Portrait } from "@ren-ai/personas";
import { privateTokens } from "./private-token.ts";
import { catalogJson } from "./image-model-source.ts";
import {
  artworkLayerModel,
  ArtworkLayerResponse,
  ArtworkLayerSelection,
} from "./artwork-layer-model.ts";
import { GenerationError, operation, protect, validationFailure } from "./logging.ts";
import { networkError } from "./generation-network.ts";
import { artworkLayerSource } from "./artwork-layer-source.ts";

const Pricing = Schema.Struct({
  prices: Schema.Array(
    Schema.Struct({
      endpoint_id: Schema.String,
      unit_price: Schema.Number,
      currency: Schema.String,
    }),
  ),
});
const Ticket = Schema.Struct({ request_id: Schema.String });
const Status = Schema.Struct({ status: Schema.Literals(["IN_QUEUE", "IN_PROGRESS", "COMPLETED"]) });
const direction =
  "Separate the original illustration into aligned transparent layers preserving the exact pose, full canvas, proportions and drawing style. Every visible foreground pixel must belong to its own moving part ONLY: remove original hands, limbs, ornaments and outlines from the background and all unrelated parts. The background must be empty of character pixels. UPPER ARM: shoulder-to-ELBOW. FOREARM: ELBOW-to-WRIST. HAND: wrist, palm and fingers. Split thighs at knees and lower legs at ankles. Reconstruct hidden connections: extend each adjoining part beyond the pivot with a rounded capsule-like end and enough overlap to cover rotation in both directions. Do NOT merely round off or trim visible pixels. Internal hidden ends must have no dark cut-outline, white fringe or rectangular cut edge. Preserve the complete neck and shoulders. Return descriptive English names and correct image coordinates.";

export function createArtworkLayerizer(key: string, password: string, fetcher = fetch) {
  const client = createFalClient({ credentials: key, fetch: fetcher, retry: { maxRetries: 0 } });
  const tokens = privateTokens(password);
  const ready = () => {
    if (!key.trim())
      throw new PersonaError("invalid", "FAL_KEY를 연결해야 레이어를 분리할 수 있습니다.");
  };
  const queuedResult = async (requestId: string) => {
    protect(key);
    // fal accepts endpoint suffixes on submission, but queue reads use owner/app only.
    const app = artworkLayerModel.split("/").slice(0, 2).join("/");
    const path = `https://queue.fal.run/${app}/requests/${encodeURIComponent(requestId)}`;
    const responseJson = async <T>(url: string, codec: Schema.Codec<T>): Promise<T> => {
      const response = await fetcher(url, {
        headers: { Authorization: `Key ${key}` },
        redirect: "manual",
        signal: AbortSignal.timeout(30_000),
      }).catch((cause) => {
        throw networkError(cause, artworkLayerModel, [key]);
      });
      if (!response.ok)
        throw new GenerationError("Layer result request failed", {
          model: artworkLayerModel,
          code: "http_error",
          status: response.status,
        });
      return Schema.decodeUnknownSync(codec)(await response.json());
    };
    for (let attempt = 0; attempt < 120; attempt++) {
      const status = await responseJson(`${path}/status`, Status);
      if (status.status === "COMPLETED") {
        const result = await responseJson(path, ArtworkLayerResponse);
        const layers = result.layers.toSorted((a, b) => a.z_index - b.z_index);
        if (
          layers[0]!.z_index !== 0 ||
          new Set(layers.map((layer) => layer.z_index)).size !== layers.length
        )
          throw new Error("Invalid layer order");
        protect(...layers.map((layer) => layer.image.url));
        return { layers };
      }
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }
    throw new GenerationError("Layer result is still pending; resume the saved request", {
      code: "layer_result_pending",
    });
  };
  return {
    options: async (sourceOperationId: string) => {
      ready();
      const params = new URLSearchParams({ endpoint_id: artworkLayerModel });
      const result = await catalogJson(
        `https://api.fal.ai/v1/models/pricing?${params}`,
        Pricing,
        fetcher,
        key,
      );
      const price = result.prices.find((entry) => entry.endpoint_id === artworkLayerModel);
      if (!price || price.unit_price <= 0)
        throw new PersonaError(
          "invalid",
          "레이어 분리 단가를 확인할 수 없습니다. 잠시 후 다시 시도해 주세요.",
        );
      const selection: ArtworkLayerSelection = {
        model: artworkLayerModel,
        sourceOperationId,
        resolution: "auto_1.5K",
        price: `${price.currency} ${price.unit_price} / 레이어 · 최대 17개 · 출력 픽셀 수에 따라 단가가 2배일 수 있습니다`,
        observedAt: Date.now(),
      };
      return { selection, quote: tokens.encode(JSON.stringify(selection)) };
    },
    selected: (quote: FormDataEntryValue | null, sourceOperationId: string) => {
      const selection = Schema.decodeUnknownSync(ArtworkLayerSelection)(
        JSON.parse(tokens.decode(quote)),
      );
      if (selection.sourceOperationId !== sourceOperationId)
        throw new PersonaError(
          "invalid",
          "원화가 변경되었습니다. 레이어 분리 옵션을 다시 확인하세요.",
        );
      return selection;
    },
    generate: async (
      selection: ArtworkLayerSelection,
      instructions: string,
      reference: Portrait,
      checkpoint?: (requestId: string) => Promise<void>,
      target: "body" | "outfit" = "body",
    ) => {
      ready();
      validatePortrait(reference);
      const image = `data:${reference.mimeType};base64,${Buffer.from(reference.bytes).toString("base64")}`;
      const task =
        target === "body"
          ? "This is the underwear base body. Separate anatomical parts and preserve plain opaque underwear. Do not invent outer clothing or accessories."
          : "This is a clothing-only overlay. Return ONLY garments and accessories; no skin, body, face, hair, underwear or ghost silhouettes. Split arm sleeves, wrist ornaments and leg garments at their corresponding joints. Give sleeves and other cloth crossing joints hidden rounded overlapping extensions, and name each piece by its anatomical attachment (upper arm, forearm, hand, thigh, shin, foot, torso). Keep the complete skirt on the torso; never leave detached ornaments on a background layer.";
      const prompt = `${direction}\nRecombining all layers must reconstruct the complete original at rest, with hidden extensions covered by adjacent parts.\n${task}\nOptional instructions:\n${instructions}`;
      const secrets = [key, instructions, image, prompt];
      protect(...secrets);
      return operation(
        "rig.layers.generate",
        { model: artworkLayerModel, style: "anime" },
        async () => {
          let response: Response;
          try {
            const sourceUrl = await client.storage.upload(
              new Blob([new Uint8Array(artworkLayerSource(reference.bytes))], {
                type: "image/jpeg",
              }),
              { lifecycle: { expiresIn: "1d" } },
            );
            protect(sourceUrl);
            response = await fetcher(`https://queue.fal.run/${artworkLayerModel}`, {
              method: "POST",
              headers: { Authorization: `Key ${key}`, "Content-Type": "application/json" },
              body: JSON.stringify({
                image_url: sourceUrl,
                prompt,
                image_size: selection.resolution,
                output_format: "png",
                sync_mode: false,
              }),
              redirect: "manual",
              signal: AbortSignal.timeout(30_000),
            });
          } catch (cause) {
            throw networkError(cause, artworkLayerModel, secrets);
          }
          if (!response.ok)
            throw new GenerationError("Layer provider request failed", {
              model: artworkLayerModel,
              code: "http_error",
              status: response.status,
            });
          try {
            const ticket = Schema.decodeUnknownSync(Ticket)(await response.json());
            await checkpoint?.(ticket.request_id);
            return await queuedResult(ticket.request_id);
          } catch (cause) {
            if (cause instanceof GenerationError) throw cause;
            throw validationFailure(
              "Invalid layer provider response",
              { model: artworkLayerModel, code: "invalid_response" },
              cause,
            );
          }
        },
      );
    },
    resume: (requestId: string) =>
      operation("rig.layers.recover", { model: artworkLayerModel }, async () => {
        try {
          return await queuedResult(requestId);
        } catch (cause) {
          if (cause instanceof GenerationError) throw cause;
          throw validationFailure(
            "Invalid layer recovery response",
            { model: artworkLayerModel, code: "invalid_response" },
            cause,
          );
        }
      }),
    download: async (url: string): Promise<Portrait> =>
      operation("rig.layers.download", { model: artworkLayerModel }, async () => {
        protect(url);
        const target = new URL(url);
        if (
          target.protocol !== "https:" ||
          !target.hostname.endsWith(".fal.media") ||
          target.username ||
          target.password
        )
          throw new GenerationError("Invalid layer image host", { code: "invalid_image_url" });
        let response: Response;
        try {
          response = await fetcher(target, {
            redirect: "manual",
            signal: AbortSignal.timeout(60_000),
          });
        } catch (cause) {
          throw networkError(cause, artworkLayerModel, [key, url]);
        }
        if (!response.ok)
          throw new GenerationError("Layer image download failed", {
            code: "image_http_error",
            status: response.status,
          });
        try {
          const image: Portrait = {
            bytes: new Uint8Array(await response.arrayBuffer()),
            mimeType: "image/png",
          };
          validatePortrait(image);
          return image;
        } catch (cause) {
          throw validationFailure(
            "Invalid layer image response",
            { code: "invalid_layer_image" },
            cause,
          );
        }
      }),
  };
}
export type ArtworkLayerizer = ReturnType<typeof createArtworkLayerizer>;
