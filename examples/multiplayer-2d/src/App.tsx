/**
 * Coin Chase — 2D Multiplayer Game
 * Showcases every major CarverJS API:
 *   Components: Game, World, Actor, Camera
 *   Hooks:      useGameLoop, useInput, useCollision, useCamera
 *   Store:      useGameStore
 *   Multiplayer: MultiplayerProvider, MultiplayerBridge, useRoom, usePlayers,
 *                useHost, useMultiplayer, useNetworkEvents
 */
import { useState, useRef, useCallback, useEffect, forwardRef } from "react";
import { Game, World, Actor, Camera } from "@carverjs/core/components";
import { useGameLoop, useInput, useCollision, useCamera } from "@carverjs/core/hooks";
import { useGameStore } from "@carverjs/core/store";
import type { Group } from "@carverjs/core/types";
import {
  MultiplayerProvider,
  MultiplayerBridge,
  useRoom,
  usePlayers,
  useHost,
  useMultiplayer,
  useNetworkEvents,
} from "@carverjs/multiplayer";
import type { Player, ConnectionState } from "@carverjs/multiplayer";

// ── Constants ──

const ARENA = 14;
const SPEED = 8;
const P_RAD = 0.5;
const C_RAD = 0.35;
const INITIAL_COINS = 8;
const COLORS = ["#ef4444", "#3b82f6", "#22c55e", "#eab308", "#a855f7", "#ec4899"];

// ── CarverJS event types ──

interface GameEvents {
  pos: { x: number; y: number };
  coins: { id: string; x: number; y: number }[];
  collect: { id: string };
  scores: Record<string, number>;
}

// ── Helpers ──

const randArena = () => (Math.random() - 0.5) * (ARENA - 2) * 2;
const mkCoins = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ id: `c${Date.now()}-${i}`, x: randArena(), y: randArena() }));

// ════════════════════════════════════════════════════════════════════════
//  App — CarverJS MultiplayerProvider wraps everything
// ════════════════════════════════════════════════════════════════════════

export default function App() {
  const [roomId, setRoomId] = useState("");
  const [phase, setPhase] = useState<"join" | "room" | "game">("join");

  return (
    <MultiplayerProvider
      appId="coin-chase-demo"
      strategy={{
        type: 'firebase',
        databaseURL: import.meta.env.VITE_FIREBASE_RTDB_URL || 'https://your-project-default-rtdb.firebaseio.com',
      }}
      iceServers={[
        { urls: 'stun:stun.cloudflare.com:3478' },
        ...(import.meta.env.VITE_TURN_TOKEN_ID ? [{
          urls: [
            'turn:turn.cloudflare.com:3478?transport=udp',
            'turn:turn.cloudflare.com:3478?transport=tcp',
            'turns:turn.cloudflare.com:5349?transport=tcp',
          ],
          username: import.meta.env.VITE_TURN_TOKEN_ID,
          credential: import.meta.env.VITE_TURN_API_TOKEN,
        }] : []),
      ]}
    >
      <div style={{ width: "100vw", height: "100vh", position: "relative" }}>
        {phase === "join" && (
          <JoinUI onJoin={(id) => { setRoomId(id); setPhase("room"); }} />
        )}
        {phase !== "join" && roomId && (
          <GameApp roomId={roomId} phase={phase}
            onStart={() => setPhase("game")}
            onBack={() => { setRoomId(""); setPhase("join"); }} />
        )}
      </div>
    </MultiplayerProvider>
  );
}

// ════════════════════════════════════════════════════════════════════════
//  JoinUI — minimal lobby (CarverJS multiplayer doesn't need complex UI)
// ════════════════════════════════════════════════════════════════════════

