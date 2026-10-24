import type { DiscoveryClient } from "../src/client.ts";

export function testClient(client: Omit<DiscoveryClient, "browse">): DiscoveryClient {
  return {
    ...client,
    browse: async (_query, signal, token) => ({
      people: await client.profiles(signal, token, []),
      nextCursor: null,
    }),
    profiles: (signal, token, ids) =>
      ids.length
        ? client
            .profiles(signal, token, ids)
            .then((people) => people.filter((person) => ids.includes(person.id)))
        : Promise.resolve([]),
  };
}
