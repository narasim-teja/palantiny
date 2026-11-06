import { sharedDb } from "@/lib/db";
import { buildSnapshot } from "@/lib/snapshot";
import type { NextRequest } from "next/server";

export const dynamic = "force-dynamic";

const INTERVAL_MS = 3_000;

export function GET(request: NextRequest) {
  const reveal = request.nextUrl.searchParams.get("reveal") === "1";
  const encoder = new TextEncoder();
  let timer: ReturnType<typeof setInterval> | undefined;

  const stream = new ReadableStream({
    start(controller) {
      const push = () => {
        try {
          const snapshot = buildSnapshot(sharedDb(), reveal);
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(snapshot)}\n\n`));
        } catch {
          clearInterval(timer);
        }
      };
      push();
      timer = setInterval(push, INTERVAL_MS);
      request.signal.addEventListener("abort", () => {
        clearInterval(timer);
        try {
          controller.close();
        } catch {
          // Already closed by the client going away.
        }
      });
    },
    cancel() {
      clearInterval(timer);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
