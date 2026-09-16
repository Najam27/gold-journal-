import { useEffect, useRef, useState } from "react";

import type { Premium3DTone } from "@/components/three/PremiumScene";
import { supportsWebGL } from "@/lib/motion/tokens";

export type { Premium3DTone };

type PremiumSceneFactory = (options: {
  canvas: HTMLCanvasElement;
  tone: Premium3DTone;
  dark: boolean;
  onReady?: () => void;
}) => { dispose: () => void; setDark: (dark: boolean) => void };

let sceneFactoryPromise: Promise<PremiumSceneFactory> | undefined;

/**
 * Three.js stays out of the initial bundle: the chunk is fetched the first time
 * a premium surface actually mounts, then cached for the rest of the session.
 */
function loadSceneFactory(): Promise<PremiumSceneFactory> {
  sceneFactoryPromise ??= import("@/components/three/PremiumScene").then(
    module => module.createPremiumScene as unknown as PremiumSceneFactory
  );
  return sceneFactoryPromise;
}

type Premium3DBackgroundProps = {
  tone?: Premium3DTone;
  className?: string;
  /** Mounts the WebGL scene only after the surface scrolls into view. */
  lazy?: boolean;
  "data-testid"?: string;
};

/**
 * Selective 3D background for hero-scale surfaces (splash, login, dashboard
 * hero, AI mentor, analytics hero).
 *
 * Safety contract:
 * - the CSS gradient/orbit fallback is always painted, so the surface is never
 *   blank while (or if) WebGL loads;
 * - if Three.js fails, throws, or WebGL is unavailable, the fallback stays and
 *   the app keeps working;
 * - the canvas pauses off-screen, disposes on unmount, and never re-renders
 *   React on animation frames.
 */
export function Premium3DBackground({
  tone = "gold",
  className,
  lazy = true,
  "data-testid": testId,
}: Premium3DBackgroundProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [active, setActive] = useState(!lazy);
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (active || !lazy) return;
    const host = hostRef.current;
    if (!host || typeof IntersectionObserver === "undefined") {
      setActive(true);
      return;
    }
    const observer = new IntersectionObserver(
      entries => {
        if (entries.some(entry => entry.isIntersecting)) {
          setActive(true);
          observer.disconnect();
        }
      },
      { rootMargin: "180px" }
    );
    observer.observe(host);
    return () => observer.disconnect();
  }, [active, lazy]);

  useEffect(() => {
    if (!active) return;
    if (!supportsWebGL()) {
      setFailed(true);
      return;
    }
    const canvas = canvasRef.current;
    if (!canvas) return;

    let handle: { dispose: () => void; setDark: (dark: boolean) => void } | undefined;
    let cancelled = false;
    let themeObserver: MutationObserver | undefined;

    loadSceneFactory()
      .then(createScene => {
        if (cancelled) return;
        const readDark = () => document.documentElement.classList.contains("dark");
        handle = createScene({
          canvas,
          tone,
          dark: readDark(),
          onReady: () => {
            if (!cancelled) setReady(true);
          },
        });
        themeObserver = new MutationObserver(() => handle?.setDark(readDark()));
        themeObserver.observe(document.documentElement, {
          attributes: true,
          attributeFilter: ["class"],
        });
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });

    return () => {
      cancelled = true;
      themeObserver?.disconnect();
      handle?.dispose();
    };
  }, [active, tone]);

  return (
    <div
      ref={hostRef}
      className={`premium-3d ${ready ? "is-ready" : ""} ${className ?? ""}`}
      data-testid={testId}
      aria-hidden="true"
    >
      {active && !failed && <canvas ref={canvasRef} />}
      {(!ready || failed) && <div className="premium-3d-fallback" />}
    </div>
  );
}
