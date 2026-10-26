import assert from "node:assert/strict";
import { Schema } from "effect";

/** @param {ReadonlyArray<{ messages: readonly Schema.Json[], tools?: readonly { function: { name: string } }[] | undefined }>} requests */
export function assertPhotoRequests(requests) {
  const photos = requests.filter((body) =>
    JSON.stringify(body.messages).includes("compiled-case:10"),
  );
  assert(photos.length >= 2, "Taking a photo must continue to a model call with its result");
  for (const body of photos) {
    const names = body.tools?.map((tool) => tool.function.name) ?? [];
    assert(names.includes("take_photo") && names.includes("send_photo"));
    assert(!names.includes("execute"), "Photo tools must stay outside Code Mode");
  }
  const photoPart = Schema.Struct({
    type: Schema.Literal("image_url"),
    image_url: Schema.Struct({ url: Schema.String }),
  });
  const message = Schema.Struct({ content: Schema.Array(Schema.Json) });
  const images = photos
    .flatMap((body) => body.messages)
    .filter(Schema.is(message))
    .flatMap((entry) => entry.content)
    .filter(Schema.is(photoPart));
  assert(
    images.some((image) => image.image_url.url.startsWith("data:image/jpeg;base64,")),
    "The compiled take_photo result must reach the provider as an image, not raw JSON",
  );
  assert(JSON.stringify(photos).includes("compiled-photo"));
  assert(JSON.stringify(photos).includes("123456"));
  assert(!JSON.stringify(photos).includes("could not be decoded"));
}
