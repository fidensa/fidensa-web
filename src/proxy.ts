import { NextRequest, NextResponse } from "next/server";

import {
  environmentClasses,
  type EnvironmentClass,
} from "./config/environment";
import { buildSecurityHeaders } from "./security/headers";

function currentEnvironment(): EnvironmentClass {
  const value = process.env.APP_ENV;
  if (!environmentClasses.includes(value as EnvironmentClass)) {
    throw new Error(
      "Request blocked: environment identity is missing or unsupported.",
    );
  }
  return value as EnvironmentClass;
}

export function proxy(request: NextRequest) {
  const nonce = crypto.randomUUID().replaceAll("-", "");
  const environment = currentEnvironment();
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);

  const response = NextResponse.next({
    request: { headers: requestHeaders },
  });
  const securityHeaders = buildSecurityHeaders({
    environment,
    nonce,
    protocol: request.nextUrl.protocol as "http:" | "https:",
  });
  for (const [name, value] of securityHeaders)
    response.headers.set(name, value);
  return response;
}

export const config = {
  matcher: ["/:path*"],
};
