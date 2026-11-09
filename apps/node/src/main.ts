import { ConfigError, loadConfig } from "./config.ts";
import { createLogger } from "./logger.ts";
import { startNode } from "./server.ts";

const boot = createLogger({ base: { service: "clearing-node" } });

let config;
try {
  config = loadConfig(process.env);
} catch (err) {
  if (err instanceof ConfigError) {
    process.stderr.write(`${err.message}\nSee apps/node/README.md and apps/node/.env.example.\n`);
    process.exit(2);
  }
  throw err;
}

const log = createLogger({ level: config.logLevel, base: { service: "clearing-node" } });
try {
  const node = await startNode(config, { logger: log });
  let signals = 0;
  const shutdown = (signal: string) => {
    signals++;
    if (signals > 1) {
      log.warn("second signal, exiting immediately", { signal });
      process.exit(1);
    }
    log.info("signal received", { signal });
    node.stop().then(
      () => process.exit(0),
      (err) => {
        log.error("shutdown failed", { err });
        process.exit(1);
      },
    );
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
} catch (err) {
  boot.error("startup failed", { err });
  process.exit(1);
}
