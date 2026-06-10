import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    alias: {
      // Mirror the tsconfig "@/*" -> "./*" path alias for test resolution.
      "@": fileURLToPath(new URL("./", import.meta.url)),
    },
  },
  test: {
    // Run once and exit (CI / single-run mode). Invoked via `vitest run`.
    include: ["tests/**/*.{test,spec}.{ts,tsx}", "lib/**/*.{test,spec}.{ts,tsx}"],
    environment: "node",
    globals: true,
  },
});
