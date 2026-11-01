import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import { nodePolyfills } from "vite-plugin-node-polyfills";

// Static SPA: `vite build` emits ./dist, deployable to any static host.
// `base: "./"` + HashRouter (see src/main.tsx) means no SPA-fallback rewrite is needed.
export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    // @near-wallet-selector/{core,my-near-wallet} use `Buffer` at runtime (NEP-413 nonce, borsh). Nothing else is polyfilled.
    nodePolyfills({ include: ["buffer"], globals: { Buffer: true, global: false, process: false } }),
  ],
  base: "./",
  // meteor-wallet reads Node's `global` and `process.env` at module load; without this the whole wallet selector fails to load.
  define: { global: "globalThis", "process.env": "{}" },
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
});
