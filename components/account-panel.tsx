"use client";
import { t as uiText } from "@/lib/ui-language";

import { useId, useState } from "react";
import { X, UserRound, LogOut, Sparkles } from "lucide-react";
import ModalA11y from "./modal-accessibility";
import PwaControls, { clearBrowserNotifications } from "./pwa-controls";
import AccountSecurity from "./account-security";
import { clearOfflineContext } from "@/lib/offline-store";
import DataExport from "./data-export";
import AccountActivityPanel from "./account-activity-panel";
import ReceiptAISettings from "./receipt-ai-settings";
import type { Trip } from "@/lib/model";
export type Profile = {
  id: string;
  email: string;
  displayName: string;
  authMethod?: "password" | "chatgpt";
  hasPassword?: boolean;
  chatgptConnected?: boolean;
  chatgptAvailable?: boolean;
  emailVerified?: boolean;
  uiLanguage?: "en"|"es"|"fr"|"de";
};
export type AuthResponse = {
  profile?: Profile;
  authenticated?: boolean;
  hasPassword?: boolean;
  chatgptLinked?: boolean;
  chatgptAvailable?: boolean;
  emailVerified?: boolean;
  notice?: string;
  error?: string;
};
export function profileFromAuth(body: AuthResponse): Profile | null {
  if (!body.profile) return null;
  return {
    ...body.profile,
    hasPassword: body.hasPassword ?? body.profile.hasPassword,
    chatgptConnected: body.chatgptLinked ?? body.profile.chatgptConnected,
    chatgptAvailable: body.chatgptAvailable ?? body.profile.chatgptAvailable,
    emailVerified: body.emailVerified ?? body.profile.emailVerified,
    authMethod:
      body.profile.authMethod ||
      (body.hasPassword ?? body.profile.hasPassword ? "password" : "chatgpt"),
  };
}
export default function AccountPanel({
  profile,
  onClose,
  onSaved,
  trips = [],
}: {
  profile: Profile | null;
  onClose: () => void;
  onSaved: (p: Profile) => void;
  trips?: Pick<Trip, "id" | "name">[];
}) {
  const id = useId();
  const chatgptLinkHref = "/signin-with-chatgpt?return_to=" + encodeURIComponent("/?connect=chatgpt");
  const [activityRefresh, setActivityRefresh] = useState(0);
  const refreshActivity = () => setActivityRefresh(value => value + 1);
  const [nameDraft, setName] = useState<string | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [password, setPassword] = useState(""),
    [currentPassword, setCurrentPassword] = useState(""),
    [passwordError, setPasswordError] = useState(""),
    [passwordBusy, setPasswordBusy] = useState(false),
    [accountError, setAccountError] = useState(""),
    [accountBusy, setAccountBusy] = useState(false);
  const name = nameDraft ?? profile?.displayName ?? "";
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
            <span className="eyebrow">{uiText("YOUR ACCOUNT")}</span>
            <h2 id="profile-title">{uiText("Profile & app settings")}</h2>
          </div>
          <button
            className="iconbutton"
            onClick={onClose}
            aria-label={uiText("Close profile")}
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
                <small>
                  {profile.emailVerified
                    ? uiText("Verified email")
                    : uiText("Email not verified")}
                </small>
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
                  refreshActivity();
                  onSaved({ ...profile, ...(b.profile || b) });
                } catch (e) {
                  setError(e instanceof Error ? e.message : "Unable to save");
                } finally {
                  setBusy(false);
                }
              }}
            >
              <label>{uiText("Display name")}<input
                  required
                  maxLength={50}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  autoComplete="nickname"
                />
              </label>
              {error && (
                <p className="error" role="alert">
                  {uiText(error)}
                </p>
              )}
              <button className="quiet phone-wide" disabled={busy}>
                {busy ? uiText("Saving…") : uiText("Save profile")}
              </button>
            </form>
            <section className="account-section">
              <h3>
                {profile.hasPassword
                  ? uiText("Change your password")
                  : uiText("Sign in with your email")}
              </h3>
              <p className="footnote">
                {profile.hasPassword
                  ? uiText("Changing your password signs out your other sessions.")
                  : uiText("Add a TripTab password to sign in without ChatGPT. Your holidays and profile stay in this account.")}
              </p>
              <p className="footnote">{uiText("Verify your email in account settings so you can recover your account if you forget your password.")}</p>
              <form
                onSubmit={async (event) => {
                  event.preventDefault();
                  if (passwordBusy) return;
                  setPasswordBusy(true);
                  setPasswordError("");
                  try {
                    const response = await fetch("/api/auth", {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({
                        action: "set_password",
                        password,
                        ...(profile.hasPassword ? { currentPassword } : {}),
                      }),
                    });
                    const body = (await response.json()) as AuthResponse;
                    const updatedProfile = profileFromAuth(body);
                    if (!response.ok || !updatedProfile)
                      throw Error(body.error || "Unable to save your password.");
                    setPassword("");
                    setCurrentPassword("");
                    refreshActivity();
                    onSaved(updatedProfile);
                  } catch (cause) {
                    setPasswordError(
                      cause instanceof Error
                        ? cause.message
                        : "Unable to save your password.",
                    );
                  } finally {
                    setPasswordBusy(false);
                  }
                }}
              >
                {profile.hasPassword && (
                  <label htmlFor={`${id}-current-password`}>{uiText("Current TripTab password")}<input
                      id={`${id}-current-password`}
                      type="password"
                      autoComplete="current-password"
                      maxLength={128}
                      required
                      value={currentPassword}
                      disabled={passwordBusy}
                      onChange={(event) =>
                        setCurrentPassword(event.target.value)
                      }
                    />
                  </label>
                )}
                <label htmlFor={`${id}-new-password`}>{uiText("New TripTab password")}<input
                    id={`${id}-new-password`}
                    type="password"
                    autoComplete="new-password"
                    minLength={12}
                    maxLength={128}
                    required
                    value={password}
                    disabled={passwordBusy}
                    onChange={(event) => setPassword(event.target.value)}
                    aria-describedby={`${id}-password-hint`}
                  />
                </label>
                <small id={`${id}-password-hint`} className="muted">{uiText("Use 12–128 characters.")}</small>
                {passwordError && (
                  <p className="error" role="alert">
                    {uiText(passwordError)}
                  </p>
                )}
                <button className="quiet phone-wide" disabled={passwordBusy}>
                  {passwordBusy
                    ? uiText("Saving password…")
                    : profile.hasPassword
                      ? uiText("Change password")
                      : uiText("Add password")}
                </button>
              </form>
            </section>
            <section className="account-section account-ai">
              <h3>
                <Sparkles size={17} aria-hidden="true" />{uiText(" Optional AI features")}</h3>
              <p className="footnote">{uiText("ChatGPT or Codex can help read receipts, resolve inconsistencies, and enter expenses in natural language. You can use all manual expense, receipt, and sharing features without connecting them.")}</p>
              {profile.chatgptConnected ? (
                <>
                  <p className="account-connection-status">{uiText("ChatGPT identity is linked.")}</p>
                  <p className="footnote">{uiText("External TripTab tool availability is unknown. Enable TripTab in the conversation you use for assistance. ChatGPT and Codex connections must each be checked in that client.")}</p>
                  <button
                    className="quiet"
                    disabled={accountBusy || !profile.hasPassword}
                    onClick={async () => {
                      setAccountBusy(true);
                      setAccountError("");
                      try {
                        const response = await fetch("/api/auth", {
                          method: "POST",
                          headers: { "Content-Type": "application/json" },
                          body: JSON.stringify({ action: "unlink_chatgpt" }),
                        });
                        const body = (await response.json()) as AuthResponse;
                        const updatedProfile = profileFromAuth(body);
                        if (!response.ok || !updatedProfile)
                          throw Error(body.error || "Unable to unlink ChatGPT.");
                        refreshActivity();
                        onSaved(updatedProfile);
                      } catch (cause) {
                        setAccountError(
                          cause instanceof Error
                            ? cause.message
                            : "Unable to unlink ChatGPT.",
                        );
                      } finally {
                        setAccountBusy(false);
                      }
                    }}
                  >
                    {accountBusy ? uiText("Unlinking…") : uiText("Unlink ChatGPT")}
                  </button>
                  {!profile.hasPassword && (
                    <small className="muted">{uiText("Add a TripTab password above before unlinking ChatGPT so you can still sign in.")}</small>
                  )}
                </>
              ) : (
                <a
                  className="quiet account-link"
                  href={chatgptLinkHref}
                >{uiText("Link ChatGPT · optional")}</a>
              )}
              {accountError && (
                <p className="error" role="alert">
                  {uiText(accountError)}
                </p>
              )}
            </section>
            <ReceiptAISettings key={profile.id} accountId={profile.id} verificationHref={chatgptLinkHref} onChanged={refreshActivity} />
          </>
        ) : (
          <p className="footnote">{uiText("Create a TripTab account with your email to save your profile and holidays. ChatGPT and Codex are optional.")}</p>
        )}
        {profile && <AccountSecurity key={profile.id} profile={profile} onSaved={onSaved} />}
        {profile && <DataExport key={profile.id} trips={trips} />}
        {profile && <AccountActivityPanel key={profile.id} accountId={profile.id} refreshKey={activityRefresh} />}
        <PwaControls accountId={profile?.id} onChanged={refreshActivity} />
        {profile && (
          <div className="account-signout">
            <button
              className="quiet"
              disabled={accountBusy}
              onClick={async () => {
                setAccountBusy(true);
                setAccountError("");
                try {
                  const response = await fetch("/api/auth", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ action: "logout" }),
                  });
                  if (!response.ok) throw Error("Unable to sign out.");
                  await clearBrowserNotifications().catch(() => {});
                  await clearOfflineContext().catch(() => {});
                  const destination =
                    profile.chatgptAvailable || profile.authMethod === "chatgpt"
                      ? "/signout-with-chatgpt?return_to=/"
                      : "/";
                  window.location.assign(
                    new URL(destination, window.location.origin).href,
                  );
                } catch (cause) {
                  setAccountError(
                    cause instanceof Error ? cause.message : "Unable to sign out.",
                  );
                  setAccountBusy(false);
                }
              }}
            >
              <LogOut size={16} />{uiText(" Sign out")}</button>
          </div>
        )}
      </section>
    </ModalA11y>
  );
}
