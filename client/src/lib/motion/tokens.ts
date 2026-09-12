/**
 * Shared motion tokens.
 *
 * One source of truth for durations and easings so Framer Motion, GSAP and the
 * CSS layer all move at the same speed. The product rule is that navigation and
 * feedback stay in the 150-350 ms band: animation must never make the user wait.
 */

export type Easing = [number, number, number, number];

/** "Ease out expo"-style curve used across the UI. */
export const EASE_OUT: Easing = [0.23, 1, 0.32, 1];
export const EASE_IN_OUT: Easing = [0.65, 0, 0.35, 1];
/** Restrained overshoot for entrance accents. */
export const EASE_SPRING: Easing = [0.34, 1.4, 0.64, 1];

/** CSS mirror of `EASE_OUT` for stylesheets and GSAP strings. */
export const EASE_OUT_CSS = "cubic-bezier(.23, 1, .32, 1)";
/** GSAP expects its own easing names. */
export const GSAP_EASE = "power3.out";

export const DURATION = {
  /** Micro feedback: hover, focus, toggle. */
  instant: 0.12,
  /** Small transitions: chips, tooltips, chevrons. */
  fast: 0.18,
  /** Default component transition. */
  base: 0.26,
  /** Cards, dialogs, page sections. */
  slow: 0.4,
  /** Hero choreography only. */
  hero: 0.9,
} as const;

export const STAGGER = {
  /** Tight list/card stagger. */
  tight: 0.04,
  /** Default container stagger. */
  base: 0.06,
  /** Section-level stagger. */
  loose: 0.1,
} as const;

export const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

const canQuery = () => typeof window !== "undefined" && typeof window.matchMedia === "function";

/**
 * Non-React reduced-motion read. Components should prefer Framer's
 * `useReducedMotion`; this exists for imperative code (GSAP timelines, the
 * Three.js render loop) that runs outside React.
 */
export function prefersReducedMotion(): boolean {
  return canQuery() ? window.matchMedia(REDUCED_MOTION_QUERY).matches : false;
}

/** Subscribes to reduced-motion changes so live toggles are respected. */
export function onReducedMotionChange(listener: (reduced: boolean) => void): () => void {
  if (!canQuery()) return () => undefined;
  const media = window.matchMedia(REDUCED_MOTION_QUERY);
  const handler = (event: MediaQueryListEvent) => listener(event.matches);
  media.addEventListener("change", handler);
  return () => media.removeEventListener("change", handler);
}

/**
 * Conservative low-power heuristic. Exported so the 3D layer can drop its
 * particle count and pixel ratio instead of guessing from the user agent.
 */
export function isLowPowerDevice(): boolean {
  if (typeof navigator === "undefined") return true;
  const cores = navigator.hardwareConcurrency ?? 0;
  const memory = (navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? 0;
  const smallViewport = typeof window !== "undefined" && window.innerWidth < 820;
  if (cores > 0 && cores <= 4) return true;
  if (memory > 0 && memory <= 4) return true;
  return smallViewport;
}

/** Feature-detects WebGL once, without leaking a probe context. */
let webglProbe: boolean | null = null;
export function supportsWebGL(): boolean {
  if (webglProbe !== null) return webglProbe;
  if (typeof document === "undefined") return (webglProbe = false);
  try {
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("webgl2") ?? canvas.getContext("webgl");
    webglProbe = Boolean(context);
    if (context && "getExtension" in context) {
      const lose = (context as WebGLRenderingContext).getExtension("WEBGL_lose_context");
      lose?.loseContext();
    }
  } catch {
    webglProbe = false;
  }
  return webglProbe;
}

/** Test seam so the WebGL fallback path can be exercised deterministically. */
export function resetWebglProbe() {
  webglProbe = null;
}
