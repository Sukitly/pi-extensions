import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";

const install = join(homedir(), ".pi/agent/install");
const root = process.env.PI_NODE_MODULES ?? join(
  install, "releases", readFileSync(join(install, "current-version"), "utf8").trim(), "node_modules",
);
registerHooks({
  resolve(specifier, context, nextResolve) {
    for (const name of ["@earendil-works/pi-ai", "@earendil-works/pi-coding-agent", "@earendil-works/pi-tui"]) {
      if (specifier === name || specifier.startsWith(name + "/")) {
        const subpath = specifier.slice(name.length) || "/index";
        return nextResolve(pathToFileURL(join(root, name, "dist", subpath + ".js")).href, context);
      }
    }
    return nextResolve(specifier, context);
  },
});
