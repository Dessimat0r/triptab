"use client";
import { useState } from "react";
import { X, UserRound } from "lucide-react";
import ModalA11y from "./modal-accessibility";
import PwaControls from "./pwa-controls";
export type Profile = { id: string; email: string; displayName: string };
export default function AccountPanel({
  profile,
  onClose,
  onSaved,
}: {
  profile: Profile | null;
  onClose: () => void;
  onSaved: (p: Profile) => void;
}) {
  const [name, setName] = useState(profile?.displayName || ""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  return (
    <ModalA11y className="overlay" onClose={onClose}>
      <section
        className="modal small"
        role="dialog"
        aria-modal="true"
        aria-labelledby="profile-title"
      >
        <div className="modalheading">
          <div>
            <span className="eyebrow">YOUR ACCOUNT</span>
            <h2 id="profile-title">Profile & app settings</h2>
          </div>
          <button
            className="iconbutton"
            onClick={onClose}
            aria-label="Close profile"
          >
            <X />
          </button>
        </div>
        {profile ? (
          <>
            <div className="profile-email">
              <UserRound size={20} />
              <span>
                {profile.email}
                <small>Verified by your ChatGPT sign-in</small>
              </span>
            </div>
            <form
              onSubmit={async (e) => {
                e.preventDefault();
                setBusy(true);
                setError("");
                try {
                  const r = await fetch("/api/profile", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ displayName: name.trim() }),
                  });
                  const b = (await r.json()) as Profile & {
                    profile?: Profile;
                    error?: string;
                  };
                  if (!r.ok) throw Error(b.error || "Unable to save profile");
                  onSaved(b.profile || b);
                } catch (e) {
                  setError(e instanceof Error ? e.message : "Unable to save");
                } finally {
                  setBusy(false);
                }
              }}
            >
              <label>
                Display name
                <input
                  required
                  maxLength={50}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  autoComplete="nickname"
                />
              </label>
              {error && (
                <p className="error" role="alert">
                  {error}
                </p>
              )}
              <button className="quiet" disabled={busy}>
                {busy ? "Saving…" : "Save profile"}
              </button>
            </form>
          </>
        ) : (
          <p className="footnote">
            Sign in with ChatGPT to create your profile and link your verified
            email.
          </p>
        )}
        <PwaControls />
      </section>
    </ModalA11y>
  );
}
