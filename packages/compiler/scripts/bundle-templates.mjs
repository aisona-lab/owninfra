import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../templates/", import.meta.url));
const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? walk(join(dir, d.name)) : [join(dir, d.name)]));
const files = walk(root)
  .map((abs) => {
    const [zone, ...rest] = relative(root, abs).split("/");
    return { zone, path: rest.join("/"), contents: readFileSync(abs, "utf8") };
  })
  .concat({
    zone: "generated",
    path: "app/src/lib/(generated)/codecs.ts",
    contents: readFileSync(fileURLToPath(new URL("../../blueprint-schema/src/codecs.ts", import.meta.url)), "utf8"),
  })
  .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
writeFileSync(
  fileURLToPath(new URL("../src/static-templates.ts", import.meta.url)),
  `export const staticTemplates: ReadonlyArray<{ zone: "generated" | "user"; path: string; contents: string }> = ${JSON.stringify(files, null, 2)};\n`,
);
