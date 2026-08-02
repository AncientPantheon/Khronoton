import { defineConfig } from "tsup";

// tsup owns the subpaths that reference an external dep — the React/CSS UI
// (`/provider`, `/hooks`, `/ui`) and the per-chain adapters (`/blockchain/*`,
// which lazy-import the chain SDK). The pure chain-free entries (`.`, `/server`,
// `/handlers`) stay on `tsc` (tsconfig.build.json) so their published 0.2.0
// output remains byte-stable. React, the CodeMirror stack, and every `@stoachain/*`
// module are left external so they resolve from the consumer's own install
// (React is an optional peer for the UI subpaths; `@stoachain/*` are optional
// peers for `/blockchain/stoachain`; the CodeMirror libs are UI-only heavy deps).
export default defineConfig({
  entry: {
    "provider/index": "src/provider/index.ts",
    "hooks/index": "src/hooks/index.ts",
    "ui/index": "src/ui/index.ts",
    "blockchain/stoachain": "src/blockchain/stoachain.ts",
  },
  format: ["esm"],
  dts: true,
  target: "es2020",
  sourcemap: false,
  treeshake: true,
  outDir: "dist",
  external: [
    "react",
    "react-dom",
    /^@codemirror/,
    "@uiw/react-codemirror",
    /^@lezer/,
    /^@stoachain/,
    // Pre-existing gap (predates this change — `git log` shows this pattern
    // was never present): `/blockchain/stoachain`'s own `createStoachainRuntime`
    // lazily imports `@ouronet/ouronet-core/constants` too, and it's declared
    // as an optional peer in package.json, but was missing from this array —
    // meaning esbuild would bundle a build-time-frozen copy into
    // `dist/blockchain/stoachain.js` instead of leaving it external, silently
    // reintroducing the exact version-pinning conflict the 0.4.1 release
    // (see CHANGELOG.md) existed to fix.
    /^@ouronet/,
  ],
});
