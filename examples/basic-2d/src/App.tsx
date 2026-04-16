import { useRef, useEffect, useState, useCallback } from "react";
import { Game, Actor, Camera, SceneManager, Scene, AssetLoader, LoadingScreen, ParticleEmitter } from "@carverjs/core/components";
import {
  useCamera,
  useGameLoop,
  useInput,
  useCollision,
  useAudio,
  useSceneData,
  useTween,
  useParticles,
} from "@carverjs/core/hooks";
import { getAudioManager, getSceneManager } from "@carverjs/core/systems";
import { useGameStore } from "@carverjs/core/store";
import { useSceneStore } from "@carverjs/core/store";
import type { Group, LoadingProgress } from "@carverjs/core/types";

// ── Asset Manifest ──
const GAME_ASSETS = [
  { url: "/audio/coin.wav", type: "audio" as const, priority: "high" as const },
  { url: "/audio/complete.wav", type: "audio" as const, priority: "high" as const },
  { url: "/audio/gameover.wav", type: "audio" as const, priority: "high" as const },
  { url: "/audio/music.wav", type: "audio" as const, priority: "low" as const },
];

const LOADING_TIPS = [
  "Use WASD to move",
  "Collect coins before time runs out!",
  "Try Hard mode for a real challenge",
];

// ── Difficulty Levels ──
const LEVELS = [
  { name: "Easy", coinTime: 5, color: "#16a34a", bg: "#1e3a5f" },
  { name: "Medium", coinTime: 3, color: "#eab308", bg: "#3b1f2b" },
  { name: "Hard", coinTime: 1.5, color: "#ef4444", bg: "#1a0a0a" },
];

// ── Physics Config ──
const ACCEL = 40;
const MAX_SPEED = 10;
const FRICTION = 6;
const SPAWN_RANGE = 8;
const COINS_PER_LEVEL = 5;

// ── Block layouts per level ──
interface BlockData {
  x: number;
  y: number;
  w: number;
  h: number;
}

const LEVEL_BLOCKS: BlockData[][] = [
  [
    { x: -3, y: 3, w: 4, h: 0.5 },
    { x: 4, y: -2, w: 0.5, h: 3 },
    { x: -5, y: -4, w: 2, h: 0.5 },
  ],
  [
    { x: -3, y: 3, w: 4, h: 0.5 },
    { x: 4, y: -2, w: 0.5, h: 4 },
    { x: -5, y: -4, w: 2, h: 0.5 },
    { x: 0, y: -1, w: 0.5, h: 3 },
    { x: -6, y: 1, w: 0.5, h: 5 },
    { x: 3, y: 5, w: 3, h: 0.5 },
  ],
  [
    { x: -3, y: 3, w: 5, h: 0.5 },
    { x: 4, y: -2, w: 0.5, h: 5 },
    { x: -5, y: -4, w: 3, h: 0.5 },
    { x: 0, y: -1, w: 0.5, h: 4 },
    { x: -6, y: 1, w: 0.5, h: 5 },
    { x: 3, y: 5, w: 4, h: 0.5 },
    { x: -2, y: -6, w: 6, h: 0.5 },
    { x: 6, y: 2, w: 0.5, h: 6 },
    { x: -4, y: -1, w: 2, h: 0.5 },
  ],
];

interface CoinData {
  id: number;
  x: number;
  y: number;
}

// ── Circle vs AABB resolution ──
const PLAYER_RADIUS = 0.5;

function resolveCircleAABB(
  cx: number,
  cy: number,
  blocks: BlockData[],
): { x: number; y: number } {
  let px = cx;
  let py = cy;
  for (const b of blocks) {
    const halfW = b.w / 2;
    const halfH = b.h / 2;
    const nearX = Math.max(b.x - halfW, Math.min(px, b.x + halfW));
    const nearY = Math.max(b.y - halfH, Math.min(py, b.y + halfH));
    const dx = px - nearX;
    const dy = py - nearY;
    const distSq = dx * dx + dy * dy;
    if (distSq < PLAYER_RADIUS * PLAYER_RADIUS) {
      const dist = Math.sqrt(distSq);
      if (dist === 0) {
        const overlapX = halfW + PLAYER_RADIUS - Math.abs(px - b.x);
        const overlapY = halfH + PLAYER_RADIUS - Math.abs(py - b.y);
        if (overlapX < overlapY) {
          px += px < b.x ? -overlapX : overlapX;
        } else {
          py += py < b.y ? -overlapY : overlapY;
        }
      } else {
        const penetration = PLAYER_RADIUS - dist;
        px += (dx / dist) * penetration;
        py += (dy / dist) * penetration;
      }
    }
  }
  return { x: px, y: py };
}

