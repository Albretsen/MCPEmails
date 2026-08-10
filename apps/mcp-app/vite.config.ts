import { defineConfig } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";

// One self-contained HTML file. Every byte here is re-transferred out of the
// Supabase edge function on *every* tool call (phase-0 findings Q4: the host
// caches nothing), so the bundle budget is hard: <50 KB raw is the target,
// >150 KB is a build failure.
export default defineConfig({
  esbuild: {
    jsx: "automatic",
    jsxImportSource: "preact",
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    minify: "esbuild",
    cssMinify: true,
    target: "es2022",
    rollupOptions: { input: "index.html" },
  },
  plugins: [viteSingleFile({ removeViteModuleLoader: true })],
});
