import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  root: "web-src",
  plugins: [react()],
  build: {
    outDir: "../web",
    emptyOutDir: true,
    sourcemap: true,
  },
});
