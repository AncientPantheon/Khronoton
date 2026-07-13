import { defineConfig } from "tsup";

// tsup owns ONLY the React/CSS UI subpaths. The pure entries (`.`, `/server`,
// `/handlers`) stay on `tsc` (tsconfig.build.json) so their published 0.2.0
// output remains byte-stable. React and the CodeMirror stack are left external
// so they resolve from the consumer's own install (React is a peer dep; the
// CodeMirror libs are UI-only heavy deps the consumer provides).
export default defineConfig({
  entry: {
    "provider/index": "src/provider/index.ts",
    "hooks/index": "src/hooks/index.ts",
    "ui/index": "src/ui/index.ts",
  },
  format: ["esm"],
  dts: true,
  target: "es2020",
  sourcemap: false,
  treeshake: true,
  outDir: "dist",
  external: ["react", "react-dom", /^@codemirror/, "@uiw/react-codemirror"],
});
