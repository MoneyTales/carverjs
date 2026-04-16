import { useRef, useEffect, useState, useCallback } from "react";
import { Game, World, Actor, Camera } from "@carverjs/core/components";
import { useGameLoop, useInput, usePhysics, useCameraDirection } from "@carverjs/core/hooks";
import { useGameStore } from "@carverjs/core/store";
import type { Group } from "@carverjs/core/types";

// ── Levels ──
const LEVELS = [
  { name: "Easy", coinTime: 8, coinsNeeded: 5, color: "#16a34a", bg: "#4a7c59" },
  { name: "Medium", coinTime: 5, coinsNeeded: 7, color: "#eab308", bg: "#7c6a3a" },
  { name: "Hard", coinTime: 3, coinsNeeded: 10, color: "#ef4444", bg: "#7c3a3a" },
];

// ── Physics constants ──
const MOVE_FORCE = 40;
const JUMP_IMPULSE = 7;
const MAX_SPEED = 20;
const SPAWN_RANGE = 12;
const JUMP_COOLDOWN = 0.35; // seconds before another jump is allowed

// ── Block data: { x, y, z, w, h, d } ──
// y is the CENTER of the block. Blocks sit on the ground (y = h/2).
// "tall" blocks are too high to jump over.
interface BlockData {
  x: number; y: number; z: number;
  w: number; h: number; d: number;
  color?: string;
}

const LEVEL_BLOCKS: BlockData[][] = [
  // Easy — a few low platforms + one tall wall
  [
    { x: -4, y: 0.5, z: -4, w: 3, h: 1, d: 3 },
    { x: 5, y: 0.5, z: 3, w: 2, h: 1, d: 2 },
    { x: 0, y: 1, z: -8, w: 4, h: 2, d: 2 },
    // Tall wall — can't jump over
    { x: 8, y: 2.5, z: 0, w: 1, h: 5, d: 8, color: "#991b1b" },
  ],
  // Medium — more platforms + two tall walls
  [
    { x: -5, y: 0.5, z: -5, w: 3, h: 1, d: 3 },
    { x: 4, y: 0.5, z: 4, w: 2, h: 1, d: 2 },
    { x: -2, y: 1, z: 6, w: 4, h: 2, d: 2 },
    { x: 7, y: 0.5, z: -6, w: 3, h: 1, d: 3 },
    { x: -8, y: 1.5, z: 0, w: 2, h: 3, d: 2 },
    // Tall walls
    { x: 0, y: 2.5, z: -10, w: 12, h: 5, d: 1, color: "#991b1b" },
    { x: -10, y: 2.5, z: 0, w: 1, h: 5, d: 12, color: "#991b1b" },
  ],
  // Hard — dense platforms + three tall walls forming a maze
  [
    { x: -4, y: 0.5, z: -3, w: 2, h: 1, d: 2 },
    { x: 3, y: 0.5, z: 5, w: 2, h: 1, d: 2 },
    { x: -7, y: 1, z: 7, w: 3, h: 2, d: 3 },
    { x: 6, y: 0.5, z: -5, w: 2, h: 1, d: 2 },
    { x: 0, y: 1.5, z: 0, w: 3, h: 3, d: 3 },
    { x: -5, y: 0.5, z: 5, w: 2, h: 1, d: 2 },
    { x: 8, y: 1, z: 8, w: 3, h: 2, d: 2 },
    // Tall walls — maze barriers
    { x: 0, y: 2.5, z: -8, w: 16, h: 5, d: 1, color: "#991b1b" },
    { x: -8, y: 2.5, z: 0, w: 1, h: 5, d: 16, color: "#991b1b" },
    { x: 4, y: 2.5, z: 4, w: 1, h: 5, d: 8, color: "#991b1b" },
  ],
];

// ── Coin spawn positions on blocks (some coins on platforms, some on ground) ──
function getBlockTopY(b: BlockData) {
  return b.y + b.h / 2 + 0.5; // coin sits 0.5 above block top
}

interface CoinData {
  id: number;
  x: number; y: number; z: number;
}

function spawnCoin(id: number, blocks: BlockData[]): CoinData {
  // 30% chance to spawn on a low block (not tall walls)
  const lowBlocks = blocks.filter((b) => b.h <= 3);
  if (lowBlocks.length > 0 && Math.random() < 0.3) {
    const b = lowBlocks[Math.floor(Math.random() * lowBlocks.length)];
    return { id, x: b.x, y: getBlockTopY(b), z: b.z };
  }
  // Otherwise spawn on ground
  return {
    id,
    x: (Math.random() - 0.5) * SPAWN_RANGE * 2,
    y: 0.5,
    z: (Math.random() - 0.5) * SPAWN_RANGE * 2,
  };
}

