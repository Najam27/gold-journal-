import React from "react";
import { motion, useReducedMotion, type Variants } from "framer-motion";
import type { ReactNode } from "react";
import { DURATION, EASE_OUT, STAGGER } from "@/lib/motion/tokens";

type StaggerProps = {
  children: ReactNode;
  className?: string;
  /** Seconds between children. */
  gap?: number;
  /** Delay before the first child starts. */
  delay?: number;
  /** Wait until the container scrolls into view. */
  inView?: boolean;
  once?: boolean;
};

/**
 * Container that releases its `StaggerItem` children in sequence.
 *
 * Used for card grids and analysis sections. The stagger is intentionally
 * short (40-100 ms) so a dashboard of eight cards settles well under a second
 * and never blocks the user from interacting with already-painted content.
 */
export function Stagger({
  children,
  className,
  gap = STAGGER.base,
  delay = 0,
  inView = false,
  once = true,
}: StaggerProps) {
  const reduced = useReducedMotion();

  if (reduced) {
    return <div className={className}>{children}</div>;
  }

  const container: Variants = {
    hidden: {},
    shown: { transition: { staggerChildren: gap, delayChildren: delay } },
  };

  if (inView) {
    return (
      <motion.div
        className={className}
        variants={container}
        initial="hidden"
        whileInView="shown"
        viewport={{ once, margin: "0px 0px -10% 0px" }}
      >
        {children}
      </motion.div>
    );
  }

  return (
    <motion.div className={className} variants={container} initial="hidden" animate="shown">
      {children}
    </motion.div>
  );
}

type StaggerItemProps = {
  children: ReactNode;
  className?: string;
  y?: number;
  duration?: number;
};

/** A single element inside a `Stagger` container. */
export function StaggerItem({ children, className, y = 12, duration = DURATION.slow }: StaggerItemProps) {
  const reduced = useReducedMotion();
  if (reduced) return <div className={className}>{children}</div>;

  const item: Variants = {
    hidden: { opacity: 0, y },
    shown: { opacity: 1, y: 0, transition: { duration, ease: EASE_OUT } },
  };

  return (
    <motion.div className={className} variants={item}>
      {children}
    </motion.div>
  );
}
