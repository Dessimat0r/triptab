'use client';

import { useEffect, useRef, type ReactNode } from 'react';

const openModals: HTMLElement[] = [];
let originalOverflow: { body: string; document: string } | null = null;

const focusableSelector = [
  'a[href]', 'button', 'input:not([type="hidden"])', 'select', 'textarea',
  'summary', '[tabindex]', '[contenteditable="true"]',
].join(',');

function insideCollapsedDetails(element: HTMLElement) {
  for (let ancestor = element.parentElement; ancestor; ancestor = ancestor.parentElement) {
    if (!ancestor.matches('details:not([open])')) continue;
    const summary = Array.from(ancestor.children).find(child => child.tagName === 'SUMMARY');
    if (!summary?.contains(element)) return true;
  }
  return false;
}

function availableElements(root: HTMLElement) {
  return Array.from(root.querySelectorAll<HTMLElement>(focusableSelector)).filter(
    element => element.tabIndex >= 0 && !element.matches(':disabled') &&
      !element.closest('[hidden], [inert], [aria-hidden="true"]') &&
      !insideCollapsedDetails(element) &&
      element.getClientRects().length > 0 &&
      getComputedStyle(element).visibility !== 'hidden',
  );
}

function focusFirst(root: HTMLElement, preferInput = false) {
  const elements = availableElements(root);
  const preferred = elements.find(element => element.matches('[autofocus], [data-autofocus]')) ||
    (preferInput ? elements.find(element => element.matches('input, textarea, select')) : undefined);
  (preferred || elements[0] || root.querySelector<HTMLElement>('[role="dialog"]') || root)
    .focus({ preventScroll: true });
}

export default function ModalA11y({ children, onClose, className }: {
  children: ReactNode;
  onClose: () => void;
  className: string;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  // Capture before React applies autofocus to a child during the commit.
  const previousFocusRef = useRef<HTMLElement | null>(
    typeof document !== 'undefined' && document.activeElement instanceof HTMLElement
      ? document.activeElement : null,
  );

  useEffect(() => { closeRef.current = onClose; }, [onClose]);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const previousFocus = previousFocusRef.current;
    const dialog = root.querySelector<HTMLElement>('[role="dialog"]');
    const dialogTabIndex = dialog?.getAttribute('tabindex');
    if (dialog && dialogTabIndex === null) dialog.tabIndex = -1;

    if (!openModals.length) {
      originalOverflow = { body: document.body.style.overflow, document: document.documentElement.style.overflow };
      document.body.style.overflow = 'hidden';
      document.documentElement.style.overflow = 'hidden';
    }
    openModals.push(root);
    const isTopModal = () => openModals[openModals.length - 1] === root;

    function onKeyDown(event: KeyboardEvent) {
      if (!isTopModal() || event.defaultPrevented || event.isComposing) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        closeRef.current();
      } else if (event.key === 'Tab') {
        const elements = availableElements(root!);
        const first = elements[0];
        const last = elements[elements.length - 1];
        if (!first) {
          event.preventDefault();
          focusFirst(root!);
        } else if (!root!.contains(document.activeElement) ||
          (event.shiftKey && (document.activeElement === first || !elements.includes(document.activeElement as HTMLElement))) ||
          (!event.shiftKey && document.activeElement === last)) {
          event.preventDefault();
          (event.shiftKey ? last : first).focus({ preventScroll: true });
        }
      }
    }

    function onFocusIn(event: FocusEvent) {
      if (isTopModal() && event.target instanceof Node && !root!.contains(event.target)) focusFirst(root!);
    }

    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('focusin', onFocusIn);
    focusFirst(root, true);

    return () => {
      const wasTop = isTopModal();
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('focusin', onFocusIn);
      const index = openModals.indexOf(root);
      if (index !== -1) openModals.splice(index, 1);
      if (dialog && dialogTabIndex === null) dialog.removeAttribute('tabindex');
      if (!openModals.length && originalOverflow) {
        document.body.style.overflow = originalOverflow.body;
        document.documentElement.style.overflow = originalOverflow.document;
        originalOverflow = null;
      }
      if (wasTop) {
        const remaining = openModals[openModals.length - 1];
        if (previousFocus?.isConnected && (!remaining || remaining.contains(previousFocus))) previousFocus.focus({ preventScroll: true });
        else if (remaining) focusFirst(remaining);
      }
    };
  }, []);

  return <div ref={rootRef} className={className} role="none" tabIndex={-1}>{children}</div>;
}
