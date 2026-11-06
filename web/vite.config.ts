import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const here = import.meta.dirname;

export default defineConfig({
  root: here,
  plugins: [react()],
  resolve: {
    alias: {
      "@core": resolve(here, "../core"),
      "@": resolve(here, "src"),
    },
  },
  server: {
    host: "127.0.0.1",
    port: 4117,
    strictPort: true,
    proxy: { "/v1": "http://127.0.0.1:4118" },
  },
  // The graph is one lazy chunk, and this only ever loads from your own machine.
  build: { outDir: "dist", emptyOutDir: true, chunkSizeWarningLimit: 1200 },
});
