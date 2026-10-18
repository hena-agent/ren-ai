import type { ImageBucket } from "./r2-images.ts";
import { r2Images } from "./r2-images.ts";
import { loggedRequest, operation, validationFailure, requestId } from "./logging.ts";
import type { Log } from "./logging.ts";

export function localImageRequest(request: Request, bucket: ImageBucket, log?: Log) {
  return loggedRequest(
    request,
    async () => {
      if (request.method !== "GET" && request.method !== "HEAD")
        return new Response(null, { status: 404 });
      const filename = new URL(request.url).pathname.slice("/images/".length);
      try {
        const response = await operation("image.read", {}, async () => {
          try {
            return await r2Images(bucket).image(filename);
          } catch (cause) {
            throw validationFailure(
              "Local image read failed",
              { code: "image_read_failed" },
              cause,
            );
          }
        });
        return request.method === "HEAD"
          ? new Response(null, { status: response.status, headers: response.headers })
          : response;
      } catch {
        return Response.json(
          { error: "Image unavailable", requestId: requestId() },
          { status: 503, headers: { "Cache-Control": "no-store" } },
        );
      }
    },
    log,
  );
}
