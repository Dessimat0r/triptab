"use client";
import { useEffect, useState } from "react";
import { Link, Copy, Users, Check } from "lucide-react";
import type { Trip } from "@/lib/model";
import type { Profile } from "./account-panel";
export function TripSharing({
  trip,
  profile,
}: {
  trip: Trip;
  profile: Profile | null;
}) {
  const [memberId, setMemberId] = useState(""),
    [email, setEmail] = useState(""),
    [link, setLink] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [copied, setCopied] = useState(false);
  const available = trip.members.filter((m) => !m.userId);
  useEffect(() => {
    Promise.resolve().then(() => {
      setMemberId(trip.members.find((m) => !m.userId)?.id || "");
      setLink("");
      setError("");
    });
  }, [trip.id, trip.members]);
  if (trip.ownerId && trip.ownerId !== profile?.id)
    return (
      <p className="footnote">
        The holiday organiser can invite people to join this trip.
      </p>
    );
  return (
    <div className="panel sharing-panel">
      <h3>Invite a traveller</h3>
      <p className="footnote">
        Share a one-use link. They sign in with ChatGPT, set up their profile,
        and join the same holiday.
      </p>
      {available.length ? (
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            setError("");
            setCopied(false);
            try {
              const r = await fetch("/api/invite", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  mode: "create",
                  tripId: trip.id,
                  memberId: memberId || available[0].id,
                  email: email.trim() || undefined,
                }),
              });
              const b = (await r.json()) as { url: string; error: string };
              if (!r.ok) throw Error(b.error || "Unable to create invite");
              setLink(b.url);
            } catch (e) {
              setError(
                e instanceof Error ? e.message : "Unable to create invite",
              );
            } finally {
              setBusy(false);
            }
          }}
        >
          <label>
            Invite as
            <select
              value={memberId || available[0].id}
              onChange={(e) => {
                setMemberId(e.target.value);
                setLink("");
              }}
            >
              {available.map((m) => (
                <option value={m.id} key={m.id}>
                  {m.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Email restriction <span className="muted">optional</span>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="traveller@example.com"
              autoComplete="off"
            />
          </label>
          <button className="quiet" disabled={busy}>
            <Link size={16} />
            {busy ? "Creating…" : "Create invite link"}
          </button>
        </form>
      ) : (
        <p className="footnote">
          All travellers are linked to an account. Add another traveller to
          invite someone new.
        </p>
      )}
      {link && (
        <div className="invite-link">
          <input
            readOnly
            value={link}
            aria-label="Invitation link"
            onFocus={(e) => e.currentTarget.select()}
          />
          <button
            className="quiet"
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(link);
                setCopied(true);
              } catch {
                setError("Select and copy the invitation link above.");
              }
            }}
          >
            {copied ? <Check size={16} /> : <Copy size={16} />}{" "}
            {copied ? "Copied" : "Copy"}
          </button>
          <small>Expires in 7 days · One use</small>
        </div>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
export function JoinTrip({
  token,
  onJoined,
}: {
  token: string;
  onJoined: (id: string) => void;
}) {
  const [info, setInfo] = useState<{
      tripId: string;
      tripName: string;
      memberName: string;
      alreadyMember?: boolean;
    } | null>(null),
    [error, setError] = useState(""),
    [auth, setAuth] = useState(false),
    [busy, setBusy] = useState(false),
    [displayName, setDisplayName] = useState("");
  useEffect(() => {
    fetch("/api/invite?token=" + encodeURIComponent(token))
      .then(async (r) => {
        const b = (await r.json()) as {
          tripId: string;
          tripName: string;
          memberName: string;
          alreadyMember?: boolean;
          error: string;
        };
        if (!r.ok) {
          setAuth(r.status === 401);
          throw Error(b.error || "Invitation unavailable");
        }
        setInfo(b);
        setDisplayName(b.memberName);
      })
      .catch((e) => setError(e.message));
  }, [token]);
  return (
    <div className="panel join-panel">
      <div className="large-icon">
        <Users size={30} />
      </div>
      <h2>{info ? `Join ${info.tripName}` : "Your holiday invitation"}</h2>
      <p>
        {info
          ? `You’ve been invited as ${info.memberName}. Your account will be linked to this traveller.`
          : "Sign in to view your invitation and join the holiday."}
      </p>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {auth ? (
        <a
          className="primary"
          href={
            "/signin-with-chatgpt?return_to=" +
            encodeURIComponent("/?invite=" + token)
          }
        >
          Sign in with ChatGPT
        </a>
      ) : info?.alreadyMember ? (
        <button className="primary" onClick={() => onJoined(info.tripId)}>
          Open holiday
        </button>
      ) : (
        info && (
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              setBusy(true);
              setError("");
              try {
                const pr = await fetch("/api/profile", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ displayName: displayName.trim() }),
                });
                if (!pr.ok) throw Error("Unable to save your profile.");
                const r = await fetch("/api/invite", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ mode: "accept", token }),
                });
                const b = (await r.json()) as { tripId: string; error: string };
                if (!r.ok) throw Error(b.error || "Unable to join");
                onJoined(b.tripId || info.tripId);
              } catch (e) {
                setError(e instanceof Error ? e.message : "Unable to join");
              } finally {
                setBusy(false);
              }
            }}
          >
            <label>
              Your display name
              <input
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                maxLength={50}
                required
                autoComplete="nickname"
              />
            </label>
            <button className="primary" disabled={busy}>
              {busy ? "Joining…" : "Set up profile & join holiday"}
            </button>
          </form>
        )
      )}
    </div>
  );
}
