import { existsSync } from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath } from "node:url";

// Map "@earendil-works/pi-*" imports to the machine's Pi installation so tests
// run without duplicating Pi's packages. A local node_modules symlink wins if
// present (default resolution is attempted first).
const PI_ROOT = "file:///Users/sukit/.pi/agent/install/releases/1.5.0/node_modules/";
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
      return nextResolve(`${PI_ROOT}${name}${distPath}`, context);
    }
  }
  return nextResolve(specifier, context);
}

registerHooks({ resolve });
