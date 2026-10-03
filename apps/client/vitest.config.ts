import { defineConfig } from "vitest/config";

// Separate from vite.config.ts on purpose: in this monorepo vitest resolves the
// hoisted Vite (6.x, pulled in by other workspaces) while the app builds with
// its own Vite 8 and a React plugin that needs it. The tests are pure
// TypeScript plus jsdom and need no plugin, so they simply do not load one.
export default defineConfig({
  test: {
    environment: "jsdom",
    include: ["src/**/*.test.{ts,tsx}"],
    css: false,
  },
});