function JoinUI({ onJoin }: { onJoin: (id: string) => void }) {
  const [id, setId] = useState(`room-${Math.random().toString(36).slice(2, 6)}`);
  return (
    <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", background: "#0f172a", fontFamily: "monospace", color: "#fff" }}>
      <h1 style={{ fontSize: 36, margin: "0 0 4px" }}>Coin Chase</h1>
      <p style={{ color: "#64748b", margin: "0 0 32px" }}>Built with CarverJS</p>
      <div style={{ background: "rgba(15,23,42,.95)", borderRadius: 12, padding: 32, border: "1px solid #334155", width: 400 }}>
        <input value={id} onChange={(e) => setId(e.target.value)} placeholder="Room ID"
          style={{ width: "100%", padding: 10, background: "#1e293b", border: "1px solid #475569", borderRadius: 6, color: "#fff", fontFamily: "monospace", marginBottom: 16, boxSizing: "border-box" }} />
        <button onClick={() => id.trim() && onJoin(id.trim())}
          style={{ width: "100%", padding: 12, background: "#22c55e", border: "none", borderRadius: 6, fontFamily: "monospace", fontWeight: "bold", cursor: "pointer" }}>
          Join / Create Room
        </button>
      </div>
      <p style={{ color: "#334155", fontSize: 11, marginTop: 24 }}>WASD / Arrows to move — Collect coins!</p>
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════
//  GameApp — CarverJS useRoom manages the connection lifecycle
// ════════════════════════════════════════════════════════════════════════

function GameApp({ roomId, phase, onStart, onBack }: {
  roomId: string; phase: "room" | "game"; onStart: () => void; onBack: () => void;
}) {
  // CarverJS useRoom — WebRTC room connection
  const room = useRoom(roomId, { displayName: "Player" });
  const leave = useCallback(() => { room.leave(); onBack(); }, [room, onBack]);

  if (phase === "room") return <RoomUI room={room} onStart={onStart} onLeave={leave} />;
  return <GameView room={room} onLeave={leave} />;
}

// ════════════════════════════════════════════════════════════════════════
//  RoomUI — CarverJS usePlayers + useHost for lobby management
// ════════════════════════════════════════════════════════════════════════

function RoomUI({ room, onStart, onLeave }: {
  room: ReturnType<typeof useRoom>; onStart: () => void; onLeave: () => void;
}) {
  // CarverJS usePlayers — reactive player list
  const { players, self, allReady } = usePlayers();
  // CarverJS useHost — host-only room controls
  const { setRoomState } = useHost();

  const connColors: Record<ConnectionState, string> = {
    disconnected: "#ef4444", connecting: "#eab308", connected: "#22c55e",
    migrating: "#a855f7", reconnecting: "#f97316",
  };

  // Auto-start for non-host when host starts the game
  useEffect(() => {
    if (room.room?.state === "playing" && !room.isHost) onStart();
  }, [room.room?.state, room.isHost, onStart]);

  return (
    <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", background: "#0f172a", fontFamily: "monospace", color: "#fff" }}>
      <h2 style={{ margin: "0 0 4px" }}>Room Lobby</h2>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 24, fontSize: 13 }}>
        <div style={{ width: 8, height: 8, borderRadius: "50%", background: connColors[room.connectionState] }} />
        <span style={{ color: connColors[room.connectionState] }}>{room.connectionState}</span>
      </div>
      <div style={{ background: "rgba(15,23,42,.95)", borderRadius: 12, padding: 24, border: "1px solid #334155", width: 400 }}>
        <div style={{ fontWeight: "bold", marginBottom: 12 }}>Players ({players.length})</div>
        {players.map((p: Player, i: number) => (
          <div key={p.peerId} style={{ display: "flex", justifyContent: "space-between", padding: "8px 12px", background: "#1e293b", borderRadius: 6, marginBottom: 4, border: p.isSelf ? "1px solid #3b82f6" : "1px solid transparent" }}>
            <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ width: 14, height: 14, borderRadius: "50%", background: COLORS[i % COLORS.length], display: "inline-block" }} />
              {p.displayName}{p.isHost ? " (host)" : ""}{p.isSelf ? " (you)" : ""}
            </span>
            <span style={{ color: p.isReady ? "#22c55e" : "#64748b", fontSize: 11 }}>{p.isReady ? "READY" : "..."}</span>
          </div>
        ))}
        <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
          <button onClick={() => self && room.setReady(!self.isReady)}
            style={{ padding: "8px 16px", background: self?.isReady ? "#64748b" : "#22c55e", border: "none", borderRadius: 6, cursor: "pointer", fontFamily: "monospace", fontWeight: "bold" }}>
            {self?.isReady ? "Unready" : "Ready"}
          </button>
          {room.isHost && (
            <button onClick={() => { setRoomState("playing"); onStart(); }}
              disabled={!allReady || players.length < 1}
              style={{ padding: "8px 16px", background: "#3b82f6", border: "none", borderRadius: 6, cursor: "pointer", fontFamily: "monospace", fontWeight: "bold", opacity: allReady ? 1 : 0.4 }}>
              Start Game
            </button>
          )}
          <button onClick={onLeave}
            style={{ padding: "8px 16px", background: "#334155", border: "none", borderRadius: 6, cursor: "pointer", fontFamily: "monospace", fontWeight: "bold" }}>
            Leave
          </button>
        </div>
      </div>
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════
//  GameView — CarverJS Game + World + Camera + all game Actors
// ════════════════════════════════════════════════════════════════════════

