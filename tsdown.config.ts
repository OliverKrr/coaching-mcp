import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/index.ts", "src/snapshot-cli.ts"],
  format: "esm",
  outDir: "dist",
  clean: true,
  fixedExtension: false,
});
