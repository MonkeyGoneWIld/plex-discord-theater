import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { nodePolyfills } from "vite-plugin-node-polyfills";
import { p2pCorePatch } from "./p2pCorePatch";

export default defineConfig({
  plugins: [
    // Where the P2P engine takes a segment from — see p2pCorePatch.ts.
    p2pCorePatch(),
    react(),
    // bittorrent-tracker (used by p2p-media-loader) depends on Node.js built-ins
    // (events, process, buffer, etc.) that don't exist in browsers.
    nodePolyfills({
      include: ["events", "process", "buffer"],
      globals: { process: true, Buffer: true, global: true },
    }),
  ],
  envDir: "../../",
  server: {
    port: 5173,
    allowedHosts: true,
    proxy: {
      "/api": {
        target: "http://localhost:3000",
        changeOrigin: true,
      },
      "/ws": {
        target: "ws://localhost:3000",
        ws: true,
      },
      "/tracker": {
        target: "ws://localhost:3000",
        ws: true,
      },
    },
  },
  build: {
    outDir: "dist",
  },
});
