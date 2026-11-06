import { sharedDb } from "@/lib/db";
import { buildDeviceDetail } from "@/lib/snapshot";
import type { NextRequest } from "next/server";

export const dynamic = "force-dynamic";

export async function GET(_request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const deviceId = Number(id);
  if (!Number.isInteger(deviceId)) return Response.json({ error: "Bad device id" }, { status: 400 });
  return Response.json(buildDeviceDetail(sharedDb(), deviceId));
}
