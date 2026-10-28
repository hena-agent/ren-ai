import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Schema, type JsonSchema } from "effect";
import { isDeepStrictEqual } from "node:util";
import { readSessionBinding } from "./bindings.ts";
import { absent, commitMemory, recoverMemory } from "./memory-commit.ts";
import { lockedMemory } from "./memory-files.ts";
import {
  adjustmentSnapshot,
  adjustmentState,
  adjustmentTool,
  emptyAdjustments,
} from "./adjustment-model.ts";

export { adjustmentTool };
export { appendAdjustmentInstructions } from "./adjustment-instructions.ts";
const fingerprint = (text: string) => createHash("sha256").update(text).digest("hex");
const day = 24 * 60 * 60 * 1000;

// Callers hold the persona lock, shared with Memory, folder export and lifecycle operations.
export async function readAdjustments(directory: string) {
  await recoverMemory(directory);
  const [markdown, state] = await Promise.all([
    readFile(join(directory, "ADJUSTMENTS.md"), "utf8").catch(absent),
    readFile(join(directory, ".memory", "adjustments.json"), "utf8").catch(absent),
  ]);
  if (markdown === undefined && state === undefined) return undefined;
  try {
    return Schema.decodeUnknownSync(adjustmentSnapshot)({
      markdown: markdown ?? "",
      state:
        state === undefined
          ? emptyAdjustments().state
          : Schema.decodeUnknownSync(Schema.fromJsonString(adjustmentState))(state),
    });
  } catch (cause) {
    throw new Error("Invalid Persona adjustment files", { cause });
  }
}

export const writeAdjustments = async (
  directory: string,
  snapshot: typeof adjustmentSnapshot.Type,
) => {
  const current = await readFile(join(directory, "ADJUSTMENTS.md"), "utf8").catch(absent);
  await commitMemory(directory, [
    ...(snapshot.markdown !== (current ?? "")
      ? [{ name: "ADJUSTMENTS.md", text: snapshot.markdown || null }]
      : []),
    { name: ".memory/adjustments.json", text: JSON.stringify(snapshot.state) },
  ]);
};

export const isAdjustmentTool = (
  tool: { description: string; input: JsonSchema.JsonSchema } | undefined,
) =>
  tool?.description === adjustmentTool.description &&
  isDeepStrictEqual(
    tool.input,
    Schema.toStandardJSONSchemaV1(Schema.toStandardSchemaV1(adjustmentTool.input))[
      "~standard"
    ].jsonSchema.input({ target: "draft-2020-12" }),
  );

function reviewContext(
  snapshot: typeof adjustmentSnapshot.Type,
  sessionID: string,
  allowReview: boolean,
) {
  const { review } = snapshot.state;
  return {
    markdown: snapshot.markdown,
    review:
      allowReview && review?.sessionID === sessionID
        ? `<adjustment-review reviewID="${review.id}">\nOccasionally review the recent exchanges visible in THIS Conversation and your current adjustments. Learn both from successful exchanges and recurring difficulties. Preserve your personality, distinctive voice and values. Aim for natural reciprocity AND conversation people want to continue, not message volume or prolonging a goodbye. Silence alone proves nothing. Use review_adjustments once to replace only the concise persona-wide conversation-method adjustments, or markdown: null if no change is warranted. Keep all user details and relationship-specific preferences in Relationship memory, out of both adjustments and reason. Do this internally without sending a review or announcing it to the user; then continue the conversation normally.\n</adjustment-review>`
        : "",
  };
}

export const personaAdjustments = (directory: string, sessionID: string) => ({
  context: (latestMessageID?: string, now = Date.now()) =>
    lockedMemory(directory, async () => {
      const binding = await readSessionBinding(directory, sessionID);
      const snapshot = (await readAdjustments(directory)) ?? emptyAdjustments();
      const previous = JSON.stringify(snapshot);
      let state = snapshot.state;
      if (binding.writable && latestMessageID) {
        if (state.seen[sessionID] !== latestMessageID)
          state = {
            ...state,
            reviewedAt: state.reviewedAt || now,
            observed: state.observed + 1,
            seen: { ...state.seen, [sessionID]: latestMessageID },
          };
        if (
          state.observed - state.reviewed >= 20 &&
          now - state.reviewedAt >= day &&
          (!state.review || state.review.expiresAt <= now)
        )
          state = {
            ...state,
            review: {
              id: randomUUID(),
              sessionID,
              expiresAt: now + 10 * 60 * 1000,
              through: state.observed,
              fingerprint: fingerprint(snapshot.markdown),
            },
          };
      }
      const next = { ...snapshot, state };
      if (JSON.stringify(next) !== previous) await writeAdjustments(directory, next);
      return reviewContext(next, sessionID, binding.writable && latestMessageID !== undefined);
    }),
  // oxlint-disable-next-line typescript/no-restricted-types -- trust boundary: model-authored tool input
  run: async (input: unknown, callID: string, now = Date.now()) => {
    let action: typeof adjustmentTool.input.Type;
    try {
      action = Schema.decodeUnknownSync(adjustmentTool.input)(input, {
        onExcessProperty: "error",
      });
    } catch (cause) {
      throw new Error("Invalid adjustment tool input", { cause });
    }
    return lockedMemory(directory, async () => {
      const binding = await readSessionBinding(directory, sessionID);
      const snapshot = (await readAdjustments(directory)) ?? emptyAdjustments();
      const id = `${sessionID}:${callID}`;
      const inputHash = fingerprint(JSON.stringify(action));
      const prior = snapshot.state.receipts[id];
      if (prior) {
        if (prior.inputHash !== inputHash) throw new Error("Adjustment call input changed");
        return prior.output;
      }
      if (!binding.writable) throw new Error("This session is read-only");
      const { review, ...rest } = snapshot.state;
      if (
        !review ||
        review.id !== action.reviewID ||
        review.sessionID !== sessionID ||
        review.expiresAt <= now ||
        review.fingerprint !== fingerprint(snapshot.markdown)
      )
        throw Object.assign(
          new Error("Adjustment review expired or changed; use the current review context"),
          {
            code: "ADJUSTMENT_REVIEW_CONFLICT",
          },
        );
      const markdown = action.markdown ?? snapshot.markdown;
      const output =
        markdown === snapshot.markdown ? "Adjustments unchanged" : "Adjustments updated";
      await writeAdjustments(directory, {
        markdown,
        state: {
          ...rest,
          reviewedAt: now,
          reviewed: review.through,
          history: [
            ...rest.history,
            { at: now, before: snapshot.markdown, after: markdown, reason: action.reason },
          ],
          receipts: { ...rest.receipts, [id]: { inputHash, output } },
        },
      });
      return output;
    });
  },
});
