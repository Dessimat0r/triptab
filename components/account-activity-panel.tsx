"use client";
import { t as uiText } from "@/lib/ui-language";


import { displayLanguageName } from "@/lib/receipt-languages";
import type { AccountAuditEvent } from "@/lib/audit";
import { ActivityChanges, auditRecord, auditSource, auditText, auditTimestamp, useActivityPages, type AuditChange } from "./activity-panel";

function accountChanges(event: AccountAuditEvent): AuditChange[] {
  const before = auditRecord(event.before) || {}, after = auditRecord(event.after) || {}, result: AuditChange[] = [];
  const add = (key: string, label: string, format: (value: unknown) => string) => {
    if (!Object.is(before[key], after[key])) result.push({ label, before: format(before[key]), after: format(after[key]) });
  };
  const yesNo = (value: unknown) => value === true ? "Yes" : value === false ? "No" : "Not recorded";
  add("readingLanguage", "Reading language", displayLanguageName);
  const display=(value:unknown)=>value==="reading"?"Reading language first":value==="receipt"?"Receipt original first":"Holiday display default";
  add("primaryVersion", "Holiday display preference", display);
  add("itemVersion", "Item display preference", display);
  add("itemKey", "Receipt item", value=>auditText(value)||"Not recorded");
  add("displayName", "Profile display name", value => auditText(value) || "Not recorded");
  add("hasPassword", "Password sign-in available", yesNo);
  add("active", event.entityId === "account" ? "Other browser sessions active" : "Browser session active", yesNo);
  add("connected", "ChatGPT account connected", yesNo);
  add("verified", "Email address confirmed", yesNo);
  add("emailVerified", "Email address confirmed", yesNo);
  add("method", "Method", value => auditText(value) || "Not recorded");
  add("holidayName", "Holiday", value => auditText(value) || "Not recorded");
  add("archived", "Holiday archived for you", yesNo);
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
  return ({ profile: "profile", password: "password sign-in", session: event.entityId === "account" ? "other browser sessions" : "browser session", chatgpt: "ChatGPT connection", notifications: "browser notifications", language: "receipt language preferences", email: "email confirmation", trip: "holiday archive" }[event.entityType]) || "account setting";
}

export default function AccountActivityPanel({ refreshKey = 0, accountId }: { refreshKey?: number; accountId?: string }) {
  const history = useActivityPages<AccountAuditEvent>("/api/account-activity", `private-account:${accountId || ""}`, refreshKey, "userId", accountId);
  return <section className="account-section account-activity" aria-label={uiText("Private account activity")} aria-busy={history.loading}>
    <h3>{uiText("Account activity")}</h3>
    <p className="footnote">{uiText("Only you can see this account history. It records profile, sign-in, email confirmation, connection, notification, holiday archive and personal language changes without passwords or sign-in credentials.")}</p>
    {history.error ? <button type="button" className="quiet" disabled={history.loading} onClick={history.retry}>{uiText("Retry account activity")}</button> : <p className="footnote">{uiText("History updates automatically.")}</p>}
    {history.loading && <p role="status">{history.events.length ? uiText("Checking account activity…") : uiText("Loading account activity…")}</p>}
    {history.error && <p className="error" role="alert">{history.error}</p>}
    {!history.loading && !history.error && !history.events.length && <p className="footnote">{uiText("No recorded account changes yet.")}</p>}
    <ol className="activity-list">{history.events.map(event => <li className="activity-event" key={event.id}>
      <p><strong>{event.actorName || uiText("You")}</strong> {({ create: "added", update: "updated", delete: "removed" }[event.action]) || uiText("changed")} <strong>{accountLabel(event)}</strong></p>
      <p className="footnote"><time dateTime={event.createdAt}>{auditTimestamp(event.createdAt)}</time> · {auditSource(event.source)}</p>
      <details>
        <summary>{uiText("View account change")}</summary>
        <dl className="activity-identifiers">
          <div><dt>{uiText("Recorded at")}</dt><dd><time dateTime={event.createdAt}>{auditTimestamp(event.createdAt, true)}</time></dd></div>
          <div><dt>{uiText("Account")}</dt><dd>{event.userId}</dd></div>
          <div><dt>{uiText("Change reference")}</dt><dd>{event.id}</dd></div>
          {event.entityType === "session" && <div><dt>{uiText("Session scope")}</dt><dd>{event.entityId === "account" ? uiText("Browser sessions revoked when the password changed") : uiText("Current browser")}</dd></div>}
          {event.entityType === "notifications" && <>
            <div><dt>{uiText("Notification delivery service")}</dt><dd>{auditText(event.after?.service) || auditText(event.before?.service) || uiText("Not recorded")}</dd></div>
            <div><dt>{uiText("Browser subscription reference")}</dt><dd>{event.entityId}</dd></div>
          </>}
        </dl>
        <ActivityChanges fields={accountChanges(event)} before={!!event.before} after={!!event.after} />
      </details>
    </li>)}</ol>
    {history.nextCursor !== null && <button type="button" className="quiet phone-wide" disabled={history.loading} onClick={history.loadOlder}>{history.loading ? uiText("Loading…") : uiText("Load older account changes")}</button>}
  </section>;
}
