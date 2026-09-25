import { createRuntimeResendWebhookHandler } from "../../../../server/governance-runtime";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: Request) {
  return createRuntimeResendWebhookHandler()(request);
}

export function GET() {
  return new Response(null, { status: 405, headers: { Allow: "POST" } });
}
