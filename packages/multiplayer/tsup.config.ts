import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    transport: "src/transport/index.ts",
    strategy: "src/transport/strategy/index.ts",
    sync: "src/sync/index.ts",
    types: "src/types/index.ts",
  },
  format: ["cjs", "esm"],
  dts: true,
  sourcemap: true,
  clean: true,
  external: [
    "react",
    "react-dom",
    "@carverjs/core",
    "@carverjs/core/components",
    "@carverjs/core/hooks",
    "@carverjs/core/systems",
    "@carverjs/core/store",
    "@carverjs/core/types",
  ],
});
