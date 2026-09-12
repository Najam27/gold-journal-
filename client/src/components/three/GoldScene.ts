import {
  AdditiveBlending,
  AmbientLight,
  BufferAttribute,
  BufferGeometry,
  Color,
  DirectionalLight,
  Group,
  IcosahedronGeometry,
  Mesh,
  MeshStandardMaterial,
  PerspectiveCamera,
  Points,
  PointsMaterial,
  Scene,
  TorusGeometry,
  WebGLRenderer,
} from "three";

import { isLowPowerDevice, prefersReducedMotion } from "@/lib/motion/tokens";

export type GoldSceneHandle = {
  dispose: () => void;
};

export type GoldSceneOptions = {
  /** Canvas the renderer should draw to. */
  canvas: HTMLCanvasElement;
  /** Sampled page background so lighting and colors sit on the active theme. */
  getTheme: () => { dark: boolean };
  /** Called when the scene is ready to show; enables a CSS fade-in. */
  onReady?: () => void;
  /** Testing seam: override environment probing. */
  lowPower?: boolean;
  reducedMotion?: boolean;
};

const PARTICLE_COUNT_DESKTOP = 90;
const PARTICLE_COUNT_LOW_POWER = 36;

/**
 * Premium-but-restrained 3D centerpiece: a brushed metallic "ingot" (a rounded
 * octahedron) inside a thin gold ring, floating in a slow particle field.
 *
 * Resource rules:
 * - one renderer, one RAF loop, all listeners removed on dispose
 * - every geometry/material is disposed with the scene
 * - rendering pauses when the tab is hidden or the canvas leaves the viewport
 * - respects prefers-reduced-motion (static frame, no drift) and low-power
 *   devices (fewer particles, capped pixel ratio)
 */
