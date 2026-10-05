"use client";

import { useEffect } from "react";
import { startReveal } from "./motion";

/**
 * Mounts the scroll reveal (lib/motion.ts) for the landing page on screen.
 * Renders nothing. `watch` re-runs it when the previewed draft changes.
 */
export function LandingMotion({ watch }: { watch?: unknown }) {
  useEffect(() => startReveal(document, window), [watch]);
  return null;
}