// ── Player controller — must be a CHILD of Actor so usePhysics() has context ──
function PlayerController() {
  const physics = usePhysics();
  const { getAxis, isJustPressed } = useInput();
  const { getForward, getRight } = useCameraDirection();
  const jumpTimer = useRef(0);

  useGameLoop((delta) => {
    if (!physics) return;

    const inputX = getAxis("KeyA", "KeyD");   // -1 left, +1 right
    const inputZ = getAxis("KeyW", "KeyS");   // -1 forward, +1 backward

    // Clear forces from previous frame, then apply camera-relative force
    physics.resetForces();
    if (inputX !== 0 || inputZ !== 0) {
      const fwd = getForward(); // camera forward on XZ
      const rgt = getRight();   // camera right on XZ
      // Combine: forward component (W/S along camera forward) + strafe (A/D along camera right)
      const fx = -(fwd[0] * inputZ + rgt[0] * inputX) * MOVE_FORCE;
      const fz = -(fwd[2] * inputZ + rgt[2] * inputX) * MOVE_FORCE;
      physics.applyForce([fx, 0, fz]);
    }

    // Clamp horizontal speed
    const vel = physics.getLinearVelocity();
    const hSpeed = Math.sqrt(vel[0] * vel[0] + vel[2] * vel[2]);
    if (hSpeed > MAX_SPEED) {
      const s = MAX_SPEED / hSpeed;
      physics.setLinearVelocity([vel[0] * s, vel[1], vel[2] * s]);
    }

    // Ground check: grounded if vertical velocity is near zero
    const pos = physics.getTranslation();
    const onSurface = Math.abs(vel[1]) < 0.5;

    // Tick cooldown
    if (jumpTimer.current > 0) jumpTimer.current -= delta;

    // Jump — only if on a surface AND cooldown expired
    if (isJustPressed("Space") && onSurface && jumpTimer.current <= 0) {
      physics.applyImpulse([0, JUMP_IMPULSE, 0]);
      jumpTimer.current = JUMP_COOLDOWN;
    }

    // Clamp to floor bounds
    const BOUND = 19;
    if (Math.abs(pos[0]) > BOUND || Math.abs(pos[2]) > BOUND) {
      physics.setTranslation([
        Math.max(-BOUND, Math.min(BOUND, pos[0])),
        pos[1],
        Math.max(-BOUND, Math.min(BOUND, pos[2])),
      ]);
      physics.setLinearVelocity([0, vel[1], 0]);
    }

    // Reset if somehow fallen off
    if (pos[1] < -5) {
      physics.setTranslation([0, 2, 0]);
      physics.setLinearVelocity([0, 0, 0]);
    }
  });

  return null;
}

// ── Player ──
function Player({ playerRef }: { playerRef: React.RefObject<Group | null> }) {
  return (
    <Actor
      ref={playerRef}
      name="player"
      type="primitive"
      shape="box"
      color="#facc15"
      geometryArgs={[0.8, 0.8, 0.8]}
      position={[0, 1, 0]}
      castShadow
      physics={{
        bodyType: "dynamic",
        collider: "cuboid",
        mass: 1,
        friction: 0.5,
        restitution: 0,
        linearDamping: 5,
        angularDamping: 5,
        enabledRotations: [false, false, false],
        ccd: true,
      }}
    >
      <PlayerController />
    </Actor>
  );
}

// ── Block ──
function Block({ x, y, z, w, h, d, color }: BlockData) {
  return (
    <Actor
      type="primitive"
      shape="box"
      color={color ?? "#64748b"}
      geometryArgs={[w, h, d]}
      position={[x, y, z]}
      castShadow
      receiveShadow
      physics={{ bodyType: "fixed", collider: "cuboid", friction: 0.5 }}
    />
  );
}

// ── Spinning Coin ──
function Coin({ x, y, z, onCollect }: { x: number; y: number; z: number; onCollect: () => void }) {
  const ref = useRef<Group>(null);
  const collected = useRef(false);

  useGameLoop((dt) => {
    if (ref.current) {
      ref.current.rotation.y += dt * 3;
    }
  });

  return (
    <Actor
      ref={ref}
      name="coin"
      type="primitive"
      shape="cylinder"
      color="#f59e0b"
      geometryArgs={[0.4, 0.4, 0.1, 16]}
      position={[x, y, z]}
      castShadow
      physics={{
        bodyType: "fixed",
        collider: "cuboid",
        sensor: true,
        onCollisionEnter: (e) => {
          if (e.otherName === "player" && !collected.current) {
            collected.current = true;
            onCollect();
          }
        },
      }}
    />
  );
}

