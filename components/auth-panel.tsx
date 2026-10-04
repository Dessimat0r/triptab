"use client";

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
  const [mode, setMode] = useState(initialMode);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const registering = mode === "register";

  return (
    <section
      className={`auth-panel${compact ? " compact" : ""}`}
      aria-labelledby={`${id}-title`}
    >
      <h2 id={`${id}-title`}>
        {registering ? "Create your TripTab account" : "Sign in to TripTab"}
      </h2>
      <p className="auth-description">
        Use your email to save holidays, share expenses, and join invitations.
        ChatGPT and Codex are optional, for receipt AI and natural-language help.
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
                action: mode,
                email: email.trim(),
                password,
                ...(registering ? { displayName: displayName.trim() } : {}),
              }),
            });
            const body = (await response.json()) as AuthResponse;
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
          <label htmlFor={`${id}-name`}>
            Display name
            <input
              id={`${id}-name`}
              required
              maxLength={50}
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
              autoComplete="nickname"
              placeholder="Your name"
              disabled={busy}
            />
          </label>
        )}
        <label htmlFor={`${id}-email`}>
          Email
          <input
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
            placeholder="you@example.com"
            disabled={busy}
          />
        </label>
        <label htmlFor={`${id}-password`}>
          Password
          <input
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
        {registering && (
          <small id={`${id}-password-hint`} className="muted">
            Use 12–128 characters.
          </small>
        )}
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <button className="primary" type="submit" disabled={busy}>
          {busy
            ? registering
              ? "Creating account…"
              : "Signing in…"
            : registering
              ? "Create account"
              : "Sign in"}
        </button>
      </form>
      <p className="auth-switch">
        {registering ? "Already have a TripTab account?" : "New to TripTab?"}
        <button
          className="textbutton"
          type="button"
          disabled={busy}
          onClick={() => {
            setMode(registering ? "login" : "register");
            setError("");
          }}
        >
          {registering ? "Sign in" : "Create an account"}
        </button>
      </p>
    </section>
  );
}
