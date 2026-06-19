/// <reference types="node" />
import { defineConfig } from "vite";
import preact from "@preact/preset-vite";
import tailwindcss from "@tailwindcss/vite";

// `base` must match the GitHub Pages sub-path (https://<user>.github.io/sliver-screener/).
// Override with BASE_PATH env if you deploy to a custom domain / different repo name.
const base = process.env.BASE_PATH ?? "/sliver-screener/";

export default defineConfig({
  base,
  plugins: [preact(), tailwindcss()],
});
