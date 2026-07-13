import { defineConfig } from "vitest/config";

// Integration config — runs ONLY the `*.real.test.ts` files, which load the real
// chain SDK(s) (`@stoachain/*`) instead of mocks. This is the regression guard for
// the actual module-loading path (e.g. the Node-24 sequential-`await import()`
// fix). It is a LOCAL/DEV run (`npm run test:integration`), deliberately kept out
// of the publish/CI gate (see vitest.config.ts) so a release never depends on the
// external SDK behaving in the CI environment. `@stoachain/*` are optional peers,
// dev-installed here.
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.real.test.ts"],
  },
});
