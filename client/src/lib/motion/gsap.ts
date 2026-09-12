import { useEffect, useRef } from "react";
import { gsap } from "gsap";

import { prefersReducedMotion } from "@/lib/motion/tokens";

/**
 * Mounts a GSAP entrance timeline on the referenced root element.
 *
 * GSAP owns the hero choreography (multi-element sequencing, staggered
 * children) while Framer Motion keeps owning component-level transitions —
 * the two never animate the same property of the same element.
 *
 * Cleanup: the timeline is killed on unmount and its inline styles are
 * cleared so a hot swap between views never leaves residue.
 */
export function useGsapTimeline(
  build: (root: HTMLElement) => gsap.core.Timeline | void,
  deps: unknown[] = []
) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const root = ref.current;
    if (!root || prefersReducedMotion()) return;
    const context = gsap.context(() => {
      const timeline = build(root);
      timeline?.pause(0.001); // ensure deterministic start before playing
      timeline?.play();
    }, root);
    return () => {
      context.revert();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return ref;
}

/** Framer-free count-up used for dashboard stats. Returns nothing; animates in place. */
export function countUpInPlace(
  element: HTMLElement,
  format: (value: number) => string,
  to: number,
  duration = 0.8
) {
  if (prefersReducedMotion()) {
    element.textContent = format(to);
    return;
  }
  const state = { value: 0 };
  gsap.to(state, {
    value: to,
    duration,
    ease: "power3.out",
    onUpdate: () => {
      element.textContent = format(state.value);
    },
  });
}