// ── Level Scene ──
function LevelScene({
  coinTime,
  blocks,
  onScore,
  onTimeout,
  setTimeLeft,
}: {
  coinTime: number;
  blocks: BlockData[];
  onScore: () => void;
  onTimeout: () => void;
  setTimeLeft: (t: number) => void;
}) {
  const [coin, setCoin] = useState<CoinData | null>(null);
  const nextId = useRef(0);
  const timer = useRef(coinTime);
  const setPhase = useGameStore((s) => s.setPhase);
  const phase = useGameStore((s) => s.phase);

  useEffect(() => {
    setPhase("playing");
    timer.current = coinTime;
    setTimeLeft(coinTime);
    setCoin(spawnCoin(nextId.current++, blocks));
  }, [setPhase, coinTime, setTimeLeft, blocks]);

  const collectCoin = useCallback(() => {
    onScore();
    timer.current = coinTime;
    setTimeLeft(coinTime);
    setCoin(spawnCoin(nextId.current++, blocks));
  }, [coinTime, onScore, setTimeLeft, blocks]);

  useGameLoop((delta) => {
    if (phase === "gameover") return;
    timer.current -= delta;
    setTimeLeft(Math.max(timer.current, 0));
    if (timer.current <= 0) {
      setPhase("gameover");
      onTimeout();
    }
  });

  const playerRef = useRef<Group>(null);

  return (
    <>
      <Camera
        type="perspective"
        controls="orbit"
        perspectiveProps={{ fov: 60, position: [0, 8, 12] }}
        follow={{ target: playerRef, smoothing: 0.08 }}
      />

      {/* Ground */}
      <Actor
        type="primitive"
        shape="box"
        color="#4a7c59"
        geometryArgs={[40, 0.2, 40]}
        position={[0, -0.1, 0]}
        receiveShadow
        physics={{ bodyType: "fixed", collider: "cuboid", friction: 1 }}
      />

      <Player playerRef={playerRef} />

      {blocks.map((b, i) => (
        <Block key={`block-${i}`} {...b} />
      ))}

      {coin && (
        <Coin key={coin.id} x={coin.x} y={coin.y} z={coin.z} onCollect={collectCoin} />
      )}
    </>
  );
}

