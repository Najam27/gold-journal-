import React, { useEffect, useRef, useState } from "react";

import { prefersReducedMotion, supportsWebGL } from "@/lib/motion/tokens";

type SceneFactory = (options: {
  canvas: HTMLCanvasElement;
  getTheme: () => { dark: boolean };
  onReady?: () => void;
}) => { dispose: () => void };

let sceneFactoryPromise: Promise<SceneFactory> | undefined;

/**
 * Dynamic import keeps Three.js out of the initial bundle; the module chunk is
 * only fetched when a hero canvas actually mounts. The promise is cached so
 * navigating splash → login never refetches the chunk.
 */
function loadSceneFactory(): Promise<SceneFactory> {
  sceneFactoryPromise ??= import("./GoldScene").then(module => module.createGoldScene);
  return sceneFactoryPromise;
}

type GoldCanvasProps = {
  className?: string;
  /** Stable string that lets tests assert the fallback without WebGL. */
  "data-testid"?: string;
};

/**
 * Lazy-loaded WebGL canvas. The Three.js chunk is only fetched when this
 * component mounts (login/splash marketing surface), never on the dashboard.
 * React never re-renders into the scene: the factory mounts once and its
 * dispose runs exactly once on unmount.
 */
export function GoldCanvas({ className, "data-testid": testId }: GoldCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!supportsWebGL()) {
      setFailed(true);
      return;
    }
    const canvas = canvasRef.current;
    if (!canvas) return;

    let disposeScene: (() => void) | undefined;
    let cancelled = false;

    loadSceneFactory()
      .then(createGoldScene => {
        if (cancelled) return;
        const handle = createGoldScene({
          canvas,
          getTheme: () => ({ dark: document.documentElement.classList.contains("dark") }),
          onReady: () => {
            if (!cancelled) setReady(true);
          },
        });
        disposeScene = handle.dispose;
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });

    return () => {
      cancelled = true;
      disposeScene?.();
    };
  }, []);

  return (
    <div
      className={`gold-canvas ${ready ? "is-ready" : ""} ${className ?? ""}`}
      data-testid={testId}
      aria-hidden="true"
    >
      <canvas ref={canvasRef} />
      {failed && <div className="gold-canvas-fallback" />}
    </div>
  );
}

// Re-export for tests that need to assert reduced-motion behaviour.
export const __motionTestSeams = { prefersReducedMotion };
