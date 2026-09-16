import {
  AdditiveBlending,
  AmbientLight,
  BufferAttribute,
  BufferGeometry,
  Color,
  DirectionalLight,
  FogExp2,
  Group,
  IcosahedronGeometry,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  OctahedronGeometry,
  PerspectiveCamera,
  Points,
  PointsMaterial,
  Scene,
  TorusGeometry,
  WebGLRenderer,
} from "three";

import { isLowPowerDevice, prefersReducedMotion } from "@/lib/motion/tokens";

export type Premium3DTone = "gold" | "cyan" | "violet" | "emerald" | "blue" | "neutral";

export type PremiumSceneHandle = {
  dispose: () => void;
  /** Re-colours the scene when the app theme flips. */
  setDark: (dark: boolean) => void;
};

export type PremiumSceneOptions = {
  canvas: HTMLCanvasElement;
  tone: Premium3DTone;
  dark: boolean;
  onReady?: () => void;
  /** Testing seams. */
  lowPower?: boolean;
  reducedMotion?: boolean;
};

/**
 * Tone palette per theme. Kept in one place so the WebGL scene and the CSS
 * fallback (`[class*="-fallback"]`) always describe the same accent.
 */
const TONES: Record<Premium3DTone, { dark: string; light: string; rim: string }> = {
  gold: { dark: "#f0c14e", light: "#a56c13", rim: "#6ea8ff" },
  cyan: { dark: "#46d5f5", light: "#0d7490", rim: "#3fe39b" },
  violet: { dark: "#b39bff", light: "#6438d4", rim: "#46d5f5" },
  emerald: { dark: "#3fe39b", light: "#0b7f4f", rim: "#f0c14e" },
  blue: { dark: "#6ea8ff", light: "#1d63c4", rim: "#46d5f5" },
  neutral: { dark: "#a7b7d0", light: "#4d5f78", rim: "#f0c14e" },
};

const PARTICLES_DESKTOP = 130;
const PARTICLES_LOW_POWER = 46;
const NODES = 9;

/**
 * The Premium 3D background: slow orbital rings, glowing data nodes and a
 * drifting particle field inside a depth fog.
 *
 * Deliberately calm — nothing spins fast and nothing moves faster than a slow
 * orbit. Used only on hero-scale surfaces (splash, login, dashboard hero, AI
 * mentor, analytics hero), never behind dense tables or forms.
 *
 * Resource rules:
 * - one renderer, one RAF loop, one cached chunk, all resources disposed
 * - rendering pauses when the tab is hidden or the canvas leaves the viewport
 * - `prefers-reduced-motion` renders a single static frame
 * - low-power devices get fewer particles and a capped pixel ratio
 */
