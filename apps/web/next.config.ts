import path from "node:path";
import type { NextConfig } from "next";

const config: NextConfig = {
  transpilePackages: ["@elevate/agent", "@elevate/db", "@elevate/engine", "@elevate/executors", "@elevate/github", "@elevate/policy", "@elevate/sources"],
  // Native/wasm and process-spawning packages stay out of the bundle.
  serverExternalPackages: ["@electric-sql/pglite", "@electric-sql/pglite-pgvector", "@github/copilot-sdk", "postgres"],
  outputFileTracingRoot: path.join(import.meta.dirname, "../.."),
  typedRoutes: false,
  devIndicators: { position: "bottom-right" },
};

export default config;