// ── Coin Collect Sparks (particle burst at coin position) ──
function CoinSparks({ x, y }: { x: number; y: number }) {
  const sparks = useParticles({
    emission: "burst",
    bursts: [{ time: 0, count: [15, 25] }],
    duration: 0,
    loop: false,
    maxParticles: 30,
    shape: { shape: "point" },
    particle: {
      speed: [4, 10],
      lifetime: [0.3, 0.7],
      size: [0.03, 0.08],
      color: ["#facc15", "#f59e0b"],
      alpha: 1,
      gravity: 3,
      drag: 0.02,
    },
    overLifetime: {
      alpha: [
        { t: 0, value: 1 },
        { t: 0.7, value: 1 },
        { t: 1, value: 0 },
      ],
    },
    blendMode: "additive",
  });

  return <group ref={sparks.ref} position={[x, y, 0.1]} />;
}

// ── Player ──
function Player({ blocks, bumpTrigger }: { blocks: BlockData[]; bumpTrigger: number }) {
  const ref = useRef<Group>(null);
  const vel = useRef({ x: 0, y: 0 });
  const { getAxis } = useInput();
  const { tween } = useTween();

  useCamera({
    follow: { target: ref, offset: [0, 0, 100], smoothing: 0.08 },
  });

  useCollision({
    ref,
    name: "player",
    collider: { shape: "circle", radius: PLAYER_RADIUS },
  });

  // Scale punch on coin collect
  useEffect(() => {
    if (bumpTrigger === 0 || !ref.current) return;
    tween({
      target: ref.current.scale,
      from: { x: 1.3, y: 1.3 },
      to: { x: 1, y: 1 },
      duration: 0.25,
      ease: "elastic.out",
    });
  }, [bumpTrigger, tween]);

  useGameLoop((delta) => {
    if (!ref.current) return;
    const v = vel.current;
    const inputX = getAxis("KeyA", "KeyD");
    const inputY = getAxis("KeyS", "KeyW");

    v.x += inputX * ACCEL * delta;
    v.y += inputY * ACCEL * delta;

    if (inputX === 0) v.x *= 1 / (1 + FRICTION * delta);
    if (inputY === 0) v.y *= 1 / (1 + FRICTION * delta);

    const speed = Math.sqrt(v.x * v.x + v.y * v.y);
    if (speed > MAX_SPEED) {
      v.x = (v.x / speed) * MAX_SPEED;
      v.y = (v.y / speed) * MAX_SPEED;
    }

    if (Math.abs(v.x) < 0.01) v.x = 0;
    if (Math.abs(v.y) < 0.01) v.y = 0;

    let newX = ref.current.position.x + v.x * delta;
    let newY = ref.current.position.y + v.y * delta;

    const resolved = resolveCircleAABB(newX, newY, blocks);
    if (resolved.x !== newX) v.x = 0;
    if (resolved.y !== newY) v.y = 0;

    ref.current.position.x = resolved.x;
    ref.current.position.y = resolved.y;
  });

  return (
    <Actor
      ref={ref}
      type="primitive"
      shape="box"
      materialType="basic"
      color="#facc15"
      position={[0, 0, 0]}
    />
  );
}

// ── Block ──
function Block({ x, y, w, h }: BlockData) {
  const ref = useRef<Group>(null);

  useCollision({
    ref,
    name: "block",
    collider: { shape: "aabb", halfExtents: [w / 2, h / 2, 0.5] },
  });

  return (
    <Actor
      ref={ref}
      type="primitive"
      shape="box"
      materialType="basic"
      color="#64748b"
      geometryArgs={[w, h, 1]}
      position={[x, y, 0]}
    />
  );
}

