import type { ParticleEmitterConfig, ParticlePreset } from "../types";

// ─── Built-in Presets ───────────────────────────────────────────────────────

const PRESETS: Record<ParticlePreset, ParticleEmitterConfig> = {
  fire: {
    maxParticles: 500,
    emission: "stream",
    rate: 80,
    shape: { shape: "cone", angle: Math.PI / 8, radius: 0.3 },
    particle: {
      speed: [2, 5],
      lifetime: [0.5, 1.5],
      size: [0.3, 0.8],
      color: ["#ff4400", "#ffaa00"],
      alpha: 1,
      gravity: -1,
      drag: 0.05,
    },
    overLifetime: {
      size: [
        { t: 0, value: 0.5 },
        { t: 0.3, value: 1 },
        { t: 1, value: 0 },
      ],
      alpha: [
        { t: 0, value: 1 },
        { t: 0.6, value: 0.8 },
        { t: 1, value: 0 },
      ],
      color: [
        { t: 0, color: "#ffffff" },
        { t: 0.2, color: "#ffaa00" },
        { t: 0.5, color: "#ff4400" },
        { t: 1, color: "#220000" },
      ],
    },
    blendMode: "additive",
    billboard: true,
  },

  smoke: {
    maxParticles: 300,
    emission: "stream",
    rate: 30,
    shape: { shape: "cone", angle: Math.PI / 10, radius: 0.2 },
    particle: {
      speed: [1, 3],
      lifetime: [2, 4],
      size: [0.5, 1.5],
      color: ["#888888", "#aaaaaa"],
      alpha: 0.6,
      gravity: -0.5,
      drag: 0.1,
      rotationSpeed: [-0.5, 0.5],
    },
    overLifetime: {
      size: [
        { t: 0, value: 0.5 },
        { t: 1, value: 2.5 },
      ],
      alpha: [
        { t: 0, value: 0 },
        { t: 0.1, value: 1 },
        { t: 0.6, value: 0.6 },
        { t: 1, value: 0 },
      ],
    },
    blendMode: "normal",
    billboard: true,
  },

  explosion: {
    maxParticles: 200,
    emission: "burst",
    bursts: [
      { time: 0, count: [60, 100] },
      { time: 0.05, count: [30, 50] },
    ],
    duration: 0,
    loop: false,
    shape: { shape: "sphere", radius: 0.2, surface: true },
    particle: {
      speed: [5, 15],
      lifetime: [0.3, 1.0],
      size: [0.2, 0.6],
      color: ["#ff8800", "#ffff00"],
      alpha: 1,
      drag: 0.15,
      gravity: 3,
    },
    overLifetime: {
      size: [
        { t: 0, value: 1 },
        { t: 0.3, value: 1.5 },
        { t: 1, value: 0 },
      ],
      alpha: [
        { t: 0, value: 1 },
        { t: 0.5, value: 0.8 },
        { t: 1, value: 0 },
      ],
      color: [
        { t: 0, color: "#ffffff" },
        { t: 0.2, color: "#ffaa00" },
        { t: 0.6, color: "#ff4400" },
        { t: 1, color: "#330000" },
      ],
    },
    blendMode: "additive",
    billboard: true,
  },

  sparks: {
    maxParticles: 300,
    emission: "burst",
    bursts: [{ time: 0, count: [20, 50] }],
    duration: 0,
    loop: false,
    shape: { shape: "point" },
    particle: {
      speed: [3, 12],
      lifetime: [0.2, 0.8],
      size: [0.02, 0.08],
      color: ["#ffcc00", "#ff8800"],
      alpha: 1,
      gravity: 5,
      drag: 0.02,
    },
    overLifetime: {
      alpha: [
        { t: 0, value: 1 },
        { t: 0.8, value: 1 },
        { t: 1, value: 0 },
      ],
    },
    blendMode: "additive",
    billboard: true,
  },

  rain: {
    maxParticles: 2000,
    emission: "stream",
    rate: 500,
    shape: { shape: "rectangle", width: 30, height: 0 },
    particle: {
      speed: [8, 12],
      lifetime: [1, 2],
      size: [0.01, 0.03],
      color: "#aaccff",
      alpha: 0.4,
      acceleration: [0, -15, 0],
    },
    overLifetime: {
      alpha: [
        { t: 0, value: 0 },
        { t: 0.05, value: 1 },
        { t: 0.9, value: 1 },
        { t: 1, value: 0 },
      ],
    },
    blendMode: "additive",
    billboard: false,
  },

  snow: {
    maxParticles: 1000,
    emission: "stream",
    rate: 100,
    shape: { shape: "rectangle", width: 20, height: 0 },
    particle: {
      speed: [0.5, 2],
      lifetime: [3, 6],
      size: [0.05, 0.15],
      color: "#ffffff",
      alpha: 0.8,
      acceleration: [0, -1, 0],
      rotationSpeed: [-1, 1],
    },
    overLifetime: {
      alpha: [
        { t: 0, value: 0 },
        { t: 0.1, value: 1 },
        { t: 0.8, value: 1 },
        { t: 1, value: 0 },
      ],
    },
    blendMode: "normal",
    billboard: true,
  },

  magic: {
    maxParticles: 400,
    emission: "stream",
    rate: 60,
    shape: { shape: "sphere", radius: 0.5 },
    particle: {
      speed: [0.5, 2],
      lifetime: [1, 2],
      size: [0.05, 0.2],
      color: ["#8844ff", "#44aaff"],
      alpha: 1,
      drag: 0.1,
      rotationSpeed: [-2, 2],
    },
    overLifetime: {
      size: [
        { t: 0, value: 0 },
        { t: 0.2, value: 1 },
        { t: 0.8, value: 1 },
        { t: 1, value: 0 },
      ],
      alpha: [
        { t: 0, value: 0 },
        { t: 0.15, value: 1 },
        { t: 0.7, value: 0.8 },
        { t: 1, value: 0 },
      ],
      color: [
        { t: 0, color: "#8844ff" },
        { t: 0.5, color: "#44aaff" },
        { t: 1, color: "#8844ff" },
      ],
    },
    blendMode: "additive",
    billboard: true,
  },

  confetti: {
    maxParticles: 500,
    emission: "burst",
    bursts: [{ time: 0, count: [80, 150] }],
    duration: 0,
    loop: false,
    shape: { shape: "cone", angle: Math.PI / 3, radius: 0.5 },
    particle: {
      speed: [5, 12],
      lifetime: [2, 4],
      size: [0.1, 0.3],
      color: ["#ff0000", "#00ff00"],
      alpha: 1,
      gravity: 4,
      drag: 0.05,
      rotation: [0, Math.PI * 2],
      rotationSpeed: [-5, 5],
    },
    overLifetime: {
      alpha: [
        { t: 0, value: 1 },
        { t: 0.8, value: 1 },
        { t: 1, value: 0 },
      ],
    },
    blendMode: "normal",
    billboard: false,
  },
};

// ─── Custom Presets Registry ────────────────────────────────────────────────

const _customPresets = new Map<string, ParticleEmitterConfig>();

export function getParticlePreset(
  name: ParticlePreset | string,
): ParticleEmitterConfig {
  const builtin = PRESETS[name as ParticlePreset];
  if (builtin) return builtin;
  const custom = _customPresets.get(name);
  if (custom) return custom;
  return {};
}

export function registerParticlePreset(
  name: string,
  config: ParticleEmitterConfig,
): void {
  _customPresets.set(name, config);
}
