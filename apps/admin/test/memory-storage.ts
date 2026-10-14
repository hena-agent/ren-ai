import type { DurableObjectStorage } from "@cloudflare/workers-types";
import { fromPartial } from "@total-typescript/shoehorn";

export function memoryStorage() {
  const values = new Map<string, object>();
  let alarm: number | null = null;
  const storage: DurableObjectStorage = fromPartial({
    get: async (key: string) => values.get(key),
    list: async ({ prefix }: { prefix: string }) =>
      new Map(
        [...values]
          .filter(([key]) => key.startsWith(prefix))
          .map(([key, value]) => [key, structuredClone(value)]),
      ),
    put: async (key: string, value: object) => {
      values.set(key, structuredClone(value));
    },
    delete: async (key: string) => values.delete(key),
    getAlarm: async () => alarm,
    setAlarm: async (timestamp: number) => {
      alarm = timestamp;
    },
    transaction: async (run: (transaction: Pick<DurableObjectStorage, "put">) => Promise<void>) => {
      await run(storage);
    },
  });
  return {
    values,
    storage,
    clearAlarm: () => {
      alarm = null;
    },
  };
}