function GameView({ room, onLeave }: { room: ReturnType<typeof useRoom>; onLeave: () => void }) {
  // CarverJS usePlayers — player list drives Actor rendering
  const { players } = usePlayers();
  const [scores, setScores] = useState<Record<string, number>>({});

  return (
    <div style={{ width: "100%", height: "100%", position: "relative" }}>
      {/* CarverJS Game — 2D mode sets up orthographic rendering */}
      <Game mode="2d" style={{ background: "#0f172a" }}>
        {/* CarverJS MultiplayerBridge — bridges multiplayer context into R3F Canvas */}
        <MultiplayerBridge>
          {/* CarverJS World — manages camera, physics context */}
          <World>
            {/* CarverJS Camera — orthographic with custom zoom */}
            <Camera type="orthographic" orthographicProps={{ zoom: 35 }} />

            {/* CarverJS useMultiplayer — entity snapshot sync engine */}
            {/* CarverJS useNetworkEvents — game event messaging */}
            <ArenaScene isHost={room.isHost} selfId={room.selfId} players={players} setScores={setScores} />
          </World>
        </MultiplayerBridge>
      </Game>

      {/* Score overlay */}
      <div style={{ position: "absolute", top: 12, right: 12, background: "rgba(15,23,42,.85)", borderRadius: 8, padding: "12px 16px", fontFamily: "monospace", color: "#fff", fontSize: 12, minWidth: 140, zIndex: 20, pointerEvents: "none" }}>
        <div style={{ fontWeight: "bold", marginBottom: 6, borderBottom: "1px solid #334155", paddingBottom: 4 }}>Scores</div>
        {[...players].sort((a, b) => (scores[b.peerId] ?? 0) - (scores[a.peerId] ?? 0)).map((p) => {
          const sortedIds = [...players].map((pp) => pp.peerId).sort();
          const c = COLORS[sortedIds.indexOf(p.peerId) % COLORS.length];
          return (
          <div key={p.peerId} style={{ display: "flex", justifyContent: "space-between", padding: "2px 0" }}>
            <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <span style={{ width: 8, height: 8, borderRadius: "50%", background: c, display: "inline-block" }} />
              {p.displayName}{p.isSelf ? " (you)" : ""}
            </span>
            <span style={{ color: "#eab308", fontWeight: "bold" }}>{scores[p.peerId] ?? 0}</span>
          </div>
          );
        })}
      </div>

      <button onClick={onLeave} style={{ position: "absolute", top: 12, left: 12, zIndex: 20, padding: "6px 14px", background: "#ef4444", border: "none", borderRadius: 6, fontFamily: "monospace", fontWeight: "bold", cursor: "pointer" }}>
        Leave
      </button>
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════
//  ArenaScene — CarverJS game logic hub
//    Uses: useMultiplayer, useNetworkEvents, useGameLoop, useGameStore
// ════════════════════════════════════════════════════════════════════════

function ArenaScene({ isHost, selfId, players, setScores }: {
  isHost: boolean; selfId: string | null; players: Player[];
  setScores: React.Dispatch<React.SetStateAction<Record<string, number>>>;
}) {
  // CarverJS useMultiplayer — activates snapshot sync engine for networked Actors
  useMultiplayer({ mode: "events", tickRate: 60 });

  // CarverJS useNetworkEvents — typed event messaging for game state
  const { broadcast, onEvent } = useNetworkEvents<GameEvents>();

  // CarverJS useGameStore — controls game phase lifecycle
  const setPhase = useGameStore((s) => s.setPhase);
  useEffect(() => { setPhase("playing"); return () => { setPhase("loading"); }; }, [setPhase]);

  // ── Mutable state (CarverJS useGameLoop reads these without React re-renders) ──
  const remotePos = useRef(new Map<string, { x: number; y: number }>());
  const coinsRef = useRef<{ id: string; x: number; y: number }[]>([]);
  const scoresRef = useRef<Record<string, number>>({});
  const [coins, setCoinsUI] = useState<{ id: string; x: number; y: number }[]>([]);

  // Host spawns initial coins
  useEffect(() => {
    if (!isHost) return;
    const c = mkCoins(INITIAL_COINS);
    coinsRef.current = c;
    setCoinsUI(c);
  }, [isHost]);

  // CarverJS useNetworkEvents — listen for game events
  useEffect(() => {
    const u = [
      onEvent("pos", (d, pid) => remotePos.current.set(pid, d)),
      onEvent("coins", (d) => { coinsRef.current = d; setCoinsUI(d); }),
      onEvent("collect", (d, pid) => {
        if (!isHost) return;
        const i = coinsRef.current.findIndex((c) => c.id === d.id);
        if (i < 0) return;
        coinsRef.current.splice(i, 1);
        coinsRef.current.push(mkCoins(1)[0]);
        scoresRef.current = { ...scoresRef.current, [pid]: (scoresRef.current[pid] ?? 0) + 1 };
        setCoinsUI([...coinsRef.current]);
        setScores({ ...scoresRef.current });
        broadcast("coins", coinsRef.current);
        broadcast("scores", scoresRef.current);
      }),
      onEvent("scores", (d) => { scoresRef.current = d; setScores(d); }),
    ];
    return () => u.forEach((fn) => fn());
  }, [isHost, onEvent, broadcast, setScores]);

  // CarverJS useGameLoop — host periodically syncs state (handles late joiners)
  const syncT = useRef(0);
  useGameLoop((dt) => {
    if (!isHost) return;
    syncT.current += dt;
    if (syncT.current < 2) return;
    syncT.current = 0;
    broadcast("coins", coinsRef.current);
    broadcast("scores", scoresRef.current);
  });

  // Coin collection — called from LocalPlayer's CarverJS useCollision
  const collectCoin = useCallback((coinId: string) => {
    if (!selfId) return;
    if (isHost) {
      const i = coinsRef.current.findIndex((c) => c.id === coinId);
      if (i < 0) return;
      coinsRef.current.splice(i, 1);
      coinsRef.current.push(mkCoins(1)[0]);
      scoresRef.current = { ...scoresRef.current, [selfId]: (scoresRef.current[selfId] ?? 0) + 1 };
      setCoinsUI([...coinsRef.current]);
      setScores({ ...scoresRef.current });
      broadcast("coins", coinsRef.current);
      broadcast("scores", scoresRef.current);
    } else {
      broadcast("collect", { id: coinId });
    }
  }, [selfId, isHost, broadcast, setScores]);

  // CarverJS useGameLoop — broadcast local position at 20Hz
  const localRef = useRef<Group>(null);
  const posT = useRef(0);
  useGameLoop((dt) => {
    if (!localRef.current || !selfId) return;
    posT.current += dt;
    if (posT.current < 0.05) return;
    posT.current = 0;
    broadcast("pos", { x: localRef.current.position.x, y: localRef.current.position.y });
  });

  // CarverJS useCamera — smooth camera follow on local player
  useCamera({ follow: { target: localRef, offset: [0, 0, 100], smoothing: 0.08, lookAt: false } });

  // Sort by peerId for consistent color assignment across all clients
  const sortedPeerIds = [...players].map((p) => p.peerId).sort();
  const peerColor = (pid: string) => COLORS[sortedPeerIds.indexOf(pid) % COLORS.length];

  return (
    <>
      {/* CarverJS Actor — arena floor */}
      <Actor type="primitive" shape="plane" materialType="basic" color="#1a1a2e"
        geometryArgs={[ARENA * 2 + 2, ARENA * 2 + 2]} position={[0, 0, -1]} />

      {/* CarverJS Actors — arena walls */}
      <Actor type="primitive" shape="box" materialType="basic" color="#334155" geometryArgs={[ARENA * 2 + 1, 0.4, 1]} position={[0, ARENA, 0]} />
      <Actor type="primitive" shape="box" materialType="basic" color="#334155" geometryArgs={[ARENA * 2 + 1, 0.4, 1]} position={[0, -ARENA, 0]} />
      <Actor type="primitive" shape="box" materialType="basic" color="#334155" geometryArgs={[0.4, ARENA * 2 + 1, 1]} position={[-ARENA, 0, 0]} />
      <Actor type="primitive" shape="box" materialType="basic" color="#334155" geometryArgs={[0.4, ARENA * 2 + 1, 1]} position={[ARENA, 0, 0]} />

      {/* CarverJS Actor — local player (networked, with useInput + useCollision) */}
      {selfId && (
        <LocalPlayer ref={localRef} peerId={selfId}
          color={peerColor(selfId)}
          onCollect={collectCoin} />
      )}

      {/* CarverJS Actors — remote players (networked, with smooth interpolation) */}
      {players.filter((p) => !p.isSelf && p.isConnected).map((p) => {
        return <RemotePlayer key={p.peerId} peerId={p.peerId} color={peerColor(p.peerId)} positions={remotePos} />;
      })}

      {/* CarverJS Actors — coins (with useCollision sensor + animation) */}
      {coins.map((c) => <CoinActor key={c.id} id={c.id} x={c.x} y={c.y} />)}
    </>
  );
}

// ════════════════════════════════════════════════════════════════════════
//  LocalPlayer — CarverJS Actor + useInput + useGameLoop + useCollision
// ════════════════════════════════════════════════════════════════════════

const LocalPlayer = forwardRef<Group, {
  peerId: string; color: string; onCollect: (id: string) => void;
}>(function LocalPlayer({ peerId, color, onCollect }, fwdRef) {
  const ref = useRef<Group>(null);

  // Merge forwarded ref with internal ref
  const setRef = useCallback((node: Group | null) => {
    (ref as { current: Group | null }).current = node;
    if (typeof fwdRef === "function") fwdRef(node);
    else if (fwdRef) (fwdRef as { current: Group | null }).current = node;
  }, [fwdRef]);

  // CarverJS useInput — zero-GC keyboard input polling
  const { getAxis } = useInput();

  // CarverJS useCollision — AABB/circle collision with callbacks
  useCollision({
    ref, name: `player-${peerId}`,
    collider: { shape: "circle", radius: P_RAD },
    onCollisionEnter: (e) => { if (e.otherName.startsWith("c")) onCollect(e.otherName); },
  });

  // CarverJS useGameLoop — WASD movement clamped to arena
  useGameLoop((dt) => {
    if (!ref.current) return;
    const p = ref.current.position;
    p.x = Math.max(-ARENA + P_RAD, Math.min(ARENA - P_RAD, p.x + getAxis("KeyA", "KeyD") * SPEED * dt));
    p.y = Math.max(-ARENA + P_RAD, Math.min(ARENA - P_RAD, p.y + getAxis("KeyS", "KeyW") * SPEED * dt));
  });

  // CarverJS Actor — circle primitive, networked for sync
  return (
    <Actor ref={setRef} name={`player-${peerId}`} type="primitive" shape="circle"
      materialType="basic" color={color} geometryArgs={[P_RAD, 24]} position={[0, 0, 0]}
      networked={{ owner: peerId, sync: "transform", custom: { role: "player" } }} />
  );
});

// ════════════════════════════════════════════════════════════════════════
//  RemotePlayer — CarverJS Actor + useGameLoop for smooth interpolation
// ════════════════════════════════════════════════════════════════════════

function RemotePlayer({ peerId, color, positions }: {
  peerId: string; color: string;
  positions: React.RefObject<Map<string, { x: number; y: number }>>;
}) {
  const ref = useRef<Group>(null);

  // CarverJS useGameLoop — smooth interpolation from event-driven positions
  useGameLoop((dt) => {
    if (!ref.current || !positions.current) return;
    const target = positions.current.get(peerId);
    if (!target) return;
    const t = 1 - Math.pow(0.001, dt);
    ref.current.position.x += (target.x - ref.current.position.x) * t;
    ref.current.position.y += (target.y - ref.current.position.y) * t;
  });

  // CarverJS Actor — networked remote player
  return (
    <Actor ref={ref} name={`remote-${peerId}`} type="primitive" shape="circle"
      materialType="basic" color={color} geometryArgs={[P_RAD, 24]} position={[0, 0, 0]}
      networked={{ owner: peerId, sync: "transform", custom: { role: "player" } }} />
  );
}

// ════════════════════════════════════════════════════════════════════════
//  CoinActor — CarverJS Actor + useCollision sensor + useGameLoop animation
// ════════════════════════════════════════════════════════════════════════

function CoinActor({ id, x, y }: { id: string; x: number; y: number }) {
  const ref = useRef<Group>(null);

  // CarverJS useCollision — sensor mode (triggers events, no physics response)
  useCollision({
    ref, name: id,
    collider: { shape: "circle", radius: C_RAD },
    sensor: true,
  });

  // CarverJS useGameLoop — floating animation
  useGameLoop((_, elapsed) => {
    if (!ref.current) return;
    ref.current.position.y = y + Math.sin(elapsed * 3 + x) * 0.15;
  });

  // CarverJS Actor — gold coin with collision sensor
  return (
    <Actor ref={ref} name={id} type="primitive" shape="circle"
      materialType="basic" color="#f59e0b" geometryArgs={[C_RAD, 16]} position={[x, y, 0.1]}
      networked={{ sync: "transform", custom: { type: "coin" } }} />
  );
}
