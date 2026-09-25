import { timingSafeEqual } from "node:crypto";

import {
  APPLICATION_RECONCILIATION_CRON,
  createRuntimeApplicationService,
} from "../../../../../server/application-runtime";
import { getServerConfig } from "../../../../../server/config";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// The deployment task schedules this server-authenticated entry point with
// APPLICATION_RECONCILIATION_CRON (minute 10 of every UTC hour).
void APPLICATION_RECONCILIATION_CRON;

function authorized(request: Request, expected: string): boolean {
  const supplied = request.headers.get("authorization") ?? "";
  const expectedHeader = `Bearer ${expected}`;
  const suppliedBytes = Buffer.from(supplied);
  const expectedBytes = Buffer.from(expectedHeader);
  return (
    suppliedBytes.length === expectedBytes.length &&
    timingSafeEqual(suppliedBytes, expectedBytes)
  );
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
  await createRuntimeApplicationService().reconcile();
  return new Response(null, {
    status: 204,
    headers: { "Cache-Control": "no-store, max-age=0" },
  });
}

export function GET() {
  return new Response(null, { status: 405, headers: { Allow: "POST" } });
}
