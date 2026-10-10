'use client';

import { useEffect, useRef, type ReactNode, type RefObject } from 'react';
import { useVisualViewportBounds } from '@/components/visual-viewport';

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

export function useModalLayer(rootRef: RefObject<HTMLElement | null>, { active, onClose, initialFocus, restoreFocus }: {
  active: boolean;
  onClose: () => void;
  /** Where focus starts; by default the first field, then the first focusable element. */
  initialFocus?: (root: HTMLElement) => HTMLElement | null;
  /** Where focus returns on close; by default the element focused when the layer opened. */
  restoreFocus?: () => HTMLElement | null;
}) {
  const closeRef = useRef(onClose);
  const focusTargets = useRef({ initialFocus, restoreFocus });
  // Capture before React applies autofocus to a child during the commit.
  const previousFocusRef = useRef<HTMLElement | null>(
    active && typeof document !== 'undefined' && document.activeElement instanceof HTMLElement
      ? document.activeElement : null,
  );

  useEffect(() => { closeRef.current = onClose; }, [onClose]);
  useEffect(() => { focusTargets.current = { initialFocus, restoreFocus }; }, [initialFocus, restoreFocus]);

  useEffect(() => {
    const root = rootRef.current;
    if (!active || !root) return;
    const previousFocus = previousFocusRef.current ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
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
        event.preventDefault();
        if (!elements.length) focusFirst(root!);
        else {
          // Safari's keyboard-navigation setting can skip buttons/links and
          // move focus to browser chrome without a DOM focusin event. Advance
          // within the visible modal explicitly instead of relying on that hop.
          const index = elements.indexOf(document.activeElement as HTMLElement);
          const next = index < 0 ? (event.shiftKey ? elements.length - 1 : 0)
            : (index + (event.shiftKey ? -1 : 1) + elements.length) % elements.length;
          elements[next].focus({ preventScroll: true });
        }
      }
    }

    function onFocusIn(event: FocusEvent) {
      if (isTopModal() && event.target instanceof Node && !root!.contains(event.target)) focusFirst(root!);
    }

    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('focusin', onFocusIn);
    const initial = focusTargets.current.initialFocus?.(root);
    if (initial) initial.focus({ preventScroll: true });
    else focusFirst(root, true);

    return () => {
      previousFocusRef.current = null;
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
        const target = focusTargets.current.restoreFocus?.() ?? previousFocus;
        if (target?.isConnected && (!remaining || remaining.contains(target))) target.focus({ preventScroll: true });
        else if (remaining) focusFirst(remaining);
      }
    };
  }, [active, rootRef]);

}

export default function ModalA11y({ children, onClose, className }: {
  children: ReactNode;
  onClose: () => void;
  className: string;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  // Declared first so that on close its cleanup clears data-keyboard-open, which
  // hides the page, before the layer restores focus to an element on that page.
  useVisualViewportBounds(rootRef);
  useModalLayer(rootRef, { active: true, onClose });

  return <div ref={rootRef} className={className} role="none" tabIndex={-1}>{children}</div>;
}
