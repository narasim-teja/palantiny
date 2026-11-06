import { applyAction, parseAction } from "@/lib/actions";
import { sharedDb } from "@/lib/db";
import type { NextRequest } from "next/server";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  // A web page you visit could otherwise POST here. Only this console may act.
  const origin = request.headers.get("origin");
  if (origin && new URL(origin).host !== request.headers.get("host")) {
    return Response.json({ error: "Cross-origin requests are not allowed" }, { status: 403 });
  }
  const action = parseAction(await request.json().catch(() => null));
  if (!action) return Response.json({ error: "Unknown action" }, { status: 400 });
  applyAction(sharedDb(), action);
  return Response.json({ ok: true });
}
