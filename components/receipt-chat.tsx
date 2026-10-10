"use client";
import { t as uiText } from "@/lib/ui-language";

import { formatInstant } from "@/lib/dates";

import { useId, useRef, useState } from "react";
import { MessageCircle, RefreshCw } from "lucide-react";
import type { ReceiptMessage } from "@/lib/model";
import type { ReceiptMemory } from "@/lib/receipt-context";
import "./receipt-chat-context.css";

export type ReceiptChatProps = {
  messages: ReceiptMessage[];
  busy: boolean;
  itemId?: string;
  scopeLabel?: string;
  contextTitle?: string;
  itemNames?: Record<string, string>;
  memberNames?: Record<string, string>;
  currentMemberId?: string;
  memory?: ReceiptMemory;
  error?: string;
  refreshError?: string;
  offline?: boolean;
  nativeAvailable?: boolean;
  onRetry?: (questionId: string) => Promise<boolean>;
  onSend: (text: string, itemId?: string) => Promise<boolean> | boolean;
  onRefresh: () => void;
};

function messageTime(value: string) { return formatInstant(value, { year: false }); }

export default function ReceiptChat({ messages, busy, itemId, scopeLabel, contextTitle, itemNames, memberNames, currentMemberId, memory, error, refreshError, offline, nativeAvailable = false, onRetry, onSend, onRefresh }: ReceiptChatProps) {
  const titleId = useId();
  const questionId = useId();
  const hintId = useId();
  const errorId = useId();
  const [question, setQuestion] = useState("");
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState("");
  const sendingRef = useRef(false);
  const working = busy || sending;
  // Older replies may predate the explicit item field. Their saved question
  // still supplies the context; receipt-level discussion retains every thread.
  const questions = new Map(messages.filter(message => message.role === "user").map(message => [message.id, message]));
  const messageItem = (message: ReceiptMessage) => message.itemId || (message.replyTo ? questions.get(message.replyTo)?.itemId : undefined);
  const visibleMessages = itemId ? messages.filter(message => messageItem(message) === itemId) : messages;
  const replies = visibleMessages.filter(message => message.role === "assistant");
  const answered = new Set(replies.map(message => message.replyTo).filter(Boolean));
  const itemLabel = scopeLabel || (itemId && itemNames?.[itemId]) || uiText("this item");
  const heading = contextTitle || (itemId ? uiText("Discuss {item}", { item: itemLabel }) : uiText("Discuss this receipt"));
  const questionLabel = itemId ? uiText("Question about {item}", { item: itemLabel }) : uiText("Receipt question");
  const visibleError = sendError || error;
  const authorLabel = (message: ReceiptMessage) => {
    if (message.role === "assistant") return uiText("Assistant");
    if (message.authorMemberId) {
      if (message.authorMemberId === currentMemberId) return uiText("You");
      return message.authorName || memberNames?.[message.authorMemberId] || uiText("Earlier traveller");
    }
    return message.authorName || uiText("Earlier traveller");
  };

  async function sendQuestion() {
    const text = question.trim();
    if (!text || busy || sendingRef.current) return;
    sendingRef.current = true;
    setSending(true);
    setSendError("");
    try {
      const saved = await onSend(text, itemId);
      if (saved) setQuestion("");
      else setSendError("Your question could not be saved. Your draft is still here.");
    } catch {
      setSendError("Your question could not be saved. Your draft is still here.");
    } finally {
      sendingRef.current = false;
      setSending(false);
    }
  }

  async function retryQuestion(id: string) {
    if (!onRetry || working || sendingRef.current) return;
    sendingRef.current = true; setSending(true); setSendError("");
    try { await onRetry(id); }
    catch { setSendError("Unable to get a reply. Your saved question is still here."); }
    finally { sendingRef.current = false; setSending(false); }
  }

  return (
    <section className="receipt-chat" aria-labelledby={titleId} aria-busy={working} data-item-id={itemId}>
      <h3 id={titleId}>{heading}</h3>
      <p id={hintId} className="receipt-chat-hint">
        {nativeAvailable ? uiText("Ask about who bought what, quantities, names or location. The assistant remembers this receipt and proposes changes for review.") : uiText("Questions are saved here and a prompt is prepared. Use it in a ChatGPT or Codex conversation with TripTab tools enabled. Replies appear here automatically.")}
      </p>
      {itemId && <p className="receipt-chat-scope">{uiText("“This” refers to ")}{itemLabel}{uiText(". You can also ask about other items or the whole receipt.")}</p>}
      {memory && <details className="receipt-chat-memory">
        <summary>{uiText("Remembered receipt context")}</summary>
        <p className="receipt-chat-hint">{uiText("Saved with this receipt for the assistant. All item discussions share these notes and names.")}</p>
        {memory.notes && <p className="receipt-chat-memory-notes">{memory.notes}</p>}
        {memory.aliases.length > 0 && <ul className="receipt-chat-aliases">
          {memory.aliases.map((alias, index) => <li key={`${alias.name}:${index}`}>
            <strong>{alias.name}</strong>
            <span>{alias.itemId ? itemNames?.[alias.itemId] || uiText("Earlier item") : alias.memberId ? memberNames?.[alias.memberId] || uiText("Earlier traveller") : uiText("Saved name")}
              {alias.scopeMemberId ? uiText(" · for {value0}", { value0: memberNames?.[alias.scopeMemberId] || uiText("an earlier traveller") }) : ""}</span>
          </li>)}
        </ul>}
        {!memory.notes && memory.aliases.length === 0 && <p className="receipt-chat-empty">{uiText("No notes or names remembered yet.")}</p>}
      </details>}
      {visibleMessages.length ? (
        <div className="receipt-chat-scroll" role="region" aria-label={itemId ? uiText("{value0} conversation", { value0: itemLabel }) : uiText("Receipt conversation")} tabIndex={0}>
          <ol className="receipt-chat-thread">
            {visibleMessages.map(message => (
              <li key={message.id} className={`receipt-chat-message ${message.role}`}>
                <div className="receipt-chat-message-heading">
                  <strong>{authorLabel(message)}</strong>
                  <time dateTime={message.createdAt}>{messageTime(message.createdAt)}</time>
                </div>
                {messageItem(message) && <span className="receipt-chat-context">{itemNames?.[messageItem(message)!] || (messageItem(message) === itemId && scopeLabel) || uiText("Earlier item")}</span>}
                <p className="receipt-chat-text">{message.text}</p>
                {message.role === "user" && !answered.has(message.id) && (
                  <div className="receipt-chat-pending-row"><span className="receipt-chat-pending">{nativeAvailable ? uiText("Question saved · awaiting reply") : uiText("Question saved · external processing needed")}</span>{nativeAvailable && onRetry && <button type="button" className="textbutton" disabled={working || offline} onClick={() => void retryQuestion(message.id)}><RefreshCw size={14} aria-hidden="true" />{uiText("Retry reply")}</button>}</div>
                )}
              </li>
            ))}
          </ol>
        </div>
      ) : (
        <p className="receipt-chat-empty">
          {itemId ? uiText("Ask about this item’s quantity, price or cost shares, or anything else on the receipt.") : uiText("Ask about unclear items, missing charges or totals that do not match.")}
        </p>
      )}
      <div className="receipt-chat-announcement" role="status" aria-live="polite" aria-atomic="true">
        {replies.length > 0 ? uiText(itemId ? replies.length === 1 ? "1 reply is available from the assistant about {item}." : "{count} replies are available from the assistant about {item}." : replies.length === 1 ? "1 reply is available from the assistant." : "{count} replies are available from the assistant.", { count: replies.length, item: itemLabel }) : ""}
      </div>
      <label htmlFor={questionId}>{questionLabel}</label>
      <textarea
        id={questionId}
        value={question}
        autoComplete="off"
        maxLength={4000}
        rows={3}
        aria-describedby={visibleError ? `${hintId} ${errorId}` : hintId}
        disabled={working}
        onChange={event => {
          setQuestion(event.target.value);
          if (sendError) setSendError("");
        }}
      />
      <div className="receipt-chat-actions">
        <button type="button" className="primary" disabled={working || !question.trim()} onClick={() => void sendQuestion()}>
          <MessageCircle size={17} aria-hidden="true" />
          {nativeAvailable ? uiText("Ask assistant") : uiText("Save question & prepare prompt")}
        </button>
        {refreshError && !offline && <button type="button" className="quiet" disabled={working} onClick={onRefresh}>
          <RefreshCw size={17} aria-hidden="true" />{uiText("Retry updates")}</button>}
      </div>
      {visibleError && <p id={errorId} className="receipt-chat-error" role="alert">{uiText(visibleError)}</p>}
      <p className="receipt-chat-note" role="status">{offline ? uiText("You’re offline. Replies will update when you reconnect. ") : refreshError ? uiText("Unable to refresh replies. We’ll keep trying automatically. ") : ""}{uiText("Proposed changes need your review before the expense is updated.")}</p>
    </section>
  );
}
