import { ConfigError, loadConfig, type RelayerConfig } from "./config.ts";
import { GasLedgerError } from "./gas-budget.ts";
import { createLogger } from "./logger.ts";
import { StartupError, startRelayer } from "./server.ts";

const HELP = "See apps/relayer/README.md and apps/relayer/.env.example.\n";

let config: RelayerConfig;
try {
  config = loadConfig(process.env);
} catch (err) {
  if (err instanceof ConfigError) {
    process.stderr.write(`${err.message}\n${HELP}`);
    process.exit(2);
  }
  throw err;
}

const log = createLogger({ level: config.logLevel, base: { service: "relayer" } });
try {
  const relayer = await startRelayer(config, { logger: log });
  let signals = 0;
  const shutdown = (signal: string) => {
    signals++;
    if (signals > 1) {
      log.warn("second signal, exiting immediately", { signal });
      process.exit(1);
    }
    log.info("signal received", { signal });
    relayer.stop().then(
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
  if (err instanceof StartupError || err instanceof GasLedgerError) {
    process.stderr.write(`Relayer did not start:\n  - ${err.message}\n${HELP}`);
    process.exit(2);
  }
  if ((err as NodeJS.ErrnoException).code === "EADDRINUSE") {
    process.stderr.write(`Relayer did not start:\n  - PORT: ${config.port} is already in use on ${config.host}. Stop the other process or set PORT to a free port.\n${HELP}`);
    process.exit(2);
  }
  log.error("startup failed", { err });
  process.exit(1);
}
