"use client";

import { languageName } from "@/lib/receipt-languages";
import type { AccountAuditEvent } from "@/lib/audit";
import { ActivityChanges, auditRecord, auditSource, auditText, auditTimestamp, useActivityPages, type AuditChange } from "./activity-panel";

function accountChanges(event: AccountAuditEvent): AuditChange[] {
  const before = auditRecord(event.before) || {}, after = auditRecord(event.after) || {}, result: AuditChange[] = [];
  const add = (key: string, label: string, format: (value: unknown) => string) => {
    if (!Object.is(before[key], after[key])) result.push({ label, before: format(before[key]), after: format(after[key]) });
  };
  const yesNo = (value: unknown) => value === true ? "Yes" : value === false ? "No" : "Not recorded";
  add("readingLanguage", "Reading language", languageName);
  const display=(value:unknown)=>value==="reading"?"Reading language first":value==="receipt"?"Receipt original first":"Holiday display default";
  add("primaryVersion", "Holiday display preference", display);
  add("itemVersion", "Item display preference", display);
  add("itemKey", "Receipt item", value=>auditText(value)||"Not recorded");
  add("displayName", "Profile display name", value => auditText(value) || "Not recorded");
  add("hasPassword", "Password sign-in available", yesNo);
  add("active", event.entityId === "account" ? "Other browser sessions active" : "Browser session active", yesNo);
  add("connected", "ChatGPT account connected", yesNo);
  add("service", "Notification delivery service", value => auditText(value) || "Not recorded");
  add("reason", "Reason", value => ({ enabled_on_device: "Enabled in this browser", disabled_on_device: "Disabled in this browser", logout_or_account_switch: "Signed out or switched accounts", provider_expired: "Notification provider expired the browser subscription" }[auditText(value)] || auditText(value) || "Not recorded"));
  for (const [key, label] of Object.entries({ enabled: "Push notifications enabled", subscribed: "Browser subscribed", subscriptionActive: "Browser subscription active", permissionGranted: "Notification permission granted" })) add(key, label, yesNo);
  // Password changes deliberately record true → true without credential data.
  if (!result.length && event.entityType === "password" && event.action === "update") result.push({ label: "Password", before: "Previous password configured", after: "Password changed; its value is never recorded" });
  if (!result.length && event.entityType === "session") result.push({ label: "Browser sessions", before: event.action === "create" ? "Not signed in" : "Signed in", after: event.action === "delete" ? "Signed out or revoked" : "Signed in" });
  if (!result.length && event.entityType === "notifications") result.push({ label: "Browser notifications", before: "Previous notification setting", after: event.action === "delete" ? "Browser subscription removed" : "Browser subscription saved" });
  return result;
}

function accountLabel(event: AccountAuditEvent): string {
  return ({ profile: "profile", password: "password sign-in", session: event.entityId === "account" ? "other browser sessions" : "browser session", chatgpt: "ChatGPT connection", notifications: "browser notifications", language: "receipt language preferences" }[event.entityType]) || "account setting";
}

export default function AccountActivityPanel({ refreshKey = 0, accountId }: { refreshKey?: number; accountId?: string }) {
  const history = useActivityPages<AccountAuditEvent>("/api/account-activity", `private-account:${accountId || ""}`, refreshKey, "userId", accountId);
  return <section className="account-section account-activity" aria-label="Private account activity" aria-busy={history.loading}>
    <h3>Account activity</h3>
    <p className="footnote">Only you can see this account history. It records profile, sign-in, connection, notification and personal language changes without passwords or sign-in credentials.</p>
    {history.error ? <button type="button" className="quiet" disabled={history.loading} onClick={history.retry}>Retry account activity</button> : <p className="footnote">History updates automatically.</p>}
    {history.loading && <p role="status">{history.events.length ? "Checking account activity…" : "Loading account activity…"}</p>}
    {history.error && <p className="error" role="alert">{history.error}</p>}
    {!history.loading && !history.error && !history.events.length && <p className="footnote">No recorded account changes yet.</p>}
    <ol className="activity-list">{history.events.map(event => <li className="activity-event" key={event.id}>
      <p><strong>{event.actorName || "You"}</strong> {({ create: "added", update: "updated", delete: "removed" }[event.action]) || "changed"} <strong>{accountLabel(event)}</strong></p>
      <p className="footnote"><time dateTime={event.createdAt}>{auditTimestamp(event.createdAt)}</time> · {auditSource(event.source)}</p>
      <details>
        <summary>View account change</summary>
        <dl className="activity-identifiers">
          <div><dt>Recorded at</dt><dd><time dateTime={event.createdAt}>{auditTimestamp(event.createdAt, true)}</time></dd></div>
          <div><dt>Account</dt><dd>{event.userId}</dd></div>
          <div><dt>Change reference</dt><dd>{event.id}</dd></div>
          {event.entityType === "session" && <div><dt>Session scope</dt><dd>{event.entityId === "account" ? "Browser sessions revoked when the password changed" : "Current browser"}</dd></div>}
          {event.entityType === "notifications" && <>
            <div><dt>Notification delivery service</dt><dd>{auditText(event.after?.service) || auditText(event.before?.service) || "Not recorded"}</dd></div>
            <div><dt>Browser subscription reference</dt><dd>{event.entityId}</dd></div>
          </>}
        </dl>
        <ActivityChanges fields={accountChanges(event)} before={!!event.before} after={!!event.after} />
      </details>
    </li>)}</ol>
    {history.nextCursor !== null && <button type="button" className="quiet" disabled={history.loading} onClick={history.loadOlder}>{history.loading ? "Loading…" : "Load older account changes"}</button>}
  </section>;
}