// ── Coin (with tween pop-in + idle pulse) ──
function Coin({
  x,
  y,
  onCollect,
}: {
  x: number;
  y: number;
  onCollect: () => void;
}) {
  const ref = useRef<Group>(null);
  const { tween } = useTween();

  // Pop-in animation when coin spawns + idle pulse
  useEffect(() => {
    if (!ref.current) return;

    // Start at scale 0, pop to full size with overshoot
    ref.current.scale.set(0, 0, 1);
    const popIn = tween({
      target: ref.current.scale,
      to: { x: 1, y: 1 },
      duration: 0.4,
      ease: "back.out",
      onComplete: () => {
        if (!ref.current) return;
        // After pop-in, start a gentle idle pulse
        tween({
          target: ref.current.scale,
          to: { x: 1.15, y: 1.15 },
          duration: 0.6,
          ease: "sine.inOut",
          yoyo: true,
          repeat: -1,
        });
      },
    });

    return () => { popIn.kill(); };
  }, [tween]);

  useCollision({
    ref,
    name: "coin",
    collider: { shape: "circle", radius: 0.4 },
    sensor: true,
    onCollisionEnter: (e) => {
      if (e.otherName === "player") onCollect();
    },
  });

  return (
    <Actor
      ref={ref}
      type="primitive"
      shape="circle"
      materialType="basic"
      color="#f59e0b"
      geometryArgs={[0.4, 16]}
      position={[x, y, 0]}
    />
  );
}

// ── Menu Scene (3D content — just a background) ──
function MenuScene() {
  return (
    <>
      <Camera type="orthographic" orthographicProps={{ zoom: 50 }} />
      <Actor
        type="primitive"
        shape="plane"
        materialType="basic"
        color="#0f172a"
        geometryArgs={[50, 50]}
        position={[0, 0, -1]}
      />
    </>
  );
}

