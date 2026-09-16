import { useEffect, useRef, useState, type ReactNode } from "react";

import { REDUCED_MOTION_QUERY } from "@/lib/motion/tokens";

type TiltCardProps = {
  children: ReactNode;
  className?: string;
  /** Maximum rotation in degrees. The design budget is 1–3. */
  max?: number;
  /** Lift in pixels applied while the pointer is inside. */
  lift?: number;
};

/**
 * Optional perspective tilt for a small number of high-level cards.
 *
 * Deliberately conservative:
 * - transform only, so layout never reflows and no child re-renders (the value
 *   is written straight to the node's style from a pointer handler);
 * - disabled entirely on touch / coarse pointers, narrow viewports and
 *   `prefers-reduced-motion`, where it renders a plain wrapper;
 * - resets smoothly on pointer leave and cancels on window blur.
 */
export function TiltCard({ children, className, max = 2.4, lift = 4 }: TiltCardProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [enabled, setEnabled] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const fine = window.matchMedia("(hover: hover) and (pointer: fine)");
    const wide = window.matchMedia("(min-width: 1024px)");
    const reduced = window.matchMedia(REDUCED_MOTION_QUERY);
    const evaluate = () => setEnabled(fine.matches && wide.matches && !reduced.matches);
    evaluate();
    fine.addEventListener("change", evaluate);
    wide.addEventListener("change", evaluate);
    reduced.addEventListener("change", evaluate);
    return () => {
      fine.removeEventListener("change", evaluate);
      wide.removeEventListener("change", evaluate);
      reduced.removeEventListener("change", evaluate);
    };
  }, []);

  useEffect(() => {
    if (!enabled) return;
    const node = ref.current;
    if (!node) return;

    let frame = 0;
    let rect: DOMRect | null = null;

    const reset = () => {
      node.style.transform = "";
      rect = null;
    };

    const onEnter = () => {
      rect = node.getBoundingClientRect();
    };

    const onMove = (event: PointerEvent) => {
      if (event.pointerType !== "mouse") return;
      if (!rect) rect = node.getBoundingClientRect();
      const x = (event.clientX - rect.left) / rect.width - 0.5;
      const y = (event.clientY - rect.top) / rect.height - 0.5;
      if (frame) return;
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        node.style.transform = `perspective(1200px) rotateX(${(-y * max).toFixed(2)}deg) rotateY(${(x * max).toFixed(2)}deg) translateY(${-lift}px)`;
      });
    };

    node.addEventListener("pointerenter", onEnter);
    node.addEventListener("pointermove", onMove);
    node.addEventListener("pointerleave", reset);
    window.addEventListener("blur", reset);
    return () => {
      if (frame) window.cancelAnimationFrame(frame);
      node.removeEventListener("pointerenter", onEnter);
      node.removeEventListener("pointermove", onMove);
      node.removeEventListener("pointerleave", reset);
      window.removeEventListener("blur", reset);
      node.style.transform = "";
    };
  }, [enabled, lift, max]);

  return (
    <div ref={ref} className={className ? `gj-tilt ${className}` : "gj-tilt"}>
      {children}
    </div>
  );
}
