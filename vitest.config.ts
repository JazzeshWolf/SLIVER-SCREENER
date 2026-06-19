import { defineConfig } from "vitest/config";

// Tests are pure logic (no DOM), so no plugins needed — this keeps vitest's
// bundled Vite separate from the app's Vite and avoids plugin type clashes.
export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
