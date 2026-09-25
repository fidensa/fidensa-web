import { createRuntimeApplicationService } from "../../../server/application-runtime";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: Request) {
  return createRuntimeApplicationService().submit(request);
}

export function GET() {
  return new Response(null, { status: 405, headers: { Allow: "POST" } });
}
