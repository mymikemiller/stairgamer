import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

// tsc emits `from "./stairs"`, which a browser will not resolve. Native ES
// modules need the real filename, so rewrite relative specifiers to add .js.
const dir = new URL("../../public/lib/", import.meta.url).pathname;

for (const file of await readdir(dir)) {
  if (!file.endsWith(".js")) continue;
  const path = join(dir, file);
  const src = await readFile(path, "utf8");
  const out = src.replace(/(from\s+["'])(\.\.?\/[^"']+?)(["'])/g,
    (m, a, spec, b) => (spec.endsWith(".js") ? m : `${a}${spec}.js${b}`));
  if (out !== src) await writeFile(path, out);
}
