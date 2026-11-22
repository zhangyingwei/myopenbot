import { createOpenBotLogger } from "@openbot/logging";
import { readLocalPairingConfig } from "./config";
import { closeLocalPairingServer, startLocalPairingServer } from "./node";
import { createLocalPairingRuntime } from "./runtime";

const config = readLocalPairingConfig();
const logger = createOpenBotLogger("local-pairing", undefined, config.logLevel);
const runtime = await createLocalPairingRuntime(config, logger);
const server = await startLocalPairingServer(runtime.handle, {
  host: config.bindAddress,
  port: config.apiPort,
  onError: (message, error) => logger.error(message, error instanceof Error ? error.message : String(error)),
});

logger.info(`Local pairing API listening on ${config.bindAddress}:${config.apiPort}`);
logger.info(`Local pairing public API URL: ${config.publicApiUrl}`);
logger.info(`Local pairing Signal URL: ${config.publicSignalUrl}`);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void closeLocalPairingServer(server).then(() => process.exit(0));
  });
}
