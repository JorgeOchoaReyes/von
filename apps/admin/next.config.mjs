import { fileURLToPath } from "node:url";

/** @type {import('next').NextConfig} */
export default {
  transpilePackages: ["@von/core"],

  // Bundles the server and only the files it traced into `.next/standalone`,
  // so the container ships without node_modules. Without it the image carries
  // the whole workspace's dependency tree for a console that renders tables.
  output: "standalone",

  // In a pnpm workspace, Next traces from the app directory and misses the
  // hoisted store at the repo root — the standalone build then starts and
  // immediately fails to resolve React. Pointing it at the root fixes that.
  outputFileTracingRoot: fileURLToPath(new URL("../..", import.meta.url)),
};
