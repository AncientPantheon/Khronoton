import { defineConfig } from "tsup";

// `@stoachain/*` are peer dependencies resolved by the consumer (they ship
// WASM/crypto singletons); keep them external so the adapter bundle never
// inlines a second copy. Emit a `require` condition alongside ESM via the
// package `exports` map — the single `.js` output serves both.
export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  dts: true,
  target: "es2020",
  treeshake: true,
  sourcemap: false,
  clean: true,
  external: [/^@stoachain\//],
});
