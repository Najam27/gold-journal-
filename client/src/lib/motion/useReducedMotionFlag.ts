"use client";

import { useEffect, useState } from "react";

import { onReducedMotionChange, prefersReducedMotion } from "@/lib/motion/tokens";

/**
 * Small shared hook so any component can respect a live reduced-motion
 * preference without importing Framer Motion (useful in GSAP/Three contexts).
 */
export function useReducedMotionFlag(): boolean {
  const [reduced, setReduced] = useState(() => prefersReducedMotion());

  useEffect(() => {
    return onReducedMotionChange(setReduced);
  }, []);

  return reduced;
}
