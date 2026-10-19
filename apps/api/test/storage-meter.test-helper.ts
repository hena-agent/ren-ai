import type {
  DurableObjectStorage,
  SqlStorageCursor,
  SqlStorageValue,
} from "@cloudflare/workers-types";

export const storageMeter = (storage: DurableObjectStorage) => {
  const exec = storage.sql.exec.bind(storage.sql);
  let cursors: SqlStorageCursor<Record<string, SqlStorageValue>>[] = [];
  const queries: string[] = [];
  storage.sql.exec = <T extends Record<string, SqlStorageValue>>(
    query: string,
    ...bindings: SqlStorageValue[]
  ) => {
    const cursor = exec<T>(query, ...bindings);
    queries.push(query);
    cursors.push(cursor);
    return cursor;
  };
  return {
    queries,
    reset: () => {
      cursors = [];
      queries.length = 0;
    },
    totals: () => ({
      reads: cursors.reduce((sum, cursor) => sum + cursor.rowsRead, 0),
      writes: cursors.reduce((sum, cursor) => sum + cursor.rowsWritten, 0),
    }),
    restore: () => {
      storage.sql.exec = exec;
    },
  };
};
