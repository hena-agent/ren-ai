/** Browser work and authentication for one profile must never interleave. */
export function accountQueue() {
  const tails = new Map<string, Promise<void>>();
  return <T>(account: string, operation: () => Promise<T>) => {
    const result = (tails.get(account) ?? Promise.resolve()).then(operation);
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    tails.set(account, tail);
    void tail.then(() => {
      if (tails.get(account) === tail) tails.delete(account);
      return undefined;
    });
    return result;
  };
}
export type AccountQueue = ReturnType<typeof accountQueue>;
