import { Schema } from "effect";
import { PublicProfile } from "@ren-ai/personas/public-profile";
import { MobileNumber } from "./shapes.ts";
import disclosure from "./discovery-notice.json" with { type: "json" };
import englishDisclosure from "./discovery-notice.en.json" with { type: "json" };
import japaneseDisclosure from "./discovery-notice.ja.json" with { type: "json" };
import { StartingRelationship } from "./relationship.ts";
import { PublicLanguages } from "@ren-ai/personas/languages";

export const discoveryNotice = disclosure;
export const DiscoveryLocale = Schema.Literals(["ko", "en", "ja"]);
export const discoveryNotices = { ko: disclosure, en: englishDisclosure, ja: japaneseDisclosure };

const text = Schema.String.check(Schema.isNonEmpty());
const id = text.check(Schema.isPattern(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/));
const photo = Schema.String.pipe(
  Schema.refine(
    (value): value is string =>
      value === "" ||
      /^\/discovery\/images\/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\.(?:png|jpg|webp)$/.test(
        value,
      ) ||
      (URL.canParse(value) &&
        (new URL(value).protocol === "https:" ||
          (new URL(value).protocol === "http:" &&
            ["localhost", "127.0.0.1", "[::1]"].includes(new URL(value).hostname)))),
  ),
);

export const PublicPersona = Schema.Struct({
  id,
  name: text,
  age: Schema.optionalKey(Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0))),
  bio: text,
  languages: Schema.optionalKey(PublicLanguages),
  profile: Schema.optionalKey(PublicProfile),
  imageUrl: photo,
  portraits: Schema.optionalKey(
    Schema.Struct({ anime: Schema.optionalKey(photo), photo: Schema.optionalKey(photo) }).check(
      Schema.makeFilter((value) => Boolean(value.anime || value.photo)),
    ),
  ),
  secondaryPortraits: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({ style: Schema.Literals(["anime", "photo"]), imageUrl: photo }),
    ).check(Schema.isMaxLength(10)),
  ),
  portraitGallery: Schema.optionalKey(
    Schema.Array(Schema.Struct({ anime: photo, photo })).check(
      Schema.isMinLength(1),
      Schema.isMaxLength(6),
    ),
  ),
});
export type PublicPersona = typeof PublicPersona.Type;

export const DiscoveryRequest = Schema.Struct({
  handle: MobileNumber,
  locale: DiscoveryLocale,
  conversationLanguage: Schema.optionalKey(DiscoveryLocale),
  startingRelationship: Schema.optionalKey(StartingRelationship),
  name: Schema.optionalKey(text.check(Schema.isTrimmed(), Schema.isMaxLength(100))),
  age: Schema.optionalKey(Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0))),
  gender: Schema.optionalKey(Schema.Literals(["female", "male", "other"])),
  privacyNoticeVersion: text,
  turnstileToken: text,
  reselectionToken: Schema.optionalKey(Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/))),
  likedPersonaIDs: Schema.Array(id).check(Schema.isMinLength(1), Schema.isUnique()),
});
export type DiscoveryRequest = typeof DiscoveryRequest.Type;
export const DiscoveryAnswer = Schema.Struct({ status: Schema.Literals(["waiting", "active"]) });
export type DiscoveryAnswer = typeof DiscoveryAnswer.Type;
