import { PersonaError } from "@ren-ai/personas";
import copy from "./copy.json";

export function readImageCount(form: FormData, maximum: number) {
  const value = form.get("imageCount") ?? "1";
  if (typeof value !== "string") throw new PersonaError("invalid", copy.formError);
  if (!/^[1-6]$/.test(value) || Number(value) > maximum)
    throw new PersonaError("invalid", copy.invalidImageCount);
  return Number(value);
}
