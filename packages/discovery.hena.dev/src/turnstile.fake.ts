import { vi } from "vitest";

export type Widget = NonNullable<Window["turnstile"]>;
export let widgetOptions: Parameters<Widget["render"]>[1];
export const widget = {
  render: vi.fn<Widget["render"]>((_element, options) => {
    widgetOptions = options;
    return "widget-id";
  }),
  remove: vi.fn<Widget["remove"]>(),
};
