import type { NextConfig } from "next";

const config: NextConfig = {
  devIndicators: false,
  serverExternalPackages: ["bun:sqlite"],
  agentRules: false,
};

export default config;
