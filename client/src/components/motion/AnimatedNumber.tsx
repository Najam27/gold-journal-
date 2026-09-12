import React, { useEffect, useMemo, useRef } from "react";
import { animate, useMotionValue, useReducedMotion, useTransform, motion } from "framer-motion";
import { DURATION, EASE_OUT } from "@/lib/motion/tokens";

type Props = {
  /** The real value from the journal. This component never invents numbers. */
  value: number;
  /** Formats the interpolated value, e.g. `n => formatMoney(n)`. */
  format?: (value: number) => string;
  /** Optional override for how long the transition to a new value takes. */
  duration?: number;
  className?: string;
  /** Rendered instead of the number when `value` is not finite. */
  fallback?: string;
};

const defaultFormat = (value: number) => String(Math.round(value));

/**
 * Animates a number from its previous value to the new one.
 *
 * Used for trading statistics and P&L so a changing figure is legible rather
 * than a hard jump. Under `prefers-reduced-motion` the value is applied
 * instantly — the number is always the real journal value, never a placeholder.
 */
export function AnimatedNumber({ value, format, duration = DURATION.slow, className, fallback = "—" }: Props) {
  const reduced = useReducedMotion();
  const formatValue = useMemo(() => format ?? defaultFormat, [format]);
  const motionValue = useMotionValue(value);
  const display = useTransform(motionValue, latest => formatValue(latest));
  const first = useRef(true);

  useEffect(() => {
    if (reduced) {
      motionValue.set(value);
      first.current = false;
      return;
    }
    // The first paint shows the real value immediately; only later changes
    // animate, so a page load never shows a number counting up from zero.
    if (first.current) {
      motionValue.set(value);
      first.current = false;
      return;
    }
    const controls = animate(motionValue, value, { duration, ease: EASE_OUT });
    return () => controls.stop();
  }, [value, reduced, duration, motionValue]);

  if (!Number.isFinite(value)) return <span className={className}>{fallback}</span>;
  return <motion.span className={className}>{display}</motion.span>;
}