export function createPremiumScene(options: PremiumSceneOptions): PremiumSceneHandle {
  const { canvas, tone, onReady } = options;
  const lowPower = options.lowPower ?? isLowPowerDevice();
  const reducedMotion = options.reducedMotion ?? prefersReducedMotion();
  let dark = options.dark;

  const renderer = new WebGLRenderer({
    canvas,
    alpha: true,
    antialias: !lowPower,
    powerPreference: "low-power",
  });
  const pixelRatioCap = lowPower ? 1.2 : 1.6;
  const applySize = () => {
    const { clientWidth, clientHeight } = canvas;
    if (!clientWidth || !clientHeight) return;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, pixelRatioCap));
    renderer.setSize(clientWidth, clientHeight, false);
  };
  applySize();

  const scene = new Scene();
  const camera = new PerspectiveCamera(46, 1, 0.1, 70);
  camera.position.set(0, 0.4, 7.2);

  // Depth fog is what makes the field read as depth rather than noise.
  scene.fog = new FogExp2(dark ? 0x070c17 : 0xe9eef7, 0.055);

  const rings = new Group();
  const nodes = new Group();
  scene.add(rings, nodes);

  const disposables: Array<{ dispose: () => void }> = [];

  const ringGeometry = new TorusGeometry(1, 0.012, 8, 128);
  const nodeGeometry = new OctahedronGeometry(0.11, 0);
  const coreGeometry = new IcosahedronGeometry(0.62, 1);
  disposables.push(ringGeometry, nodeGeometry, coreGeometry);

  const ringDefinitions = [
    { radius: 2.5, tilt: 0.42, spin: 0.05, opacity: 0.5 },
    { radius: 3.3, tilt: -0.26, spin: -0.035, opacity: 0.34 },
    { radius: 4.15, tilt: 0.68, spin: 0.022, opacity: 0.22 },
  ];
  const ringMaterials: MeshBasicMaterial[] = [];
  const ringMeshes: Mesh[] = [];
  for (const definition of ringDefinitions) {
    const material = new MeshBasicMaterial({
      transparent: true,
      opacity: definition.opacity,
      depthWrite: false,
      blending: AdditiveBlending,
    });
    const mesh = new Mesh(ringGeometry, material);
    mesh.scale.setScalar(definition.radius);
    mesh.rotation.x = Math.PI / 2 + definition.tilt;
    ringMeshes.push(mesh);
    ringMaterials.push(material);
    rings.add(mesh);
    disposables.push(material);
  }

  const coreMaterial = new MeshStandardMaterial({ metalness: 0.9, roughness: 0.28 });
  const core = new Mesh(coreGeometry, coreMaterial);
  core.scale.setScalar(0.9);
  nodes.add(core);
  disposables.push(coreMaterial);

  const nodeMaterial = new MeshStandardMaterial({ metalness: 0.6, roughness: 0.3 });
  const nodeMeshes: Mesh[] = [];
  const nodeAngles = new Float32Array(NODES);
  const nodeRadii = new Float32Array(NODES);
  const nodeSpeeds = new Float32Array(NODES);
  for (let i = 0; i < NODES; i += 1) {
    const mesh = new Mesh(nodeGeometry, nodeMaterial);
    nodeAngles[i] = (i / NODES) * Math.PI * 2;
    nodeRadii[i] = i % 3 === 0 ? 2.5 : i % 3 === 1 ? 3.3 : 4.15;
    nodeSpeeds[i] = 0.06 + (i % 4) * 0.018;
    nodes.add(mesh);
    nodeMeshes.push(mesh);
  }
  disposables.push(nodeMaterial);

  const particleCount = lowPower ? PARTICLES_LOW_POWER : PARTICLES_DESKTOP;
  const positions = new Float32Array(particleCount * 3);
  const drift = new Float32Array(particleCount);
  for (let i = 0; i < particleCount; i += 1) {
    positions[i * 3] = (Math.random() - 0.5) * 15;
    positions[i * 3 + 1] = (Math.random() - 0.5) * 9;
    positions[i * 3 + 2] = (Math.random() - 0.5) * 7 - 2;
    drift[i] = 0.06 + Math.random() * 0.22;
  }
  const particleGeometry = new BufferGeometry();
  particleGeometry.setAttribute("position", new BufferAttribute(positions, 3));
  const particleMaterial = new PointsMaterial({
    size: 0.05,
    transparent: true,
    opacity: 0.8,
    depthWrite: false,
    blending: AdditiveBlending,
    sizeAttenuation: true,
  });
  disposables.push(particleGeometry, particleMaterial);
  const particles = new Points(particleGeometry, particleMaterial);
  scene.add(particles);

  const keyLight = new DirectionalLight(0xfff3d6, 2.2);
  keyLight.position.set(3.6, 4.4, 5.4);
  const rimLight = new DirectionalLight(0x8fc3ee, 1.3);
  rimLight.position.set(-4.6, -2.6, 3.2);
  scene.add(keyLight, rimLight, new AmbientLight(0xffffff, 0.5));

  const applyTheme = () => {
    const palette = TONES[tone];
    const primary = new Color(dark ? palette.dark : palette.light);
    const rim = new Color(palette.rim);
    for (const material of ringMaterials) material.color.copy(primary);
    coreMaterial.color.copy(primary).lerp(new Color("#ffffff"), dark ? 0.2 : 0.36);
    coreMaterial.emissive.copy(primary).multiplyScalar(dark ? 0.42 : 0.16);
    nodeMaterial.color.copy(primary).lerp(rim, 0.32);
    nodeMaterial.emissive.copy(primary).multiplyScalar(dark ? 0.55 : 0.2);
    particleMaterial.color.copy(rim).lerp(primary, 0.4);
    rimLight.color.copy(rim);
  };
  applyTheme();

  const pointer = { x: 0, y: 0, targetX: 0, targetY: 0 };
  let raf = 0;
  let disposed = false;
  let visible = true;
  let elapsed = 0;
  let last = performance.now();

  const tick = (now: number) => {
    if (disposed) return;
    const delta = Math.min((now - last) / 1000, 0.1);
    last = now;

    pointer.x += (pointer.targetX - pointer.x) * Math.min(delta * 2.2, 1);
    pointer.y += (pointer.targetY - pointer.y) * Math.min(delta * 2.2, 1);

    if (!reducedMotion) {
      elapsed += delta;
      rings.rotation.y += delta * 0.045;
      rings.rotation.z = Math.sin(elapsed * 0.14) * 0.08;
      nodes.rotation.y -= delta * 0.06;
      core.rotation.x += delta * 0.12;
      core.rotation.y += delta * 0.16;
      particles.rotation.y -= delta * 0.012;
      for (let i = 0; i < NODES; i += 1) {
        nodeAngles[i] += delta * nodeSpeeds[i];
        const radius = nodeRadii[i];
        const tilt = ringDefinitions[i % 3].tilt;
        nodeMeshes[i].position.set(
          Math.cos(nodeAngles[i]) * radius,
          Math.sin(nodeAngles[i]) * radius * Math.sin(tilt),
          Math.sin(nodeAngles[i]) * radius * Math.cos(tilt)
        );
      }
      const array = particleGeometry.getAttribute("position") as BufferAttribute;
      for (let i = 0; i < particleCount; i += 1) {
        const y = array.getY(i) + drift[i] * delta * 0.5;
        array.setY(i, y > 4.6 ? -4.6 : y);
      }
      array.needsUpdate = true;
    }

    camera.position.x = pointer.x * 0.6;
    camera.position.y = 0.4 - pointer.y * 0.45;
    camera.lookAt(0, 0, 0);

    if (visible) renderer.render(scene, camera);
    raf = window.requestAnimationFrame(tick);
  };

  const onPointerMove = (event: PointerEvent) => {
    pointer.targetX = (event.clientX / window.innerWidth - 0.5) * 1.2;
    pointer.targetY = (event.clientY / window.innerHeight - 0.5) * 1.0;
  };
  const onResize = () => {
    const { clientWidth, clientHeight } = canvas;
    if (!clientWidth || !clientHeight) return;
    camera.aspect = clientWidth / clientHeight;
    camera.updateProjectionMatrix();
    applySize();
  };
  const onVisibility = () => {
    visible = document.visibilityState === "visible" && intersecting;
  };
  let intersecting = true;
  const intersection = new IntersectionObserver(
    entries => {
      intersecting = entries[0]?.isIntersecting !== false;
      visible = document.visibilityState === "visible" && intersecting;
    },
    { threshold: 0.01 }
  );
  intersection.observe(canvas);

  document.addEventListener("visibilitychange", onVisibility);
  window.addEventListener("resize", onResize);
  if (!lowPower) window.addEventListener("pointermove", onPointerMove, { passive: true });

  const initialResize = window.requestAnimationFrame(onResize);
  renderer.render(scene, camera);
  raf = window.requestAnimationFrame(tick);
  onReady?.();

  return {
    setDark(next: boolean) {
      if (next === dark) return;
      dark = next;
      scene.fog = new FogExp2(dark ? 0x070c17 : 0xe9eef7, 0.055);
      applyTheme();
      if (reducedMotion) renderer.render(scene, camera);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      window.cancelAnimationFrame(raf);
      window.cancelAnimationFrame(initialResize);
      window.removeEventListener("resize", onResize);
      window.removeEventListener("pointermove", onPointerMove);
      document.removeEventListener("visibilitychange", onVisibility);
      intersection.disconnect();
      scene.remove(rings, nodes, particles, keyLight, rimLight);
      for (const disposable of disposables) disposable.dispose();
      renderer.dispose();
    },
  };
}
