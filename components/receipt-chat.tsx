"use client";

import { useId, useRef, useState } from "react";
import { MessageCircle, RefreshCw } from "lucide-react";
import type { ReceiptMessage } from "@/lib/model";

export type ReceiptChatProps = {
  messages: ReceiptMessage[];
  busy: boolean;
  onSend: (text: string) => Promise<boolean> | boolean;
  onRefresh: () => void;
};

function messageTime(createdAt: string) {
  const date = new Date(createdAt);
  return Number.isNaN(date.getTime())
    ? "Time unavailable"
    : date.toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      });
}

export default function ReceiptChat({ messages, busy, onSend, onRefresh }: ReceiptChatProps) {
  const titleId = useId();
  const questionId = useId();
  const hintId = useId();
  const errorId = useId();
  const [question, setQuestion] = useState("");
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState("");
  const sendingRef = useRef(false);
  const working = busy || sending;
  const replies = messages.filter(message => message.role === "assistant");
  const answered = new Set(replies.map(message => message.replyTo).filter(Boolean));

  async function sendQuestion() {
    const text = question.trim();
    if (!text || busy || sendingRef.current) return;
    sendingRef.current = true;
    setSending(true);
    setSendError("");
    try {
      const saved = await onSend(text);
      if (saved) setQuestion("");
      else setSendError("Your question could not be saved. Your draft is still here.");
    } catch {
      setSendError("Your question could not be saved. Your draft is still here.");
    } finally {
      sendingRef.current = false;
      setSending(false);
    }
  }

  return (
    <section className="receipt-chat" aria-labelledby={titleId} aria-busy={working}>
      <h3 id={titleId}>Discuss this receipt</h3>
      <p id={hintId} className="receipt-chat-hint">
        Questions are saved here. Use the copied prompt in your connected ChatGPT
        or Codex, then check for its reply.
      </p>
      {messages.length ? (
        <div className="receipt-chat-scroll" role="region" aria-label="Receipt conversation" tabIndex={0}>
          <ol className="receipt-chat-thread">
            {messages.map(message => (
              <li key={message.id} className={`receipt-chat-message ${message.role}`}>
                <div className="receipt-chat-message-heading">
                  <strong>{message.role === "user" ? "You" : "ChatGPT or Codex"}</strong>
                  <time dateTime={message.createdAt}>{messageTime(message.createdAt)}</time>
                </div>
                <p className="receipt-chat-text">{message.text}</p>
                {message.role === "user" && !answered.has(message.id) && (
                  <span className="receipt-chat-pending">Waiting for reply</span>
                )}
              </li>
            ))}
          </ol>
        </div>
      ) : (
        <p className="receipt-chat-empty">
          Ask about unclear items, missing charges or totals that do not match.
        </p>
      )}
      <div className="receipt-chat-announcement" role="status" aria-live="polite" aria-atomic="true">
        {replies.length > 0 ? `${replies.length} ${replies.length === 1 ? "reply is" : "replies are"} available from ChatGPT or Codex.` : ""}
      </div>
      <label htmlFor={questionId}>Receipt question</label>
      <textarea
        id={questionId}
        value={question}
        maxLength={4000}
        rows={3}
        aria-describedby={sendError ? `${hintId} ${errorId}` : hintId}
        disabled={working}
        onChange={event => {
          setQuestion(event.target.value);
          if (sendError) setSendError("");
        }}
      />
      <div className="receipt-chat-actions">
        <button type="button" className="primary" disabled={working || !question.trim()} onClick={() => void sendQuestion()}>
          <MessageCircle size={17} aria-hidden="true" />
          Ask ChatGPT / Codex
        </button>
        <button type="button" className="quiet" disabled={working} onClick={onRefresh}>
          <RefreshCw size={17} aria-hidden="true" />
          Check for replies
        </button>
      </div>
      {sendError && <p id={errorId} className="receipt-chat-error" role="alert">{sendError}</p>}
      <p className="receipt-chat-note">Proposed changes need your review before the expense is updated.</p>
    </section>
  );
}
