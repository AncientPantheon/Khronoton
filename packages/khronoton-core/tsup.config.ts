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
    /^@stoachain/,
  ],
});
