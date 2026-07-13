import { defineConfig } from "vitest/config";

// No `globals: true` — tests import `describe`/`it`/`expect` explicitly from
// "vitest". The tsconfig chain typechecks tests/** without `vitest/globals`
// types, so advertised globals would fail `tsc --noEmit`.
//
// The default environment stays `node` so the engine (`src/server/**`) and
// handler (`src/handlers/**`) suites keep their byte-stable node runs and
// `better-sqlite3` loads natively. React hook/poller tests live in `*.test.tsx`
// files and opt into jsdom PER FILE via a top-of-file `// @vitest-environment
// jsdom` docblock — the `.tsx` globs below only widen DISCOVERY, they do not
// change the global env. See `tests/hooks/harness.tsx` for the convention.
export default defineConfig({
  test: {
    environment: "node",
    include: [
      "src/**/*.test.ts",
      "src/**/*.test.tsx",
      "tests/**/*.test.ts",
      "tests/**/*.test.tsx",
    ],
  },
});
