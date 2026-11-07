import handler from "vinext/server/fetch-handler";
import { runWithConnectorBinding } from "../lib/connector-context";
import type { ConnectorBinding } from "../lib/connector-contract.mjs";

export function secureResponse(request: Request, response: Response, development = false): Response {
  const headers = new Headers(response.headers);
  // Allow our own origin and the trusted ChatGPT hosts. Real hosted preview
  // and embed compatibility still need verification against their parent chain.
  const policy = [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "frame-ancestors 'self' https://chatgpt.com https://*.chatgpt.com https://chatgpt-team.site https://*.chatgpt-team.site",
    // Vinext emits inline React hydration payloads. A nonce-based script policy
    // requires framework support; do not falsely claim a strict XSS policy here.
    `script-src 'self' 'unsafe-inline' https://cdn.oaistatic.com${development ? " 'unsafe-eval'" : ""}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https://*.oaiusercontent.com",
    "font-src 'self' data:",
    `connect-src 'self'${development ? " ws: wss:" : ""}`,
    "worker-src 'self'",
    "manifest-src 'self'",
    "form-action 'self'",
  ].join('; ');
  // Browsers enforce every policy. Keep any framework policy while adding the
  // baseline so even a partial upstream CSP cannot remove framing protection.
  headers.append('Content-Security-Policy', policy);
  headers.set('X-Content-Type-Options', 'nosniff');
  // Invite links contain secrets; never forward their query to external sites.
  headers.set('Referrer-Policy', 'no-referrer');
  headers.set('Permissions-Policy', 'camera=(self), microphone=(), geolocation=(), payment=(), usb=()');
  if (new URL(request.url).protocol === 'https:') headers.set('Strict-Transport-Security', 'max-age=31536000');
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

/** R07: resume receipt readings cut off after a disconnect (lib/receipt-background.ts). */
// Not exported: every named export of a Worker entry module must be a handler.
const RECEIPT_RESUME_CRON = "* * * * *";

async function resumeReceiptOperations(env: Cloudflare.Env, scheduledTime: number) {
  try {
    const { runReceiptOperationTick } = await import("../lib/receipt-background");
    await runReceiptOperationTick(env as never, { now: scheduledTime });
  } catch {
    // Each operation records its own outcome; a failure here leaves the
    // interrupted operations for the next invocation. Never log resource values.
    console.warn('TripTab could not resume interrupted receipt readings.');
    throw new Error('TripTab could not resume interrupted receipt readings.');
  }
}

const worker = {
  scheduled(controller: ScheduledController, env: Cloudflare.Env, ctx: ExecutionContext) {
    // Scheduled work receives bindings directly, without a visitor identity or
    // request-scoped connected-app access. Sites must activate the Cron trigger.
    if (controller.cron === RECEIPT_RESUME_CRON) {
      const task = resumeReceiptOperations(env, controller.scheduledTime);
      ctx.waitUntil(task);
      return task;
    }
    const cleanup = async () => {
      try {
        const bindings = env as unknown as { DB?: D1Database; RECEIPTS?: R2Bucket };
        if (!bindings.DB || !bindings.RECEIPTS) throw new Error('Receipt maintenance bindings unavailable.');
        const { maintainSystemReceipts, purgeDeletedTripReceipts } = await import("../lib/receipt-lifecycle");
        const { flushNotificationDigests } = await import('../lib/notifications');
        await flushNotificationDigests(bindings.DB, controller.scheduledTime);
        const result = await maintainSystemReceipts(bindings.DB, bindings.RECEIPTS, { now: controller.scheduledTime });
        // F-14: bills deleted more than 30 days ago are removed for good; their
        // photos join the purge queue handled on the next line.
        const { purgeExpiredDeletedBills } = await import('../lib/trip-lifecycle');
        await purgeExpiredDeletedBills(bindings.DB, { now: controller.scheduledTime });
        const purged = await purgeDeletedTripReceipts(bindings.DB, bindings.RECEIPTS, { now: controller.scheduledTime });
        // R07: also resume interrupted readings here, so they still finish if
        // only this trigger is active on the host.
        const resumed = await resumeReceiptOperations(env, controller.scheduledTime).then(() => true, () => false);
        if (result.failed || purged.failed || !resumed) throw new Error('Receipt cleanup needs a retry.');
      } catch {
        // Database/provider exceptions can contain resource IDs or image keys.
        // Report failure to the scheduler without forwarding those values.
        console.warn('TripTab scheduled receipt cleanup did not complete.');
        throw new Error('TripTab scheduled receipt cleanup did not complete.');
      }
    };
    const task = cleanup();
    ctx.waitUntil(task);
    // Also return the rejection from the scheduled handler itself. This makes
    // the Cron invocation fail even in hosts that only track its return value.
    return task;
  },
  async fetch(request: Request, env: Cloudflare.Env, ctx: ExecutionContext<{ CONNECTORS?: ConnectorBinding }>) {
    let binding = ctx.props?.CONNECTORS;
    // Local preview emulates the same request-scoped capability. This branch and
    // the auxiliary service binding are absent from production builds.
    if (import.meta.env.DEV && !binding && env.CONNECTORS) {
      const preview = env.CONNECTORS;
      const expiresAt = Date.now() + 60_000;
      binding = {
        async getContext() {
          if (Date.now() >= expiresAt) return { status: "request_context_expired" };
          return preview.getContext?.() ?? { status: "binding_unavailable" };
        },
        async invoke(connectorId, actionName, args) {
          if (Date.now() >= expiresAt) {
            return { status: "request_context_expired", message: "This request has expired. Please try again." };
          }
          return preview.invoke(connectorId, actionName, args);
        },
      };
    }
    const response = await runWithConnectorBinding(binding, () => handler.fetch(request, env, ctx));
    return secureResponse(request, response, import.meta.env.DEV);
  },
};

export default worker;
