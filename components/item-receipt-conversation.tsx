"use client";

import { useState } from "react";
import ReceiptChat, { type ReceiptChatProps } from "./receipt-chat";

/** Closed item discussions should not render the entire receipt conversation. */
export default function ItemReceiptConversation(props: ReceiptChatProps & { itemId: string; scopeLabel: string }) {
  const [visited, setVisited] = useState(false);
  return <details className="item-conversation" onToggle={event => {
    if (event.currentTarget.open) setVisited(true);
  }}>
    <summary>Discuss {props.scopeLabel}</summary>
    {/* Keep a visited chat mounted so collapsing it preserves the typed question. */}
    {visited && <ReceiptChat {...props} contextTitle={`Discuss ${props.scopeLabel}`} />}
  </details>;
}
