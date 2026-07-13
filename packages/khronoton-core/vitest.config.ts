import { defineConfig, configDefaults } from "vitest/config";

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
    // `*.real.test.ts` are integration tests that load a REAL chain SDK
    // (`@stoachain/*`) at runtime. They must NOT gate the publish/CI run — a
    // release can't depend on the external SDK's behaviour in the CI Node/OS
    // environment. They run via `npm run test:integration`
    // (vitest.integration.config.ts) as a local/dev regression guard.
    exclude: [...configDefaults.exclude, "**/*.real.test.ts"],
  },
});
