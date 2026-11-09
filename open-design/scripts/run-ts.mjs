import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
const here = dirname(fileURLToPath(import.meta.url));
const hook = pathToFileURL(join(here, "register-hooks.mjs")).href;
const result = spawnSync(process.execPath, [
  "--experimental-strip-types", "--disable-warning=ExperimentalWarning",
  `--import=${hook}`, ...process.argv.slice(2),
], { stdio: "inherit" });
process.exit(result.status ?? 1);
