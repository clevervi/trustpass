import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Next writes AGENTS.md and CLAUDE.md into apps/web on every `next dev`.
  // They are editor configuration rather than product, and regenerating them
  // silently puts them back after any deletion.
  agentRules: false,
};

export default nextConfig;
