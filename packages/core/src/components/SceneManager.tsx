import React, {
  useEffect,
  useRef,
  useMemo,
  lazy,
  Suspense,
  Component,
} from "react";
import { useFrame } from "@react-three/fiber";
import { useSceneStore } from "../store/sceneStore";
import { destroySceneManager } from "../systems/SceneManagerImpl";
import type { SceneEntry } from "../types";
import { Color } from "three";
import type { ShaderMaterial } from "three";

// ─── Fade Shader ─────────────────────────────────────────────────────────────

const FADE_VERTEX = /* glsl */ `
void main() {
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

const FADE_FRAGMENT = /* glsl */ `
uniform float uProgress;
uniform vec3 uColor;

void main() {
  // 0→0.5: fade to color (opacity 0→1)
  // 0.5→1: fade from color (opacity 1→0)
  float opacity = uProgress < 0.5
    ? uProgress * 2.0
    : (1.0 - uProgress) * 2.0;
  gl_FragColor = vec4(uColor, opacity);
}
`;

// ─── SceneTransitionFlush ────────────────────────────────────────────────────

/** Advances transition progress each frame at priority -15 */
function SceneTransitionFlush() {
  useFrame((_, rawDelta) => {
    const delta = Math.min(rawDelta, 0.1); // Cap delta like GameLoopTick
    useSceneStore.getState()._tickTransition(delta);
  }, -15);
  return null;
}

// ─── TransitionOverlay ───────────────────────────────────────────────────────

/** Fullscreen quad rendered on top of everything during transitions */
function TransitionOverlay() {
  const active = useSceneStore((s) => s.transition.active);
  const config = useSceneStore((s) => s.transition.config);
  const materialRef = useRef<ShaderMaterial>(null);

  // Parse fade color once when config changes
  const colorVec = useMemo(() => {
    return new Color(config.color ?? "#000000");
  }, [config.color]);

  // Update progress uniform every frame (no React re-render)
  useFrame(() => {
    if (!materialRef.current) return;
    const { progress } = useSceneStore.getState().transition;
    materialRef.current.uniforms.uProgress.value = progress;
  }, -14); // Just after transition tick at -15

  if (!active || config.type === "none") return null;

  const isCustom = config.type === "custom" && config.fragmentShader;

  return (
    <mesh renderOrder={9999} frustumCulled={false}>
      <planeGeometry args={[2, 2]} />
      <shaderMaterial
        ref={materialRef}
        transparent
        depthTest={false}
        depthWrite={false}
        uniforms={{
          uProgress: { value: 0 },
          uColor: { value: colorVec },
          ...(isCustom ? config.uniforms : {}),
        }}
        vertexShader={isCustom && config.vertexShader ? config.vertexShader : FADE_VERTEX}
        fragmentShader={isCustom ? config.fragmentShader! : FADE_FRAGMENT}
      />
    </mesh>
  );
}

// ─── SceneErrorBoundary ──────────────────────────────────────────────────────

interface ErrorBoundaryProps {
  name: string;
  children: React.ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
}

class SceneErrorBoundary extends Component<
  ErrorBoundaryProps,
  ErrorBoundaryState
> {
  state: ErrorBoundaryState = { hasError: false };

  static getDerivedStateFromError(): ErrorBoundaryState {
    return { hasError: true };
  }

  componentDidCatch(error: Error): void {
    console.error(
      `[CarverJS Scene] Error in scene "${this.props.name}":`,
      error,
    );
    // Mark scene as destroyed so SceneManager stops rendering it
    useSceneStore.getState()._setStatus(this.props.name, "destroyed");
  }

  render() {
    if (this.state.hasError) return null;
    return this.props.children;
  }
}

// ─── SceneContent ────────────────────────────────────────────────────────────

/** Cache for React.lazy components to avoid recreating on every render */
const _lazyCache = new Map<string, React.LazyExoticComponent<React.ComponentType<{ data?: unknown }>>>();

/** Resolves and renders the scene's component with data */
function SceneContent({ entry }: { entry: SceneEntry }) {
  const { config, data } = entry;

  // Resolve component: direct component > lazy loader
  const SceneComponent = useMemo(() => {
    if (config.component) return config.component;

    if (config.loader) {
      // Cache lazy components by scene name to avoid re-creating on re-render
      let cached = _lazyCache.get(config.name);
      if (!cached) {
        cached = lazy(config.loader as () => Promise<{ default: React.ComponentType<{ data?: unknown }> }>);
        _lazyCache.set(config.name, cached);
      }
      return cached;
    }

    return null;
  }, [config]);

  if (!SceneComponent) return null;

  return <SceneComponent data={data} />;
}

// ─── SceneRenderer ───────────────────────────────────────────────────────────

/** Renders a single scene with visibility control, error boundary, and suspense */
function SceneRenderer({
  entry,
  loadingFallback,
}: {
  entry: SceneEntry;
  loadingFallback?: React.ReactNode;
}) {
  const { config, status } = entry;
  const name = config.name;

  // Determine visibility from status
  const visible =
    status === "running" ||
    status === "shutting_down" ||
    status === "paused";

  // Should this scene be mounted at all?
  const mounted =
    status === "running" ||
    status === "shutting_down" ||
    status === "paused" ||
    status === "sleeping" ||
    status === "preloading";

  if (!mounted) return null;

  return (
    <group visible={visible} key={name}>
      <SceneErrorBoundary name={name}>
        <Suspense fallback={loadingFallback ?? null}>
          <SceneContent entry={entry} />
        </Suspense>
      </SceneErrorBoundary>
    </group>
  );
}

// ─── SceneManager Component ─────────────────────────────────────────────────

export interface SceneManagerProps {
  /** Name of the initial scene to start */
  initial: string;
  /** Fallback rendered while a lazy scene loads (inside R3F, must be a Three.js element) */
  loadingFallback?: React.ReactNode;
  /** Persistent elements rendered above all scenes (e.g., AudioManager wrapper) */
  persistent?: React.ReactNode;
  /** <Scene> components for registration */
  children: React.ReactNode;
}

export function SceneManager({
  initial,
  loadingFallback,
  persistent,
  children,
}: SceneManagerProps) {
  const initializedRef = useRef(false);
  const scenes = useSceneStore((s) => s.scenes);

  // Register <Scene> children first (they run useEffect on mount),
  // then start the initial scene after a microtask so registration is complete.
  useEffect(() => {
    if (initializedRef.current) return;
    initializedRef.current = true;

    // Use requestAnimationFrame to ensure all <Scene> useEffect registrations
    // have fired before we try to start the initial scene
    const id = requestAnimationFrame(() => {
      useSceneStore.getState()._startInitial(initial);
    });

    return () => cancelAnimationFrame(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    return () => destroySceneManager();
  }, []);

  // Collect all scene entries that should be rendered
  const sceneEntries = useMemo(() => {
    const entries: SceneEntry[] = [];
    for (const [, entry] of scenes) {
      if (entry.status !== "created" && entry.status !== "destroyed") {
        entries.push(entry);
      }
    }
    return entries;
  }, [scenes]);

  return (
    <>
      {/* Scene registration (children are <Scene> components that return null) */}
      {children}

      {/* Scene transition tick */}
      <SceneTransitionFlush />

      {/* Render active/sleeping/transitioning scenes */}
      {sceneEntries.map((entry) => (
        <SceneRenderer
          key={entry.config.name}
          entry={entry}
          loadingFallback={loadingFallback}
        />
      ))}

      {/* Transition overlay (renders on top of everything) */}
      <TransitionOverlay />

      {/* Persistent elements */}
      {persistent}
    </>
  );
}
