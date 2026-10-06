import { remotePlugin, type PersonaPluginOptions } from "@ren-ai/plugin-application";
import tools, { toolsPlugin } from "@ren-ai/plugin-tools";
import context, { contextPlugin } from "@ren-ai/plugin-context";
import memory, { memoryPlugin } from "@ren-ai/plugin-memory";
import title, { titlePlugin } from "@ren-ai/plugin-title";
import { Plugin } from "@opencode/plugin/effect";
import { Effect } from "effect";
import type { standaloneTestHost } from "./messaging-host.test-helper.ts";

const factories = [toolsPlugin, contextPlugin, memoryPlugin, titlePlugin];
export const personaPlugins = (options: PersonaPluginOptions) =>
  factories.map((factory) => factory(options));
export const installedPlugins = [tools, context, memory, title];
export const remotePersonaPlugins = (config: Parameters<typeof remotePlugin>[2]) =>
  factories.map((factory, index) => remotePlugin(installedPlugins[index]!.id, factory, config));

export const withPluginOptions = (plugin: Plugin.Plugin, options: Plugin.Context["options"]) => ({
  ...plugin,
  effect: (ctx: Plugin.Context) => plugin.effect({ ...ctx, options }),
});

export const registerInstalledPlugin = (
  native: Effect.Success<ReturnType<typeof standaloneTestHost>>,
  plugin: Plugin.Plugin,
  options: Plugin.Context["options"],
) => Effect.promise(() => native.run(native.plugins.register(withPluginOptions(plugin, options))));
