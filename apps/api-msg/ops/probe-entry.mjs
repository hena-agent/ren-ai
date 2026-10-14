import { probeExecutor } from "./probe.ts";

const token = process.env.TOKEN_EXECUTOR;
if (!token) throw new Error("TOKEN_EXECUTOR is required for the executor probe");
await probeExecutor(`http://127.0.0.1:${process.env.PORT ?? "4700"}`, token);
