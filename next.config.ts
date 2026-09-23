import type { NextConfig } from "next";

import { validateBuildEnvironment } from "./src/config/environment";
import { baselineSecurityHeaderEntries } from "./src/security/headers";

validateBuildEnvironment(process.env);

const nextConfig: NextConfig = {
  async headers() {
    return [
      {
        source: "/:path*",
        headers: baselineSecurityHeaderEntries.map(([key, value]) => ({
          key,
          value,
        })),
      },
    ];
  },
  poweredByHeader: false,
  reactStrictMode: true,
};

export default nextConfig;
