import { Logger } from "effect";

export const captureSendLogs = () => {
  const logs: string[] = [];
  const records: string[] = [];
  const logger = Logger.make<ReadonlyArray<string>, void>((options) => {
    logs.push(...options.message);
    records.push(JSON.stringify(Logger.formatStructured.log(options)));
  });
  return { logs, records, logger };
};
