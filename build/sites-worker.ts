import handler from "vinext/server/fetch-handler";
import { runWithConnectorBinding } from "../lib/connector-context";
import type { ConnectorBinding } from "../lib/connector-contract.mjs";

export function secureResponse(request: Request, response: Response, development = false): Response {
  const headers = new Headers(response.headers);
  // Sites can embed the app in ChatGPT. Limit framing to that trusted host and
  // our own origin instead of SAMEORIGIN, which would break the Sites preview.
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

const worker = {
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
