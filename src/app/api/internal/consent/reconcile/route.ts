import { timingSafeEqual } from "node:crypto";

import {
  CONSENT_RECONCILIATION_CRON,
  reconcileRuntimeConsent,
} from "../../../../../server/governance-runtime";
import { getServerConfig } from "../../../../../server/config";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
void CONSENT_RECONCILIATION_CRON;

function authorized(request: Request, expected: string): boolean {
  const supplied = Buffer.from(request.headers.get("authorization") ?? "");
  const wanted = Buffer.from(`Bearer ${expected}`);
  return supplied.length === wanted.length && timingSafeEqual(supplied, wanted);
}

export async function POST(request: Request) {
  const config = getServerConfig();
  if (
    !config.serverCredentials ||
    !authorized(request, config.serverCredentials.reconciliationAccess)
  ) {
    return new Response(null, {
      status: 404,
      headers: { "Cache-Control": "no-store, max-age=0" },
    });
  }
  await reconcileRuntimeConsent();
  return new Response(null, {
    status: 204,
    headers: { "Cache-Control": "no-store, max-age=0" },
  });
}

export function GET() {
  return new Response(null, { status: 405, headers: { Allow: "POST" } });
}
