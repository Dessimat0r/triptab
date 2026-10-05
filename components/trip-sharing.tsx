"use client";
import { useCallback, useEffect, useState } from "react";
import { Link, Copy, Users, Check } from "lucide-react";
import type { Trip, TravellerFinancialPreview } from "@/lib/model";
import type { Profile } from "./account-panel";
import { useConfirmation } from "./confirmation-dialog";

type Invitation = {
  id: string; memberId: string; memberName: string; email: string | null; expiresAt: string;
};
type InvitationList = { invitations: Invitation[]; hasMore: boolean; error?: string };

export function TripSharing({ trip, profile, onChanged }: { trip: Trip; profile: Profile | null; onChanged?: () => void | Promise<unknown> }) {
  const [memberId, setMemberId] = useState(""),
    [email, setEmail] = useState(""),
    [link, setLink] = useState(""),
    [linkId, setLinkId] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [copied, setCopied] = useState(false),
    [invitations, setInvitations] = useState<InvitationList & { key: string }>({ key: "", invitations: [], hasMore: false });
  const available = trip.members.filter(member => !member.userId);
  const availableKey = JSON.stringify(available.map(member => ({ id: member.id })));
  const owner = trip.ownerId === profile?.id;
  const memberName = (invitation: { memberId: string; memberName: string }) => trip.members.find(member => member.id === invitation.memberId)?.name ?? invitation.memberName;
  const invitationKey = `${trip.id}:${profile?.id || ""}`;
  const { confirm, dialog: confirmationDialog, confirming } = useConfirmation(invitationKey);
  const listed = invitations.key === invitationKey ? invitations : { invitations: [], hasMore: false, error: undefined };
  const refreshInvitations = useCallback(async () => {
    if (!owner) return;
    try {
      const response = await fetch(`/api/invite?mode=list&tripId=${encodeURIComponent(trip.id)}`, { cache: "no-store" });
      const body = await response.json() as InvitationList;
      if (!response.ok) throw Error(body.error || "Unable to load invitations.");
      setInvitations({ ...body, key: invitationKey });
    } catch (cause) {
      setInvitations({ key: invitationKey, invitations: [], hasMore: false, error: cause instanceof Error ? cause.message : "Unable to load invitations." });
    }
  }, [invitationKey, owner, trip.id]);
  useEffect(() => {
    Promise.resolve().then(() => {
      const ids = (JSON.parse(availableKey) as { id: string }[]).map(member => member.id);
      setMemberId(previous => ids.includes(previous) ? previous : ids[0] || "");
      setLink(""); setLinkId(""); setError("");
      void refreshInvitations();
    });
  }, [trip.id, availableKey, refreshInvitations]);

  async function createLink(target: string, inviteeEmail: string) {
    if (busy) return;
    setBusy(true); setError(""); setCopied(false);
    try {
      const response = await fetch("/api/invite", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: "create", tripId: trip.id, memberId: target, email: inviteeEmail.trim() || undefined }),
      });
      const body = await response.json() as { url: string; invitationId: string; error?: string };
      if (!response.ok) throw Error(body.error || "Unable to create an invitation.");
      setMemberId(target); setEmail(inviteeEmail); setLink(body.url); setLinkId(body.invitationId);
      await refreshInvitations();
      await onChanged?.();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to create an invitation.");
    } finally { setBusy(false); }
  }

  if (!owner) return <p className="footnote">The holiday organiser can invite people to join this trip.</p>;
  return <div className="panel sharing-panel">
    <h3>Invite a traveller</h3>
    <p className="footnote">Share a one-use link. They create a TripTab account with their email or sign in, then review the traveller’s saved expenses and payments before joining. ChatGPT is optional.</p>
    <p className="footnote">Creating a new link replaces earlier unused links for the same traveller.</p>
    {available.length ? <form onSubmit={event => { event.preventDefault(); void createLink(memberId || available[0].id, email); }}>
      <label>Invite as
        <select value={memberId || available[0].id} disabled={busy} onChange={event => { setMemberId(event.target.value); setLink(""); setLinkId(""); }}>
          {available.map(member => <option value={member.id} key={member.id}>{member.name}</option>)}
        </select>
      </label>
      <label>Invitee email <span className="muted">optional</span>
        <input type="email" value={email} disabled={busy} onChange={event => setEmail(event.target.value)} placeholder="traveller@example.com" autoComplete="off" />
        <small>If supplied, the account email must match. Email addresses are not verified by TripTab, so share the link only with the intended traveller.</small>
      </label>
      <button className="quiet" disabled={busy}><Link size={16} aria-hidden="true" />{busy ? "Creating…" : "Create invite link"}</button>
    </form> : <p className="footnote">All travellers are linked to an account. Add another traveller to invite someone new.</p>}
    {link && <div className="invite-link">
      <input readOnly value={link} aria-label="Invitation link" onFocus={event => event.currentTarget.select()} />
      <button className="quiet" onClick={async () => {
        try { await navigator.clipboard.writeText(link); setCopied(true); }
        catch { setError("Select and copy the invitation link above."); }
      }}>{copied ? <Check size={16} aria-hidden="true" /> : <Copy size={16} aria-hidden="true" />}{copied ? "Copied" : "Copy"}</button>
      <small>Expires in 7 days · One use · Only this newly created link can be copied here</small>
    </div>}
    <section className="invite-management" aria-labelledby={`invite-list-${trip.id}`}>
      <h3 id={`invite-list-${trip.id}`}>Active invitations</h3>
      {listed.error ? <p className="error" role="alert">{listed.error}</p> : listed.invitations.length ? <ul className="invite-management-list">
        {listed.invitations.map(invitation => <li className="invite-management-entry" key={invitation.id}>
          <div className="invite-management-details">
            <strong>{memberName(invitation)}</strong>
            {invitation.email && <small>{invitation.email}</small>}
            <small>Expires <time dateTime={invitation.expiresAt}>{new Date(invitation.expiresAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}</time></small>
          </div>
          <div className="invite-management-actions">
            <button type="button" className="quiet" disabled={busy || confirming} onClick={() => void createLink(invitation.memberId, invitation.email || "")}>Replace link</button>
            <button type="button" className="danger quiet" disabled={busy || confirming} onClick={async () => {
              if (busy || !await confirm({ title: "Revoke invitation?", message: `Revoke the invitation for ${memberName(invitation)}? Its link will stop working.`, confirmLabel: "Revoke invitation", destructive: true })) return;
              setBusy(true); setError("");
              try {
                const response = await fetch("/api/invite", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ mode: "revoke", tripId: trip.id, invitationId: invitation.id }) });
                const body = await response.json() as { error?: string };
                if (!response.ok) throw Error(body.error || "Unable to revoke this invitation.");
                if (linkId === invitation.id) { setLink(""); setLinkId(""); }
                await onChanged?.();
              } catch (cause) { setError(cause instanceof Error ? cause.message : "Unable to revoke this invitation."); }
              finally { await refreshInvitations(); setBusy(false); }
            }}>Revoke</button>
          </div>
        </li>)}
      </ul> : <p className="footnote">No active invitations.</p>}
      {listed.hasMore && <p className="footnote">More older invitations exist. Replace a traveller’s link to invalidate all their earlier unused links.</p>}
      <button type="button" className="textbutton" disabled={busy} onClick={() => void refreshInvitations()}>Refresh invitations</button>
    </section>
    {error && <p className="error" role="alert">{error}</p>}
    {confirmationDialog}
  </div>;
}

