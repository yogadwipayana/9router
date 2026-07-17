import { getUsageStats, statsEmitter, getActiveRequests } from "@/lib/usageDb";

export const dynamic = "force-dynamic";

export async function GET() {
  const encoder = new TextEncoder();
  const state = { closed: false, keepalive: null, send: null };

  const stream = new ReadableStream({
    async start(controller) {
      // Live-activity push. The dashboard client only merges activeRequests /
      // recentRequests / errorProvider / pending from SSE messages (period
      // totals come from the REST /api/usage/stats fetch), so events send the
      // lightweight payload instead of recomputing full stats per request.
      state.send = async () => {
        if (state.closed) return;
        try {
          const light = await getActiveRequests();
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(light)}\n\n`));
        } catch {
          state.closed = true;
          statsEmitter.off("update", state.send);
          statsEmitter.off("pending", state.send);
          clearInterval(state.keepalive);
        }
      };

      // One full snapshot on connect (keeps the payload shape for any consumer
      // that reads totals from the stream), then lightweight-only events.
      try {
        const stats = await getUsageStats();
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(stats)}\n\n`));
      } catch {}

      statsEmitter.on("update", state.send);
      statsEmitter.on("pending", state.send);

      state.keepalive = setInterval(() => {
        if (state.closed) { clearInterval(state.keepalive); return; }
        try {
          controller.enqueue(encoder.encode(": ping\n\n"));
        } catch {
          state.closed = true;
          clearInterval(state.keepalive);
        }
      }, 25000);
    },

    cancel() {
      state.closed = true;
      statsEmitter.off("update", state.send);
      statsEmitter.off("pending", state.send);
      clearInterval(state.keepalive);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
