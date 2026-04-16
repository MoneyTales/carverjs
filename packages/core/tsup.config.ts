import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    components: "src/components/index.ts",
    hooks: "src/hooks/index.ts",
    systems: "src/systems/index.ts",
    store: "src/store/index.ts",
    types: "src/types/index.ts",
  },
  format: ["cjs", "esm"],
  dts: true,
  sourcemap: true,
  clean: true,
  external: ["react", "react-dom", "three", "@react-three/fiber", "@react-three/drei", "zustand", "@react-three/rapier"],
});