type JoinInfo = {
  tripId: string; tripName: string; memberName: string; alreadyMember?: boolean;
  history: TravellerFinancialPreview; historySnapshot: string; error?: string;
};
export function JoinTrip({ token, onJoined, onAuthenticate }: {
  token: string; onJoined: (id: string) => void; onAuthenticate?: () => void;
}) {
  const [info, setInfo] = useState<JoinInfo | null>(null),
    [error, setError] = useState(""),
    [auth, setAuth] = useState(false),
    [busy, setBusy] = useState(false),
    [acceptedHistory, setAcceptedHistory] = useState(false);
  const refreshInfo = useCallback(async (signal?: AbortSignal) => {
    const response = await fetch("/api/invite?token=" + encodeURIComponent(token), { cache: "no-store", signal });
    const body = await response.json() as JoinInfo;
    if (signal?.aborted) return;
    setAcceptedHistory(false);
    if (!response.ok) { setAuth(response.status === 401); setInfo(null); throw Error(body.error || "Invitation unavailable."); }
    setAuth(false); setInfo(body);
  }, [token]);
  useEffect(() => {
    const controller = new AbortController();
    void Promise.resolve().then(() => refreshInfo(controller.signal)).catch(cause => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "Invitation unavailable."); });
    return () => controller.abort();
  }, [refreshInfo]);
  const history = info?.history;
  const money = (value: number) => new Intl.NumberFormat("en-GB", { style: "currency", currency: history!.currency, minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value / 100);
  return <div className="panel join-panel">
    <div className="large-icon"><Users size={30} aria-hidden="true" /></div>
    <h2>{info ? `Join ${info.tripName}` : "Your holiday invitation"}</h2>
    <p>{info ? `You’ve been invited as ${info.memberName}. Your account will take over this traveller’s recorded history and share access to this holiday.` : "Sign in to view your invitation and join the holiday."}</p>
    {error && <p className="error" role="alert">{error}</p>}
    {auth ? onAuthenticate ? <button className="primary" type="button" onClick={onAuthenticate}>Create an account or sign in</button>
      : <a className="primary" href={"/?account=login&invite=" + encodeURIComponent(token)}>Create an account or sign in</a>
      : info?.alreadyMember ? <button className="primary" onClick={() => onJoined(info.tripId)}>Open holiday</button>
      : info && history && <form onSubmit={async event => {
        event.preventDefault(); if (busy || !acceptedHistory) return;
        setBusy(true); setError("");
        try {
          const response = await fetch("/api/invite", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ mode: "accept", token, acceptHistory: true, historySnapshot: info.historySnapshot }) });
          const body = await response.json() as { tripId?: string; error?: string };
          if (!response.ok) {
            if (response.status === 409) await refreshInfo();
            throw Error(body.error || "Unable to join.");
          }
          onJoined(body.tripId || info.tripId);
        } catch (cause) { setError(cause instanceof Error ? cause.message : "Unable to join."); }
        finally { setBusy(false); }
      }}>
        <section className="join-history" aria-labelledby="join-history-title">
          <h3 id="join-history-title">{info.memberName}’s saved financial history</h3>
          <p className="join-history-counts">{history.expenseCount} {history.expenseCount === 1 ? "expense" : "expenses"} involving this traveller · {history.paymentCount} recorded {history.paymentCount === 1 ? "payment" : "payments"} · {history.currency}</p>
          {history.available ? <>
            <dl className="join-history-totals">
              <div><dt>Cost share</dt><dd>{money(history.costShare)}</dd></div>
              <div><dt>Paid upfront</dt><dd>{money(history.paidUpfront)}</dd></div>
              <div><dt>Payments sent</dt><dd>{money(history.paymentsSent)}</dd></div>
              <div><dt>Payments received</dt><dd>{money(history.paymentsReceived)}</dd></div>
              <div><dt>{history.netBalance < 0 ? "Still owes" : history.netBalance > 0 ? "Should receive" : "Settled up"}</dt><dd>{money(Math.abs(history.netBalance))}</dd></div>
            </dl>
            <p className="footnote">Paid upfront − cost share + payments sent − payments received = balance. These amounts use the saved item splits and currency conversions.</p>
          </> : <p className="error" role="alert">{history.message} Ask the organiser to review these expenses before relying on the totals.</p>}
          <p className="footnote">Joining links these existing records to your account. It does not record a payment or transfer any money.</p>
        </section>
        <label className="join-history-confirm">
          <input type="checkbox" required checked={acceptedHistory} disabled={busy} onChange={event => setAcceptedHistory(event.target.checked)} />
          <span>I have reviewed this history and agree to join as {info.memberName}.</span>
        </label>
        <button className="primary" disabled={busy || !acceptedHistory}>{busy ? "Joining…" : "Confirm history & join holiday"}</button>
      </form>}
  </div>;
}
