import { providerFailure } from "@ren-ai/image-generation";
import { GenerationError } from "./logging.ts";

// oxlint-disable-next-line typescript/no-restricted-types -- trust boundary: narrow fetch failures, including their underlying transport cause
export function networkError(cause: unknown, model: string, secrets: readonly string[]) {
  const failure = providerFailure(cause, model, secrets);
  return Object.assign(new GenerationError(failure.message, failure.fields), {
    stack: failure.stack,
  });
}
