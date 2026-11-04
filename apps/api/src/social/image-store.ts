import { Schema } from "effect";
import { SocialImage } from "@ren-ai/onboarding/social-images";
import type { SocialStore } from "./store.ts";

export type ImageRow = {
  id: string;
  account_id: string;
  persona_id: string;
  generation: number;
  run_id: string;
  step: number;
  data: string;
  scene: string;
  state: string;
  due: number | null;
  seen_run: string | null;
  paid: number;
};
export const decodeImage = (row: ImageRow) =>
  Schema.decodeUnknownSync(Schema.fromJsonString(SocialImage))(row.data);
export function imageStore(store: SocialStore) {
  return {
    row: (id: string) => store.exec<ImageRow>("SELECT * FROM social_image WHERE id=?", id)[0],
    latest: (account: string, generation: number) =>
      store
        .exec<ImageRow>(
          "SELECT * FROM social_image WHERE account_id=? AND generation=? ORDER BY rowid DESC LIMIT 6",
          account,
          generation,
        )
        .map(decodeImage),
    snapshot: () =>
      store
        .exec<ImageRow>("SELECT * FROM social_image ORDER BY rowid DESC LIMIT 50")
        .map(decodeImage),
    save: (row: ImageRow, image: SocialImage, due: number | null) =>
      store.exec(
        "UPDATE social_image SET data=?,state=?,due=? WHERE id=?",
        JSON.stringify(image),
        image.state,
        due,
        row.id,
      ),
    spent: (account: string) =>
      store.exec<{ spent: number }>(
        "SELECT spent FROM social_image_budget WHERE account_id=?",
        account,
      )[0]?.spent ?? 0,
    globalSpent: () =>
      store.exec<{ spent: number }>("SELECT spent FROM social_image_global_budget WHERE id=1")[0]!
        .spent,
    globalApproved: () =>
      store.exec<{ approved: number }>(
        "SELECT approved FROM social_image_global_budget WHERE id=1",
      )[0]!.approved,
  };
}
