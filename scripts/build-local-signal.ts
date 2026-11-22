import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { createOpenBotLogger } from "@openbot/logging";

const logger = createOpenBotLogger("build-local-signal");
const root = join(import.meta.dir, "..");
const output = join(root, "build", "openbot-signal.exe");

await mkdir(join(root, "build"), { recursive: true });
const result = await Bun.build({
  entrypoints: [join(root, "remote", "api", "src", "index.ts")],
  compile: { outfile: output, target: "bun-windows-x64" },
});
if (!result.success) {
  for (const message of result.logs) logger.error(String(message));
  throw new Error("The local Signal binary did not build.");
}
logger.info(`Built the local Signal binary: ${output}`);
