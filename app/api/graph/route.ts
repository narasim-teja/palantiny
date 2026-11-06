import { sharedDb } from "@/lib/db";
import { buildSnapshot } from "@/lib/snapshot";
import type { NextRequest } from "next/server";

export const dynamic = "force-dynamic";

export function GET(request: NextRequest) {
  const reveal = request.nextUrl.searchParams.get("reveal") === "1";
  return Response.json(buildSnapshot(sharedDb(), reveal));
}
