"use client";
import { t as uiText } from "@/lib/ui-language";


import { useId, useState } from "react";
import { profileFromAuth, type Profile, type AuthResponse } from "./account-panel";

export default function AuthPanel({
  onAuthenticated,
  initialMode = "register",
  compact = false,
}: {
  onAuthenticated: (profile: Profile) => void;
  initialMode?: "login" | "register";
  compact?: boolean;
}) {
  const id = useId();
  const [forgot, setForgot] = useState(false);
  const [message, setMessage] = useState("");
  const [mode, setMode] = useState(initialMode);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const registering = !forgot && mode === "register";

  return (
    <section
      className={`auth-panel${compact ? " compact" : ""}`}
      aria-labelledby={`${id}-title`}
    >
      <h2 id={`${id}-title`}>
        {forgot ? "Reset your password" : registering ? "Create your TripTab account" : "Sign in to TripTab"}
      </h2>
      <p className="auth-description">{uiText("Use your email to save holidays, share expenses, and join invitations. ChatGPT and Codex are optional, for receipt AI and natural-language help.")}</p>
      <p className="footnote">
        {registering
          ? "Save your password in a password manager. You can verify your email in account settings."
          : "If you previously linked ChatGPT, you can also sign in with that account."}
      </p>
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          if (busy) return;
          setBusy(true);
          setError("");
          try {
            const response = await fetch("/api/auth", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                action: forgot ? "request_password_reset" : mode,
                email: email.trim(),
                password,
                ...(registering ? { displayName: displayName.trim() } : {}),
              }),
            });
            const body = (await response.json()) as AuthResponse;
            if (forgot) { if (!response.ok) throw Error(body.error || "Unable to request recovery."); setMessage((body as AuthResponse & {notice?:string}).notice || "If this email has a password account, a recovery link has been sent."); return; }
            const profile = profileFromAuth(body);
            if (!response.ok || !profile) {
              throw Error(body.error || "Unable to sign in. Please try again.");
            }
            setPassword("");
            onAuthenticated(profile);
          } catch (cause) {
            setError(
              cause instanceof Error ? cause.message : "Unable to sign in.",
            );
          } finally {
            setBusy(false);
          }
        }}
      >
        {registering && (
          <label htmlFor={`${id}-name`}>{uiText("Display name")}<input
              id={`${id}-name`}
              required
              maxLength={50}
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
              autoComplete="nickname"
              placeholder={uiText("Your name")}
              disabled={busy}
            />
          </label>
        )}
        <label htmlFor={`${id}-email`}>{uiText("Email")}<input
            id={`${id}-email`}
            type="email"
            required
            maxLength={254}
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            autoComplete="email"
            inputMode="email"
            autoCapitalize="none"
            spellCheck={false}
            placeholder={uiText("you@example.com")}
            disabled={busy}
          />
        </label>
        {!forgot && <label htmlFor={`${id}-password`}>{uiText("Password")}<input
            id={`${id}-password`}
            type="password"
            required
            minLength={registering ? 12 : undefined}
            maxLength={128}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            autoComplete={registering ? "new-password" : "current-password"}
            aria-describedby={registering ? `${id}-password-hint` : undefined}
            disabled={busy}
          />
        </label>
        }
        {registering && (
          <small id={`${id}-password-hint`} className="muted">{uiText("Use 12–128 characters.")}</small>
        )}
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        {message && <p role="status">{message}</p>}
        <button className="primary" type="submit" disabled={busy}>
          {forgot ? busy ? "Sending…" : "Send recovery link" : busy
            ? registering
              ? "Creating account…"
              : "Signing in…"
            : registering
              ? "Create account"
              : "Sign in"}
        </button>
      </form>
      <p><button className="textbutton" type="button" disabled={busy} onClick={() => { setForgot(value => !value); setMode("login"); setError(""); setMessage(""); }}>{forgot ? "Back to sign in" : "Forgot password?"}</button></p>
      <p className="auth-switch">
        {registering ? "Already have a TripTab account?" : "New to TripTab?"}
        <button
          className="textbutton"
          type="button"
          disabled={busy}
          onClick={() => {
            setForgot(false); setMode(registering ? "login" : "register");
            setError(""); setMessage("");
          }}
        >
          {registering ? "Sign in" : "Create an account"}
        </button>
      </p>
    </section>
  );
}