// ── Gameplay Scene (3D content — the actual game) ──
function GameplayScene({ data }: { data?: { level: number } }) {
  const level = data?.level ?? 0;
  const cfg = LEVELS[level];
  const blocks = LEVEL_BLOCKS[level];

  const [coin, setCoin] = useState<CoinData | null>(null);
  const [bumpTrigger, setBumpTrigger] = useState(0);
  const [sparkPositions, setSparkPositions] = useState<{ id: number; x: number; y: number }[]>([]);
  const nextId = useRef(0);
  const sparkId = useRef(0);
  const timer = useRef(cfg.coinTime);
  const localScore = useRef(0);

  const setPhase = useGameStore((s) => s.setPhase);
  const phase = useGameStore((s) => s.phase);
  const { setShared } = useSceneData();

  // Audio
  const { play, playMusic, stopMusic, isUnlocked } = useAudio({
    sounds: {
      coin: { src: "/audio/coin.wav", channel: "sfx" },
      complete: { src: "/audio/complete.wav", channel: "sfx" },
      gameover: { src: "/audio/gameover.wav", channel: "sfx" },
    },
  });

  useEffect(() => {
    if (isUnlocked) {
      playMusic("/audio/music.wav", { loop: true, crossfade: { duration: 1 } });
    }
    return () => stopMusic(0.5);
  }, [isUnlocked, playMusic, stopMusic]);

  // Initialize level — re-runs when level changes (e.g. "Next Level" via replace)
  useEffect(() => {
    localScore.current = 0;
    timer.current = cfg.coinTime;
    setPhase("playing");
    setShared("score", 0);
    setShared("timeLeft", cfg.coinTime);
    setShared("gameOver", false);
    setShared("levelComplete", false);
    setShared("level", level);
    setCoin({
      id: nextId.current++,
      x: (Math.random() - 0.5) * SPAWN_RANGE * 2,
      y: (Math.random() - 0.5) * SPAWN_RANGE * 2,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [level]);

  const collectCoin = useCallback(() => {
    // Spawn sparks at the collected coin's position
    if (coin) {
      setSparkPositions((prev) => [
        ...prev,
        { id: sparkId.current++, x: coin.x, y: coin.y },
      ]);
      // Auto-remove sparks after they finish (1 second is plenty)
      const removeId = sparkId.current - 1;
      setTimeout(() => {
        setSparkPositions((prev) => prev.filter((s) => s.id !== removeId));
      }, 1000);
    }

    localScore.current += 1;
    setShared("score", localScore.current);

    setBumpTrigger((prev) => prev + 1);

    if (localScore.current >= COINS_PER_LEVEL) {
      play("complete");
      setShared("levelComplete", true);
      setShared("gameOver", true);
      setPhase("gameover");
    } else {
      play("coin");
    }

    timer.current = cfg.coinTime;
    setShared("timeLeft", cfg.coinTime);
    setCoin({
      id: nextId.current++,
      x: (Math.random() - 0.5) * SPAWN_RANGE * 2,
      y: (Math.random() - 0.5) * SPAWN_RANGE * 2,
    });
  }, [cfg.coinTime, coin, play, setPhase, setShared]);

  // Countdown timer
  useGameLoop((delta) => {
    if (phase === "gameover") return;
    timer.current -= delta;
    setShared("timeLeft", Math.max(timer.current, 0));
    if (timer.current <= 0) {
      setPhase("gameover");
      play("gameover");
      setShared("gameOver", true);
      setShared("levelComplete", false);
    }
  });

  return (
    <>
      <Camera type="orthographic" orthographicProps={{ zoom: 50 }} />

      <Actor
        type="primitive"
        shape="plane"
        materialType="basic"
        color={cfg.bg}
        geometryArgs={[50, 50]}
        position={[0, 0, -1]}
      />

      <Player blocks={blocks} bumpTrigger={bumpTrigger} />

      {blocks.map((b, i) => (
        <Block key={`block-${i}`} x={b.x} y={b.y} w={b.w} h={b.h} />
      ))}

      {coin && (
        <Coin key={coin.id} x={coin.x} y={coin.y} onCollect={collectCoin} />
      )}

      {/* Spark bursts at collected coin positions */}
      {sparkPositions.map((s) => (
        <CoinSparks key={s.id} x={s.x} y={s.y} />
      ))}

      {/* Confetti burst on level complete */}
      {phase === "gameover" && (localScore.current >= COINS_PER_LEVEL) && (
        <ParticleEmitter
          preset="confetti"
          position={[0, 0, 0.2]}
          maxParticles={200}
          bursts={[{ time: 0, count: [80, 120] }]}
        />
      )}
    </>
  );
}

// ── HUD (HTML overlay — reads scene shared data) ──
function HUD() {
  const currentScene = useSceneStore((s) => s.stack[s.stack.length - 1]);
  const shared = useSceneStore((s) => s.shared);

  // Only show HUD during gameplay
  if (currentScene !== "gameplay") return null;

  const level = (shared.level as number) ?? 0;
  const score = (shared.score as number) ?? 0;
  const timeLeft = (shared.timeLeft as number) ?? 0;
  const gameOver = (shared.gameOver as boolean) ?? false;
  const levelComplete = (shared.levelComplete as boolean) ?? false;
  const cfg = LEVELS[level];

  const handleNext = () => {
    const next = Math.min(level + 1, LEVELS.length - 1);
    getSceneManager().replace(
      "gameplay",
      { level: next },
      { type: "fade", duration: 0.6 },
    );
  };

  const handleRestart = () => {
    getSceneManager().go(
      "menu",
      undefined,
      { type: "fade", duration: 0.6 },
    );
  };

  return (
    <div
      style={{
        position: "absolute",
        top: 0,
        left: 0,
        width: "100%",
        height: "100%",
        pointerEvents: "none",
        fontFamily: "monospace",
        color: "#fff",
        zIndex: 10,
      }}
    >
      {/* Top bar */}
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          padding: "16px 24px",
          fontSize: "18px",
        }}
      >
        <span style={{ color: cfg.color, fontWeight: "bold" }}>
          {cfg.name}
        </span>
        <span>Score: {score}</span>
        <span>
          Time:{" "}
          <span style={{ color: timeLeft < 1 ? "#ef4444" : "#fff" }}>
            {timeLeft.toFixed(1)}s
          </span>
        </span>
        <MuteButton />
      </div>

      {/* Timer bar */}
      <div
        style={{
          margin: "0 24px",
          height: 4,
          background: "#333",
          borderRadius: 2,
        }}
      >
        <div
          style={{
            width: `${(timeLeft / cfg.coinTime) * 100}%`,
            height: "100%",
            background: cfg.color,
            borderRadius: 2,
            transition: "width 0.1s linear",
          }}
        />
      </div>

      {/* Game Over overlay */}
      {gameOver && (
        <div
          style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            background: "rgba(0,0,0,0.75)",
            pointerEvents: "auto",
          }}
        >
          <div style={{ fontSize: "48px", fontWeight: "bold" }}>
            {levelComplete ? "Level Complete!" : "Time's Up!"}
          </div>
          <div style={{ fontSize: "24px", margin: "12px 0 4px" }}>
            Score: {score}
          </div>
          <div
            style={{ fontSize: "16px", color: "#999", marginBottom: "24px" }}
          >
            {cfg.name} — {cfg.coinTime}s per coin
          </div>
          <div style={{ display: "flex", gap: 12 }}>
            {levelComplete && level < LEVELS.length - 1 && (
              <button onClick={handleNext} style={btnStyle("#22c55e")}>
                Next Level
              </button>
            )}
            <button onClick={handleRestart} style={btnStyle("#facc15")}>
              {levelComplete ? "Replay" : "Try Again"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function MuteButton() {
  const [muted, setMuted] = useState(false);

  const toggleMute = useCallback(() => {
    const next = !muted;
    setMuted(next);
    getAudioManager().setMasterMute(next);
  }, [muted]);

  return (
    <button
      onClick={toggleMute}
      style={{
        pointerEvents: "auto",
        background: "none",
        border: "1px solid #555",
        borderRadius: 4,
        color: "#fff",
        cursor: "pointer",
        padding: "4px 10px",
        fontFamily: "monospace",
        fontSize: "14px",
      }}
    >
      {muted ? "Unmute" : "Mute"}
    </button>
  );
}

// ── Level Select Screen (HTML overlay) ──
function LevelSelect() {
  const currentScene = useSceneStore((s) => s.stack[s.stack.length - 1]);

  if (currentScene !== "menu") return null;

  const handleSelect = (level: number) => {
    getSceneManager().go(
      "gameplay",
      { level },
      { type: "fade", duration: 0.8 },
    );
  };

  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        background: "transparent",
        fontFamily: "monospace",
        color: "#fff",
        zIndex: 20,
      }}
    >
      <div style={{ fontSize: "40px", fontWeight: "bold", marginBottom: 8 }}>
        Coin Rush
      </div>
      <div style={{ fontSize: "16px", color: "#999", marginBottom: 40 }}>
        Collect {COINS_PER_LEVEL} coins before time runs out!
      </div>
      <div style={{ display: "flex", gap: 16 }}>
        {LEVELS.map((cfg, i) => (
          <button
            key={i}
            onClick={() => handleSelect(i)}
            style={{
              ...btnStyle(cfg.color),
              width: 140,
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              gap: 4,
              padding: "20px 16px",
            }}
          >
            <span style={{ fontSize: "18px" }}>{cfg.name}</span>
            <span style={{ fontSize: "12px", opacity: 0.7 }}>
              {cfg.coinTime}s per coin
            </span>
          </button>
        ))}
      </div>
      <div style={{ fontSize: "13px", color: "#555", marginTop: 32 }}>
        WASD to move
      </div>
    </div>
  );
}

const btnStyle = (bg: string): React.CSSProperties => ({
  padding: "12px 32px",
  fontSize: "16px",
  cursor: "pointer",
  background: bg,
  color: "#000",
  border: "none",
  borderRadius: 8,
  fontFamily: "monospace",
  fontWeight: "bold",
});

// ── App — uses SceneManager for scene navigation ──
function App() {
  return (
    <div style={{ width: "100vw", height: "100vh", position: "relative" }}>
      <LevelSelect />
      <HUD />
      <Game mode="2d" style={{ background: "#0f172a" }}>
        <AssetLoader
          manifest={GAME_ASSETS}
          minLoadTime={1000}
          fallback={(progress: LoadingProgress) => (
            <LoadingScreen
              progress={progress}
              theme="gaming"
              background="#0f172a"
              accentColor="#facc15"
              logo={<div style={{ fontSize: 36, fontWeight: "bold", fontFamily: "monospace", color: "#facc15" }}>Coin Rush</div>}
              tips={LOADING_TIPS}
            />
          )}
        >
          <SceneManager initial="menu">
            <Scene name="menu" component={MenuScene} />
            <Scene
              name="gameplay"
              component={GameplayScene}
              transition={{ type: "fade", duration: 0.6 }}
            />
          </SceneManager>
        </AssetLoader>
      </Game>
    </div>
  );
}

export default App;
