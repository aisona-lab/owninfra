import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@owninfra/blueprint-schema": fileURLToPath(new URL("packages/blueprint-schema/src/index.ts", import.meta.url)),
      "@owninfra/compiler": fileURLToPath(new URL("packages/compiler/src/index.ts", import.meta.url)),
    },
  },
  test: { include: ["packages/*/test/**/*.test.ts"], exclude: ["**/node_modules/**", "packages/compiler/test/golden/**"] },
});
