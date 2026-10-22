import { Schema } from "effect";

export const StartingRelationship = Schema.Literals(["dating", "flirting", "friends", "strangers"]);
export type StartingRelationship = typeof StartingRelationship.Type;
