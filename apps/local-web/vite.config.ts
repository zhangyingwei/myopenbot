import solidPlugin from "@solidjs/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

export default defineConfig({
  base: "/app/",
  resolve: {
    dedupe: ["solid-js", "@solidjs/web", "@solidjs/signals"],
  },
  optimizeDeps: {
    exclude: ["@norbert_bodziony/bloub", "@norbert_bodziony/bloub/plush"],
  },
  esbuild: { legalComments: "eof" },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
  plugins: [solidPlugin(), tailwindcss({ optimize: false })],
});