// ── HUD ──
function HUD({
  level, score, timeLeft, gameOver, levelComplete, onNext, onRestart,
}: {
  level: number; score: number; timeLeft: number;
  gameOver: boolean; levelComplete: boolean;
  onNext: () => void; onRestart: () => void;
}) {
  const cfg = LEVELS[level];

  return (
    <div style={{
      position: "absolute", top: 0, left: 0, width: "100%", height: "100%",
      pointerEvents: "none", fontFamily: "monospace", color: "#fff", zIndex: 10,
    }}>
      {/* Top bar */}
      <div style={{
        display: "flex", justifyContent: "space-between", alignItems: "center",
        padding: "16px 24px", fontSize: "18px",
      }}>
        <span style={{ color: cfg.color, fontWeight: "bold" }}>{cfg.name}</span>
        <span>Score: {score} / {cfg.coinsNeeded}</span>
        <span>
          Time:{" "}
          <span style={{ color: timeLeft < 1 ? "#ef4444" : "#fff" }}>
            {timeLeft.toFixed(1)}s
          </span>
        </span>
      </div>

      {/* Timer bar */}
      <div style={{ margin: "0 24px", height: 4, background: "#333", borderRadius: 2 }}>
        <div style={{
          width: `${(timeLeft / cfg.coinTime) * 100}%`, height: "100%",
          background: cfg.color, borderRadius: 2, transition: "width 0.1s linear",
        }} />
      </div>

      {/* Controls hint */}
      <div style={{
        position: "absolute", bottom: 16, left: "50%", transform: "translateX(-50%)",
        fontSize: "13px", color: "#999",
      }}>
        WASD = Move &nbsp; Space = Jump
      </div>

      {/* Game Over overlay */}
      {gameOver && (
        <div style={{
          position: "absolute", inset: 0, display: "flex", flexDirection: "column",
          alignItems: "center", justifyContent: "center",
          background: "rgba(0,0,0,0.75)", pointerEvents: "auto",
        }}>
          <div style={{ fontSize: "48px", fontWeight: "bold" }}>
            {levelComplete ? "Level Complete!" : "Time's Up!"}
          </div>
          <div style={{ fontSize: "24px", margin: "12px 0 4px" }}>Score: {score}</div>
          <div style={{ fontSize: "16px", color: "#999", marginBottom: "24px" }}>
            {cfg.name} — {cfg.coinTime}s per coin
          </div>
          <div style={{ display: "flex", gap: 12 }}>
            {levelComplete && level < LEVELS.length - 1 && (
              <button onClick={onNext} style={btnStyle("#22c55e")}>Next Level</button>
            )}
            <button onClick={onRestart} style={btnStyle("#facc15")}>
              {levelComplete ? "Replay" : "Try Again"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

const btnStyle = (bg: string): React.CSSProperties => ({
  padding: "12px 32px", fontSize: "16px", cursor: "pointer",
  background: bg, color: "#000", border: "none", borderRadius: 8,
  fontFamily: "monospace", fontWeight: "bold",
});

// ── Level Select ──
function LevelSelect({ onSelect }: { onSelect: (level: number) => void }) {
  return (
    <div style={{
      position: "absolute", inset: 0, display: "flex", flexDirection: "column",
      alignItems: "center", justifyContent: "center", background: "#0f172a",
      fontFamily: "monospace", color: "#fff", zIndex: 20,
    }}>
      <div style={{ fontSize: "40px", fontWeight: "bold", marginBottom: 8 }}>
        Coin Rush 3D
      </div>
      <div style={{ fontSize: "16px", color: "#999", marginBottom: 40 }}>
        Collect coins before time runs out!
      </div>
      <div style={{ display: "flex", gap: 16 }}>
        {LEVELS.map((cfg, i) => (
          <button key={i} onClick={() => onSelect(i)} style={{
            ...btnStyle(cfg.color), width: 160, display: "flex",
            flexDirection: "column", alignItems: "center", gap: 4, padding: "20px 16px",
          }}>
            <span style={{ fontSize: "18px" }}>{cfg.name}</span>
            <span style={{ fontSize: "12px", opacity: 0.7 }}>{cfg.coinsNeeded} coins — {cfg.coinTime}s each</span>
          </button>
        ))}
      </div>
      <div style={{ fontSize: "13px", color: "#555", marginTop: 32 }}>
        WASD to move, Space to jump
      </div>
    </div>
  );
}

// ── App ──
type Screen = "menu" | "playing";

function App() {
  const [screen, setScreen] = useState<Screen>("menu");
  const [level, setLevel] = useState(0);
  const [gameKey, setGameKey] = useState(0);
  const [score, setScore] = useState(0);
  const [timeLeft, setTimeLeft] = useState(LEVELS[0].coinTime);
  const [gameOver, setGameOver] = useState(false);
  const [levelComplete, setLevelComplete] = useState(false);
  const levelScore = useRef(0);

  const startLevel = useCallback((lvl: number) => {
    levelScore.current = 0;
    setLevel(lvl);
    setScore(0);
    setTimeLeft(LEVELS[lvl].coinTime);
    setGameOver(false);
    setLevelComplete(false);
    setGameKey((k) => k + 1);
    setScreen("playing");
  }, []);

  const handleScore = useCallback(() => {
    levelScore.current += 1;
    setScore((s) => s + 1);
    if (levelScore.current >= LEVELS[level].coinsNeeded) {
      setLevelComplete(true);
      setGameOver(true);
    }
  }, [level]);

  const handleTimeout = useCallback(() => {
    setGameOver(true);
    setLevelComplete(false);
  }, []);

  const nextLevel = useCallback(() => {
    startLevel(Math.min(level + 1, LEVELS.length - 1));
  }, [level, startLevel]);

  const backToMenu = useCallback(() => {
    setScreen("menu");
    setGameOver(false);
    setLevelComplete(false);
  }, []);

  return (
    <div style={{ width: "100vw", height: "100vh", position: "relative" }}>
      {screen === "menu" && <LevelSelect onSelect={startLevel} />}
      {screen === "playing" && (
        <HUD
          level={level} score={score} timeLeft={timeLeft}
          gameOver={gameOver} levelComplete={levelComplete}
          onNext={nextLevel} onRestart={backToMenu}
        />
      )}
      <Game mode="3d" style={{ background: "#87ceeb" }}>
        {LEVELS.map((cfg, i) => (
          <World
            key={`${i}-${gameKey}`}
            active={screen === "playing" && i === level}
            physics={{ gravity: [0, -20, 0], debug: false }}
          >
            {screen === "playing" && i === level && (
              <LevelScene
                coinTime={cfg.coinTime}
                blocks={LEVEL_BLOCKS[i]}
                onScore={handleScore}
                onTimeout={handleTimeout}
                setTimeLeft={setTimeLeft}
              />
            )}
          </World>
        ))}
      </Game>
    </div>
  );
}

export default App;
