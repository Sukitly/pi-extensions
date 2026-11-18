import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { registerHooks } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

// Map "@earendil-works/pi-*" imports to the machine's Pi installation so tests
// run without duplicating Pi's packages. A local node_modules symlink wins if
// present (default resolution is attempted first).
const install = join(homedir(), ".pi/agent/install");
const PI_NODE_MODULES = process.env.PI_NODE_MODULES ?? join(
  install,
  "releases",
  readFileSync(join(install, "current-version"), "utf8").trim(),
  "node_modules",
);
const PI_PACKAGES = [
  "@earendil-works/pi-ai",
  "@earendil-works/pi-coding-agent",
  "@earendil-works/pi-tui",
];

export function resolve(specifier, context, nextResolve) {
  if (specifier.endsWith(".js") && context?.parentURL) {
    try {
      const asTs = new URL(`${specifier.slice(0, -3)}.ts`, context.parentURL);
      if (existsSync(fileURLToPath(asTs))) {
        return nextResolve(`${specifier.slice(0, -3)}.ts`, context);
      }
    } catch {
      // Fall through to default resolution.
    }
  }
  for (const name of PI_PACKAGES) {
    if (specifier === name || specifier.startsWith(`${name}/`)) {
      // Package.json exports are not consulted when rewriting as a raw URL, so
      // mirror pi-ai's exports map ("." and "/<subpath>" -> "./dist/...").
      const remainder = specifier.slice(name.length);
      const distPath = `/dist${remainder === "" ? "/index" : remainder}.js`;
      return nextResolve(pathToFileURL(join(PI_NODE_MODULES, name, distPath)).href, context);
    }
  }
  return nextResolve(specifier, context);
}

registerHooks({ resolve });
