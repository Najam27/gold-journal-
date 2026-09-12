import React from "react";
import { motion, useReducedMotion } from "framer-motion";
import type { ReactNode } from "react";
import { DURATION, EASE_OUT } from "@/lib/motion/tokens";

type PageTransitionProps = {
  /** Changing this value replays the entrance animation for the new view. */
  viewKey: string;
  children: ReactNode;
  className?: string;
};

/**
 * Short entrance for a top-level view change.
 *
 * Deliberately renders the incoming view immediately rather than waiting on an
 * exit animation: the journal, MT5 numbers and AI results are live data, and
 * gating them behind choreography would make navigation feel slower than no
 * animation at all. Duration stays in the 150-350 ms band.
 */
export function PageTransition({ viewKey, children, className }: PageTransitionProps) {
  const reduced = useReducedMotion();
  if (reduced) return <div className={className}>{children}</div>;

  return (
    <motion.div
      key={viewKey}
      className={className}
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: DURATION.base, ease: EASE_OUT }}
    >
      {children}
    </motion.div>
  );
}
