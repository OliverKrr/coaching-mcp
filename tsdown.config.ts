import { defineConfig } from "tsdown";

export default defineConfig({
  entry: [
    "src/index.ts",
    "src/serve.ts",
    "src/snapshot-cli.ts",
    "src/restore-cli.ts",
    "src/migrate-cli.ts",
  ],
  format: "esm",
  outDir: "dist",
  clean: true,
  fixedExtension: false,
});