export function createGoldScene(options: GoldSceneOptions): GoldSceneHandle {
  const { canvas, getTheme, onReady } = options;
  const lowPower = options.lowPower ?? isLowPowerDevice();
  const reducedMotion = options.reducedMotion ?? prefersReducedMotion();

  const renderer = new WebGLRenderer({
    canvas,
    alpha: true,
    antialias: !lowPower,
    powerPreference: "low-power",
  });
  const pixelRatioCap = lowPower ? 1.25 : 1.75;
  const applySize = () => {
    const { clientWidth, clientHeight } = canvas;
    if (!clientWidth || !clientHeight) return;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, pixelRatioCap));
    renderer.setSize(clientWidth, clientHeight, false);
  };
  applySize();

  const scene = new Scene();
  const camera = new PerspectiveCamera(42, 1, 0.1, 60);
  camera.position.set(0, 0.6, 6.4);

  const group = new Group();
  scene.add(group);

  const geometry = new IcosahedronGeometry(1.55, 1);
  const ringGeometry = new TorusGeometry(2.35, 0.045, 12, 96);
  const disposables: Array<{ dispose: () => void }> = [geometry, ringGeometry];

  const ingotMaterial = new MeshStandardMaterial({
    color: new Color("#d9a83f"),
    metalness: 0.96,
    roughness: 0.24,
    envMapIntensity: 1.1,
  });
  const ringMaterial = new MeshStandardMaterial({
    color: new Color("#e9b64b"),
    metalness: 1,
    roughness: 0.32,
  });
  disposables.push(ingotMaterial, ringMaterial);
  const ingot = new Mesh(geometry, ingotMaterial);
  const ring = new Mesh(ringGeometry, ringMaterial);
  ring.rotation.x = Math.PI / 2.35;
  group.add(ingot, ring);

  // Key + cool fill give the metal something to read as gold without shipping
  // an environment texture.
  const keyLight = new DirectionalLight(0xfff3d6, 2.4);
  keyLight.position.set(3.4, 4.2, 5.2);
  const coolLight = new DirectionalLight(0x8fc3ee, 1.1);
  coolLight.position.set(-4.5, -2.4, 3.1);
  const ambient = new AmbientLight(0xffffff, 0.55);
  group.add(keyLight, coolLight);

  const particleCount = lowPower ? PARTICLE_COUNT_LOW_POWER : PARTICLE_COUNT_DESKTOP;
  const particlePositions = new Float32Array(particleCount * 3);
  const particleSpeeds = new Float32Array(particleCount);
  for (let i = 0; i < particleCount; i += 1) {
    particlePositions[i * 3] = (Math.random() - 0.5) * 11;
    particlePositions[i * 3 + 1] = (Math.random() - 0.5) * 7;
    particlePositions[i * 3 + 2] = (Math.random() - 0.5) * 5 - 1.5;
    particleSpeeds[i] = 0.12 + Math.random() * 0.4;
  }
  const particleGeometry = new BufferGeometry();
  particleGeometry.setAttribute("position", new BufferAttribute(particlePositions, 3));
  const particleMaterial = new PointsMaterial({
    size: 0.055,
    transparent: true,
    opacity: 0.85,
    depthWrite: false,
    blending: AdditiveBlending,
    sizeAttenuation: true,
  });
  disposables.push(particleGeometry, particleMaterial);
  const particles = new Points(particleGeometry, particleMaterial);
  scene.add(particles);

  const applyThemeColors = () => {
    const { dark } = getTheme();
    const gold = new Color(dark ? "#e9b64b" : "#a56c13");
    const rim = new Color(dark ? "#7db7ef" : "#236ca7");
    ingotMaterial.color.copy(gold).lerp(new Color("#f5e2a8"), dark ? 0.18 : 0.3);
    ingotMaterial.emissive.copy(gold).multiplyScalar(dark ? 0.3 : 0.12);
    ringMaterial.color.copy(gold);
    ringMaterial.emissive.copy(gold).multiplyScalar(dark ? 0.5 : 0.18);
    particleMaterial.color.copy(dark ? gold : rim);
    coolLight.color.copy(rim);
  };
  applyThemeColors();

  const pointer = { x: 0, y: 0, targetX: 0, targetY: 0 };
  let raf = 0;
  let disposed = false;
  let visible = true;
  const clock = { value: 0 };
  let lastTime = performance.now();

  const render = () => {
    renderer.render(scene, camera);
  };

  const tick = (now: number) => {
    if (disposed) return;
    const delta = Math.min((now - lastTime) / 1000, 0.1);
    lastTime = now;

    pointer.x += (pointer.targetX - pointer.x) * Math.min(delta * 3, 1);
    pointer.y += (pointer.targetY - pointer.y) * Math.min(delta * 3, 1);

    if (!reducedMotion) {
      clock.value += delta;
      group.rotation.y += delta * 0.22;
      group.rotation.x = Math.sin(clock.value * 0.5) * 0.12 + pointer.y * 0.18;
      group.position.y = Math.sin(clock.value * 0.8) * 0.14;
      ring.rotation.z += delta * 0.1;
      particles.rotation.y -= delta * 0.02;
    }
    camera.position.x = pointer.x * 0.55;
    camera.position.y = 0.6 - pointer.y * 0.4;
    camera.lookAt(0, 0, 0);

    if (visible) render();
    raf = window.requestAnimationFrame(tick);
  };

  const onCanvasPointerMove = (event: PointerEvent) => {
    const rect = canvas.getBoundingClientRect();
    pointer.targetX = ((event.clientX - rect.left) / rect.width - 0.5) * 2;
    pointer.targetY = ((event.clientY - rect.top) / rect.height - 0.5) * 2;
  };
  const onWindowPointerMove = (event: PointerEvent) => {
    if (event.target === canvas) return;
    // Gentle parallax toward the cursor even outside the canvas, half strength.
    pointer.targetX = (event.clientX / window.innerWidth - 0.5) * 1.1;
    pointer.targetY = (event.clientY / window.innerHeight - 0.5) * 0.9;
  };
  const onResize = () => {
    const { clientWidth, clientHeight } = canvas;
    if (!clientWidth || !clientHeight) return;
    camera.aspect = clientWidth / clientHeight;
    camera.updateProjectionMatrix();
    applySize();
  };
  const onVisibility = () => {
    visible = document.visibilityState === "visible";
  };

  // Pause when scrolled out of view so the scene never burns battery while the
  // login form is the only thing on screen or the tab is in the background.
  const intersection = new IntersectionObserver(
    entries => {
      visible =
        document.visibilityState === "visible" && entries[0]?.isIntersecting !== false;
    },
    { threshold: 0.02 }
  );
  intersection.observe(canvas);
  document.addEventListener("visibilitychange", onVisibility);
  window.addEventListener("resize", onResize);
  canvas.addEventListener("pointermove", onCanvasPointerMove);
  window.addEventListener("pointermove", onWindowPointerMove, { passive: true });

  // Resize after layout settles so the canvas matches its container exactly.
  const initialResize = window.requestAnimationFrame(onResize);
  raf = window.requestAnimationFrame(tick);
  onReady?.();
  render();

  return {
    dispose() {
      if (disposed) return;
      disposed = true;
      window.cancelAnimationFrame(raf);
      window.cancelAnimationFrame(initialResize);
      window.removeEventListener("resize", onResize);
      canvas.removeEventListener("pointermove", onCanvasPointerMove);
      window.removeEventListener("pointermove", onWindowPointerMove);
      document.removeEventListener("visibilitychange", onVisibility);
      intersection.disconnect();
      group.remove(ingot, ring, keyLight, coolLight, ambient);
      scene.remove(group, particles);
      for (const disposable of disposables) disposable.dispose();
      renderer.dispose();
    },
  };
}
