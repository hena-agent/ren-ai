import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { AbsolutePath, Agent, Model } from "@opencode/schema";
import { Effect } from "effect";
import { expect, test } from "vitest";
import { localOpenCode } from "../../test/server.test-helper.ts";
import { messagingFixture, runMessagingTest } from "../../test/messaging.test-helper.ts";
import { ordinaryProjectHost } from "../../test/messaging-host.test-helper.ts";

test("the persona plugin does not rewrite an unrelated project's persona-named agent or model context", async () => {
  const { root, personaDirectory } = await messagingFixture("plugin-location-");
  const otherDirectory = join(root, "other-project");
  const agents = join(otherDirectory, ".opencode", "agents");
  await mkdir(agents, { recursive: true });
  await writeFile(
    join(agents, "persona1.md"),
    "---\ndescription: Ordinary project persona\nmode: primary\n---\nA native unrelated persona.",
  );
  try {
    await runMessagingTest(
      Effect.gen(function* () {
        const { llm, native } = yield* ordinaryProjectHost(root, personaDirectory);
        const remote = yield* localOpenCode(native, otherDirectory);
        const session = yield* remote.client.session.create({
          agent: Agent.ID.make("persona1"),
          model: Model.Ref.parse("test/probe"),
          location: { directory: AbsolutePath.make(otherDirectory) },
          permissions: [{ action: "*", resource: "*", effect: "allow" }],
        });
        yield* remote.sessions.prompt({
          sessionID: session.id,
          text: "ordinary work outside the persona location",
        });
        yield* remote.sessions.wait(session.id).pipe(Effect.timeout("5 seconds"));
        const requests = yield* llm.requests();
        expect(requests).not.toHaveLength(0);
        expect(JSON.stringify(requests)).not.toContain("You are Persona1.");
        expect(JSON.stringify(requests)).toContain("A native unrelated persona.");
        expect(requests.some((request) => request.tools.length > 0)).toBe(true);
      }),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
