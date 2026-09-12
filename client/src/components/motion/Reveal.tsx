import React from "react";
import { motion, useReducedMotion } from "framer-motion";
import type { ReactNode } from "react";
import { DURATION, EASE_OUT } from "@/lib/motion/tokens";

type RevealProps = {
  children: ReactNode;
  className?: string;
  /** Seconds to wait before starting. Keep small; entrance must never gate data. */
  delay?: number;
  /** Vertical travel in pixels. Negative values come from above. */
  y?: number;
  /** Horizontal travel in pixels. */
  x?: number;
  duration?: number;
  /**
   * `inView` animates the first time the element scrolls into view (marketing
   * sections, long pages). `mount` animates immediately when rendered.
   */
  mode?: "mount" | "inView";
  /** Only animate the first time (ignored by `mode: "mount"`). */
  once?: boolean;
  /** Extra scroll margin so a reveal fires slightly before it is on screen. */
  margin?: string;
};

/**
 * Entrance animation for a block of content.
 *
 * Purely presentational: it never delays rendering, so local-first journal
 * writes and MT5 updates still paint in the same tick. Under
 * `prefers-reduced-motion` the content renders with no transition at all.
 */
export function Reveal({
  children,
  className,
  delay = 0,
  y = 14,
  x = 0,
  duration = DURATION.slow,
  mode = "inView",
  once = true,
  margin = "0px 0px -12% 0px",
}: RevealProps) {
  const reduced = useReducedMotion();

  if (reduced) {
    return <div className={className}>{children}</div>;
  }

  const hidden = { opacity: 0, y, x };
  const shown = { opacity: 1, y: 0, x: 0 };
  const transition = { duration, delay, ease: EASE_OUT };

  if (mode === "mount") {
    return (
      <motion.div className={className} initial={hidden} animate={shown} transition={transition}>
        {children}
      </motion.div>
    );
  }

  return (
    <motion.div
      className={className}
      initial={hidden}
      whileInView={shown}
      viewport={{ once, margin }}
      transition={transition}
    >
      {children}
    </motion.div>
  );
}
