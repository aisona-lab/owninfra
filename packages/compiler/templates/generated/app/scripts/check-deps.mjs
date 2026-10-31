// Fails when node_modules is not exactly the tree pinned in package-lock.json: a package missing, extra, or at another
// version or tarball. `npm ci` installs that tree; this catches an `npm install` that re-resolved, or a stale node_modules.
// Optional packages for other platforms (native binaries) are pinned but not installed, so their absence is fine.
// Dependencies you add under src/custom/ live in src/custom/node_modules and are not checked.
import { existsSync, readFileSync } from "node:fs";

const read = (path) => JSON.parse(readFileSync(new URL(`../${path}`, import.meta.url), "utf8"));
const pinned = read("package-lock.json").packages;
if (!existsSync(new URL("../node_modules/.package-lock.json", import.meta.url))) {
  console.error("check-deps: node_modules/.package-lock.json is missing; run npm ci");
  process.exit(1);
}
const installed = read("node_modules/.package-lock.json").packages;
const problems = [];
for (const [path, want] of Object.entries(pinned)) {
  if (!path) continue;
  const got = installed[path];
  if (!got) {
    if (!want.optional) problems.push(`${path}: pinned ${want.version}, not installed`);
  } else if (got.version !== want.version || got.resolved !== want.resolved || got.integrity !== want.integrity)
    problems.push(`${path}: pinned ${want.version}, installed ${got.version}${got.version === want.version ? " from another tarball" : ""}`);
}
for (const path of Object.keys(installed)) if (!(path in pinned)) problems.push(`${path}: installed ${installed[path].version}, not pinned`);
if (problems.length) {
  console.error(`check-deps: node_modules differs from package-lock.json (${problems.length}):\n  ${problems.join("\n  ")}`);
  process.exit(1);
}
console.log(`check-deps: node_modules matches package-lock.json (${Object.keys(installed).length} packages)`);
