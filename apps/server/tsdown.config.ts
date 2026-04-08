import { defineConfig } from "tsdown";

export default defineConfig({
  clean: true,
  entry: ["./src/index.ts", "./src/app.ts"],
  format: "esm",
  // Bundle EVERYTHING (workspace pkgs + npm deps) so the output .mjs is
  // self-contained and can run as a Vercel function without relying on the
  // function's auto-traced node_modules.
  noExternal: [/.*/],
  outDir: "./dist",
  platform: "node",
});
