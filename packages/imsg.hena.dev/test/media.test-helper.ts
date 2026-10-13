import { Effect, FileSystem, Layer } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

export const mediaFixtures = (jpeg = Buffer.from("jpeg")) => {
  const commands: string[][] = [];
  const files = FileSystem.layerNoop({
    readFile: (path) => Effect.succeed(path.endsWith("photo.jpeg") ? jpeg : Buffer.from("raw")),
    makeTempDirectoryScoped: () => Effect.succeed("/test-temp"),
  });
  const process = ChildProcessSpawner.ChildProcessSpawner.of({
    ...ChildProcessSpawner.make(() => Effect.die("unexpected spawn")),
    string: (command) =>
      Effect.sync(() => {
        if (!ChildProcess.isStandardCommand(command)) throw new Error("Unexpected pipeline");
        commands.push([command.command, ...command.args]);
        return "ok";
      }),
  });
  return {
    commands,
    layer: Layer.merge(files, Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, process)),
  };
};
