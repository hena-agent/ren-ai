import { createHmac, timingSafeEqual } from "node:crypto";
import { PersonaError } from "@ren-ai/personas";
import copy from "./copy.json";

export function privateTokens(password: string) {
  const digest = (value: string) => createHmac("sha256", password).update(value).digest();
  return {
    encode: (json: string) => {
      const content = Buffer.from(json).toString("base64url");
      return `${content}.${digest(content).toString("base64url")}`;
    },
    decode: (value: FormDataEntryValue | null) => {
      if (typeof value !== "string") throw new PersonaError("invalid", copy.formError);
      const parts = value.split(".");
      const [content, signature] = parts;
      if (parts.length !== 2 || !content || !signature)
        throw new PersonaError("invalid", copy.formError);
      const actual = Buffer.from(signature, "base64url");
      const expected = digest(content);
      if (actual.length !== expected.length || !timingSafeEqual(actual, expected))
        throw new PersonaError("invalid", copy.formError);
      return Buffer.from(content, "base64url").toString();
    },
  };
}
