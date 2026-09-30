"use client";

import { useEffect, useState } from "react";

/**
 * Live border-box height of an element (0 while it isn't mounted). Returns a
 * callback ref, so it follows elements that mount conditionally. Used to
 * reserve in-flow space under viewport-fixed bars.
 */
export function useElementHeight<T extends HTMLElement>() {
  const [el, setEl] = useState<T | null>(null);
  const [height, setHeight] = useState(0);
  useEffect(() => {
    if (!el) {
      setHeight(0);
      return;
    }
    const apply = () => setHeight(el.offsetHeight);
    apply();
    const observer = new ResizeObserver(apply);
    observer.observe(el);
    return () => observer.disconnect();
  }, [el]);
  return [setEl, height] as const;
}
