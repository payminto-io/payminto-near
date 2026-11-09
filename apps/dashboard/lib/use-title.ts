"use client";

import { useEffect } from "react";

/**
 * Refines the tab title once a detail screen knows its subject, e.g. "Settlement #3 - Payminto".
 * Next.js may write the route's static metadata title after this effect runs, so the title is re-asserted while mounted.
 */
export function useDocumentTitle(title: string | null | undefined, suffix = "Payminto") {
  useEffect(() => {
    if (!title) return;
    const want = `${title} - ${suffix}`;
    const path = window.location.pathname;
    document.title = want;
    const observer = new MutationObserver(() => {
      // Only on this screen: after a navigation the next route's title wins.
      if (window.location.pathname === path && document.title !== want) document.title = want;
    });
    observer.observe(document.head, { subtree: true, childList: true, characterData: true });
    return () => observer.disconnect();
  }, [title, suffix]);
}
