// Concatenates the `/ui` stylesheet(s) into a single `dist/ui.css`, consumed by
// the `"./ui.css"` export. Runs AFTER tsup so it can create/overwrite the file
// idempotently. If `src/ui/ui.css` exists it is treated as the canonical sheet;
// otherwise every `src/ui/**/*.css` is concatenated in sorted order (later-wins,
// so a file's rules can override earlier ones by cascade position).
import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(here, "..");
const uiDir = join(pkgRoot, "src", "ui");
const distDir = join(pkgRoot, "dist");
const outFile = join(distDir, "ui.css");

function collectCssFiles(dir) {
  const found = [];
  if (!existsSync(dir)) return found;
  for (const entry of readdirSync(dir).sort()) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      found.push(...collectCssFiles(full));
    } else if (entry.endsWith(".css")) {
      found.push(full);
    }
  }
  return found;
}

const canonical = join(uiDir, "ui.css");
const sources = existsSync(canonical) ? [canonical] : collectCssFiles(uiDir);

const merged = sources
  .map((file) => readFileSync(file, "utf8").trim())
  .filter(Boolean)
  .join("\n\n");

mkdirSync(distDir, { recursive: true });
writeFileSync(outFile, merged ? `${merged}\n` : "", "utf8");

console.log(`[bundle-css] wrote ${outFile} from ${sources.length} source file(s)`);
