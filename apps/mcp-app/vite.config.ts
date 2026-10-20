import { defineConfig } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";

// One self-contained HTML file. Every byte here is re-transferred out of the
// Supabase edge function on *every* tool call (phase-0 findings Q4: the host
// caches nothing), so the bundle budget is hard: <50 KB raw is the target,
// >175 KB is a build failure (raised from 150 KB on 2026-10-17, see codegen.mjs).
export default defineConfig({
  esbuild: {
    jsx: "automatic",
    jsxImportSource: "preact",
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    // Oxc, Vite 8's native minifier: about 2.5 KB smaller than esbuild on
    // this bundle (measured 2026-10-20), and every byte counts against the cap.
    minify: "oxc",
    cssMinify: true,
    target: "es2022",
    rollupOptions: { input: "index.html" },
  },
  plugins: [viteSingleFile({ removeViteModuleLoader: true })],
});
