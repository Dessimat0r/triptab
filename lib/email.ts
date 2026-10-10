// Transactional email for account recovery and verification. Delivery is
// optional: without a configured provider, the actions that need it explain
// that email is unavailable instead of pretending a message was sent.
export type EmailMessage = { to: string; subject: string; text: string; html: string };
export type Mailer = (message: EmailMessage) => Promise<void>;

export class EmailDeliveryError extends Error {}

type EmailEnvironment = { RESEND_API_KEY?: string; EMAIL_FROM?: string };

/** Resend's HTTP API; any provider with the same small surface can replace it. */
export function resendMailer(apiKey: string, from: string, fetcher: typeof fetch = fetch): Mailer {
  return async message => {
    const response = await fetcher('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, to: [message.to], subject: message.subject, text: message.text, html: message.html }),
      redirect: 'manual',
      signal: AbortSignal.timeout(10_000),
    });
    // Never log provider responses: they can echo the recipient address.
    await response.body?.cancel().catch(() => {});
    if (!response.ok) throw new EmailDeliveryError('Email delivery failed.');
  };
}

function localRequest(request: Request) {
  const url = new URL(request.url);
  return url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
}

/**
 * The configured provider, or for loopback development only, a console mailer
 * so links can be followed without a provider. Production never logs links.
 */
export function configuredMailer(env: EmailEnvironment, request: Request): Mailer | null {
  const apiKey = env.RESEND_API_KEY?.trim(), from = env.EMAIL_FROM?.trim();
  if (apiKey && from) return resendMailer(apiKey, from);
  if (localRequest(request)) return async message => {
    console.info(`[TripTab development email] To: ${message.to}\nSubject: ${message.subject}\n\n${message.text}`);
  };
  return null;
}

const escape = (value: string) => value.replace(/[&<>"']/g, character => `&#${character.charCodeAt(0)};`);

function message(to: string, subject: string, intro: string, action: string, link: string, footer: string): EmailMessage {
  return {
    to, subject,
    text: `${intro}\n\n${action}:\n${link}\n\n${footer}\n\n— TripTab`,
    html: `<p>${escape(intro)}</p><p><a href="${escape(link)}">${escape(action)}</a></p>`
      + `<p style="color:#666">${escape(footer)}</p><p>— TripTab</p>`,
  };
}

/** Tokens travel in the fragment, so they never reach server or proxy logs. */
export function emailLink(request: Request, kind: 'verify-email' | 'reset-password', token: string) {
  return `${new URL('/', request.url).origin}/#${kind}=${token}`;
}

export function verificationEmail(to: string, link: string): EmailMessage {
  return message(to, 'Confirm your TripTab email', 'Confirm that this address belongs to your TripTab account.',
    'Confirm my email', link, 'This link works once and expires in 24 hours. If you did not create a TripTab account, ignore this email.');
}

export function passwordResetEmail(to: string, link: string): EmailMessage {
  return message(to, 'Reset your TripTab password', 'Someone asked to reset the password for the TripTab account that uses this address.',
    'Choose a new password', link, 'This link works once and expires in 1 hour. Resetting signs out every other device. If you did not ask for this, ignore this email; your password has not changed.');
}
