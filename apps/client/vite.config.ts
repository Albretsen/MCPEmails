import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Client-rendered SPA. No SSR, no server coupling: the same bundle is served
// to the browser, installed as a PWA, and later loaded by an Electron shell.
export default defineConfig({
  plugins: [react()],
  server: { port: 5183, strictPort: true },
  preview: { port: 5183, strictPort: true },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    target: "es2022",
    sourcemap: true,
  },
  css: {
    modules: { localsConvention: "camelCaseOnly" },
  },
});
