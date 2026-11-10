import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

/**
 * The admin page (admin/), built apart from the Activity into dist-admin/,
 * which only the admin server (ADMIN_PORT) serves. `npm run dev:admin` runs
 * it on 5174 against an admin server on 3050.
 */
export default defineConfig({
  root: fileURLToPath(new URL("./admin", import.meta.url)),
  base: "/",
  plugins: [react()],
  server: {
    port: 5174,
    proxy: {
      "/api": { target: "http://localhost:3050", changeOrigin: true },
    },
  },
  build: {
    outDir: fileURLToPath(new URL("./dist-admin", import.meta.url)),
    emptyOutDir: true,
  },
});
