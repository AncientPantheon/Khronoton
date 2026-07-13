import { defineConfig } from "vitest/config";

// No `globals: true` — tests import `describe`/`it`/`expect` explicitly from
// "vitest". The tsconfig chain typechecks tests/** without `vitest/globals`
// types, so advertised globals would fail `tsc --noEmit`.
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "tests/**/*.test.ts"],
  },
});
