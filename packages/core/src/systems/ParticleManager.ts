import {
  InstancedMesh,
  PlaneGeometry,
  RawShaderMaterial,
  InstancedBufferAttribute,
  Matrix4,
  Vector3,
  Quaternion,
  Color,
  DoubleSide,
  NormalBlending,
  AdditiveBlending,
  MultiplyBlending,
  CustomBlending,
  OneFactor,
  OneMinusSrcColorFactor,
  TextureLoader,
} from "three";
import type { Texture, Object3D } from "three";
import type {
  WorldMode,
  ParticleEmitterConfig,
  ParticleData,
  EmitterShapeConfig,
  ValueRange,
  ColorRange,
  LifetimeCurve,
  ColorGradient,
  BurstConfig,
  ParticleBlendMode,
  SpriteSheetConfig,
} from "../types";

// ─── Shader Source ───────────────────────────────────────────────────────────

const VERTEX_SHADER = /* glsl */ `
precision highp float;

uniform mat4 projectionMatrix;
uniform mat4 viewMatrix;
uniform mat4 modelMatrix;

attribute vec3 position;
attribute vec2 uv;
attribute mat4 instanceMatrix;
attribute vec3 instanceColor;
attribute float instanceAlpha;
attribute float instanceSpriteFrame;
attribute float instanceRotation;

varying float vAlpha;
varying vec2 vUv;
varying vec3 vColor;

uniform float uColumns;
uniform float uRows;
uniform bool uBillboard;

void main() {
  vAlpha = instanceAlpha;
  vColor = instanceColor;

  // Sprite sheet UV
  float col = mod(instanceSpriteFrame, uColumns);
  float row = floor(instanceSpriteFrame / uColumns);
  vec2 uvScale = vec2(1.0 / uColumns, 1.0 / uRows);
  vec2 uvOffset = vec2(col / uColumns, 1.0 - (row + 1.0) / uRows);
  vUv = uv * uvScale + uvOffset;

  if (uBillboard) {
    // Extract position and scale from instanceMatrix
    vec3 instancePos = vec3(instanceMatrix[3]);
    float scaleX = length(instanceMatrix[0].xyz);
    float scaleY = length(instanceMatrix[1].xyz);

    // Transform to world space
    vec4 worldPos4 = modelMatrix * vec4(instancePos, 1.0);
    vec3 worldPos = worldPos4.xyz;

    // Camera vectors in world space
    vec3 camRight = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
    vec3 camUp = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);

    // Apply particle rotation around view axis
    float c = cos(instanceRotation);
    float s = sin(instanceRotation);
    vec3 rotRight = camRight * c + camUp * s;
    vec3 rotUp = -camRight * s + camUp * c;

    // Construct billboard vertex
    vec3 finalPos = worldPos
      + rotRight * position.x * scaleX
      + rotUp * position.y * scaleY;

    gl_Position = projectionMatrix * viewMatrix * vec4(finalPos, 1.0);
  } else {
    gl_Position = projectionMatrix * viewMatrix * modelMatrix * instanceMatrix * vec4(position, 1.0);
  }
}
`;

const FRAGMENT_SHADER = /* glsl */ `
precision highp float;

uniform sampler2D uTexture;
uniform bool uHasTexture;

varying float vAlpha;
varying vec2 vUv;
varying vec3 vColor;

void main() {
  vec4 texColor = uHasTexture ? texture2D(uTexture, vUv) : vec4(1.0);
  float alpha = texColor.a * vAlpha;
  if (alpha < 0.01) discard;
  gl_FragColor = vec4(vColor * texColor.rgb, alpha);
}
`;

// ─── Constants ───────────────────────────────────────────────────────────────

const _textureLoader = new TextureLoader();

// ─── Helpers ─────────────────────────────────────────────────────────────────

function sampleValueRange(range: ValueRange): number {
  if (typeof range === "number") return range;
  return range[0] + Math.random() * (range[1] - range[0]);
}

// Pre-allocated Color objects for sampling
const _colorA = new Color();
const _colorB = new Color();

function sampleColorRange(range: ColorRange): [number, number, number] {
  if (Array.isArray(range) && range.length === 2) {
    _colorA.set(range[0] as string | number);
    _colorB.set(range[1] as string | number);
    const t = Math.random();
    return [
      _colorA.r + (_colorB.r - _colorA.r) * t,
      _colorA.g + (_colorB.g - _colorA.g) * t,
      _colorA.b + (_colorB.b - _colorA.b) * t,
    ];
  }
  _colorA.set(range as string | number);
  return [_colorA.r, _colorA.g, _colorA.b];
}

function evaluateCurve(curve: LifetimeCurve, t: number): number {
  const len = curve.length;
  if (len === 0) return 1;
  if (t <= curve[0].t) return curve[0].value;
  if (t >= curve[len - 1].t) return curve[len - 1].value;

  // Binary search
  let lo = 0;
  let hi = len - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (curve[mid].t <= t) lo = mid;
    else hi = mid;
  }

  const a = curve[lo];
  const b = curve[hi];
  const frac = (t - a.t) / (b.t - a.t);
  return a.value + (b.value - a.value) * frac;
}

function evaluateColorGradient(
  gradient: ColorGradient,
  t: number,
): [number, number, number] {
  const len = gradient.length;
  if (len === 0) return [1, 1, 1];

  if (t <= gradient[0].t) {
    _colorA.set(gradient[0].color as string | number);
    return [_colorA.r, _colorA.g, _colorA.b];
  }
  if (t >= gradient[len - 1].t) {
    _colorA.set(gradient[len - 1].color as string | number);
    return [_colorA.r, _colorA.g, _colorA.b];
  }

  let lo = 0;
  let hi = len - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (gradient[mid].t <= t) lo = mid;
    else hi = mid;
  }

  _colorA.set(gradient[lo].color as string | number);
  _colorB.set(gradient[hi].color as string | number);
  const frac = (t - gradient[lo].t) / (gradient[hi].t - gradient[lo].t);
  return [
    _colorA.r + (_colorB.r - _colorA.r) * frac,
    _colorA.g + (_colorB.g - _colorA.g) * frac,
    _colorA.b + (_colorB.b - _colorA.b) * frac,
  ];
}

function resolveBlending(mode: ParticleBlendMode) {
  switch (mode) {
    case "additive":
      return { blending: AdditiveBlending };
    case "multiply":
      return { blending: MultiplyBlending };
    case "screen":
      return {
        blending: CustomBlending,
        blendSrc: OneFactor,
        blendDst: OneMinusSrcColorFactor,
      };
    default:
      return { blending: NormalBlending };
  }
}

function loadTexture(src: Texture | string): Texture {
  if (typeof src === "string") return _textureLoader.load(src);
  return src;
}

// ─── Particle Data Factory ──────────────────────────────────────────────────

function createParticleData(max: number): ParticleData {
  return {
    posX: new Float32Array(max),
    posY: new Float32Array(max),
    posZ: new Float32Array(max),
    velX: new Float32Array(max),
    velY: new Float32Array(max),
    velZ: new Float32Array(max),
    accX: new Float32Array(max),
    accY: new Float32Array(max),
    accZ: new Float32Array(max),
    age: new Float32Array(max),
    lifetime: new Float32Array(max),
    size: new Float32Array(max),
    initialSize: new Float32Array(max),
    rotation: new Float32Array(max),
    rotationSpeed: new Float32Array(max),
    initialRotationSpeed: new Float32Array(max),
    alpha: new Float32Array(max),
    initialAlpha: new Float32Array(max),
    initialSpeed: new Float32Array(max),
    drag: new Float32Array(max),
    colorR: new Float32Array(max),
    colorG: new Float32Array(max),
    colorB: new Float32Array(max),
    spriteFrame: new Float32Array(max),
    spriteElapsed: new Float32Array(max),
    alive: new Uint8Array(max),
  };
}

// ─── EmitterInstance ─────────────────────────────────────────────────────────

let _emitterIdCounter = 0;

class EmitterInstance {
  readonly id: string;
  readonly mesh: InstancedMesh;

  // Public: set by the React component to provide emitter world position
  source: Object3D | null = null;

  // Config
  private _maxParticles: number;
  private _emission: "stream" | "burst";
  private _rate: ValueRange;
  private _bursts: BurstConfig[];
  private _duration: number;
  private _loop: boolean;
  private _startDelay: number;
  private _shape: EmitterShapeConfig;
  private _particle: NonNullable<ParticleEmitterConfig["particle"]>;
  private _overLifetime: NonNullable<ParticleEmitterConfig["overLifetime"]>;
  private _billboard: boolean;
  private _space: "world" | "local";
  private _sortByDistance: boolean;
  private _spriteSheet: SpriteSheetConfig | null;
  private _mode: WorldMode = "3d";

  // Callbacks
  private _onParticleBorn: ((index: number) => void) | null;
  private _onParticleDeath: ((index: number) => void) | null;
  private _onComplete: (() => void) | null;

  // Particle data (SoA)
  private _data: ParticleData;

  // Emission state
  private _emitting: boolean;
  private _elapsed = 0;
  private _emissionAccumulator = 0;
  private _burstTimers: number[];
  private _burstCycles: number[];
  private _aliveCount = 0;
  private _freeList: number[];
  private _delayRemaining: number;
  private _emissionComplete = false;

  // GPU buffers
  private _material: RawShaderMaterial;
  private _alphaArray: Float32Array;
  private _spriteFrameArray: Float32Array;
  private _rotationArray: Float32Array;
  private _alphaAttr: InstancedBufferAttribute;
  private _spriteFrameAttr: InstancedBufferAttribute;
  private _rotationAttr: InstancedBufferAttribute;

  // Pre-allocated temporaries (zero GC)
  private _tmpMatrix = new Matrix4();
  private _tmpPosition = new Vector3();
  private _tmpQuaternion = new Quaternion();
  private _tmpScale = new Vector3();
  private _tmpColor = new Color();
  private _emitterPos = new Vector3();
  private _emitterQuat = new Quaternion();

  constructor(config: ParticleEmitterConfig, mode: WorldMode) {
    this.id = `particle_${++_emitterIdCounter}`;
    this._mode = mode;

    // Resolve config with defaults
    this._maxParticles = config.maxParticles ?? 1000;
    this._emission = config.emission ?? "stream";
    this._rate = config.rate ?? 50;
    this._bursts = config.bursts ?? [];
    this._duration = config.duration ?? Infinity;
    this._loop = config.loop ?? true;
    this._startDelay = config.startDelay ?? 0;
    this._shape = config.shape ?? { shape: "point" };
    this._particle = config.particle ?? {};
    this._overLifetime = config.overLifetime ?? {};
    this._billboard = config.billboard ?? true;
    this._space = config.space ?? "world";
    this._sortByDistance = config.sortByDistance ?? false;
    this._spriteSheet = config.spriteSheet ?? null;

    // Callbacks
    this._onParticleBorn = config.onParticleBorn ?? null;
    this._onParticleDeath = config.onParticleDeath ?? null;
    this._onComplete = config.onComplete ?? null;

    // Emission state
    this._emitting = config.autoPlay ?? true;
    this._delayRemaining = this._startDelay;

    // Burst timers
    this._burstTimers = this._bursts.map(() => 0);
    this._burstCycles = this._bursts.map(() => 0);

    // Free list (stack)
    this._freeList = [];
    for (let i = this._maxParticles - 1; i >= 0; i--) {
      this._freeList.push(i);
    }

    // Allocate SoA particle data
    this._data = createParticleData(this._maxParticles);

    // --- GPU Setup ---

    // Geometry: unit plane
    const geometry = new PlaneGeometry(1, 1);

    // Resolve texture
    let texture: Texture | null = null;
    let columns = 1;
    let rows = 1;

    if (this._spriteSheet) {
      texture = loadTexture(this._spriteSheet.texture);
      columns = this._spriteSheet.columns;
      rows = this._spriteSheet.rows;
    } else if (config.texture) {
      texture = loadTexture(config.texture);
    }

    // Material
    const blendConfig = resolveBlending(config.blendMode ?? "normal");
    this._material = new RawShaderMaterial({
      uniforms: {
        uTexture: { value: texture },
        uHasTexture: { value: texture !== null },
        uColumns: { value: columns },
        uRows: { value: rows },
        uBillboard: { value: this._billboard },
      },
      vertexShader: VERTEX_SHADER,
      fragmentShader: FRAGMENT_SHADER,
      transparent: true,
      depthWrite: false,
      side: DoubleSide,
      ...blendConfig,
    });

    // InstancedMesh
    this.mesh = new InstancedMesh(geometry, this._material, this._maxParticles);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;

    // Ensure instanceColor is initialised
    this._tmpColor.set(1, 1, 1);
    for (let i = 0; i < this._maxParticles; i++) {
      this.mesh.setColorAt(i, this._tmpColor);
    }

    // Custom per-instance attributes
    this._alphaArray = new Float32Array(this._maxParticles);
    this._spriteFrameArray = new Float32Array(this._maxParticles);
    this._rotationArray = new Float32Array(this._maxParticles);

    this._alphaAttr = new InstancedBufferAttribute(this._alphaArray, 1);
    this._spriteFrameAttr = new InstancedBufferAttribute(
      this._spriteFrameArray,
      1,
    );
    this._rotationAttr = new InstancedBufferAttribute(this._rotationArray, 1);

    geometry.setAttribute("instanceAlpha", this._alphaAttr);
    geometry.setAttribute("instanceSpriteFrame", this._spriteFrameAttr);
    geometry.setAttribute("instanceRotation", this._rotationAttr);
  }

  // ── Public Controls ──

  start(): void {
    this._emitting = true;
    this._emissionComplete = false;
  }

  stop(): void {
    this._emitting = false;
  }

  clear(): void {
    this._emitting = false;
    for (let i = 0; i < this._maxParticles; i++) {
      if (this._data.alive[i]) {
        this._data.alive[i] = 0;
        this._freeList.push(i);
      }
    }
    this._aliveCount = 0;
    this.mesh.count = 0;
  }

  reset(): void {
    this.clear();
    this._elapsed = 0;
    this._emissionAccumulator = 0;
    this._delayRemaining = this._startDelay;
    this._emissionComplete = false;
    for (let b = 0; b < this._bursts.length; b++) {
      this._burstTimers[b] = 0;
      this._burstCycles[b] = 0;
    }
    this._emitting = true;
  }

  burst(count?: number): void {
    const c = count ?? 30;
    this._emit(typeof c === "number" ? c : sampleValueRange(c));
  }

  setRate(rate: number): void {
    this._rate = rate;
  }

  getActiveCount(): number {
    return this._aliveCount;
  }

  isEmitting(): boolean {
    return this._emitting;
  }

  setMode(mode: WorldMode): void {
    this._mode = mode;
  }

  // ── Per-Frame Tick ──

  tick(delta: number): void {
    // Update emitter world position from source
    if (this.source) {
      if (this._space === "world") {
        this.source.getWorldPosition(this._emitterPos);
        this.source.getWorldQuaternion(this._emitterQuat);
      }
    }

    // Handle start delay
    if (this._delayRemaining > 0) {
      this._delayRemaining -= delta;
      if (this._delayRemaining > 0) {
        // Still waiting — but update existing particles
        this._updatePhase(delta);
        this._writePhase();
        return;
      }
      // Delay expired, carry overflow
      delta = -this._delayRemaining;
      this._delayRemaining = 0;
    }

    // Emission phase
    if (this._emitting) {
      this._emitPhase(delta);
    }

    // Update phase
    this._updatePhase(delta);

    // Write GPU buffers
    this._writePhase();

    // Check completion
    if (
      !this._emitting &&
      this._aliveCount === 0 &&
      !this._emissionComplete
    ) {
      this._emissionComplete = true;
      this._onComplete?.();
    }
  }

  // ── Emission Phase ──

  private _emitPhase(delta: number): void {
    this._elapsed += delta;

    // Emit BEFORE checking duration so that duration:0 bursts fire on their first tick
    if (this._emission === "stream") {
      // Stream emission: accumulate fractional particles
      const rate = sampleValueRange(this._rate);
      this._emissionAccumulator += rate * delta;
      const count = Math.floor(this._emissionAccumulator);
      if (count > 0) {
        this._emissionAccumulator -= count;
        this._emit(count);
      }
    } else {
      // Burst emission: check burst schedule
      for (let b = 0; b < this._bursts.length; b++) {
        const burst = this._bursts[b];
        const time = burst.time ?? 0;
        const cycles = burst.cycles ?? 1;
        const interval = burst.interval ?? 1;

        if (this._elapsed < time) continue;

        const timeSinceBurstStart = this._elapsed - time;
        const expectedCycle = Math.floor(timeSinceBurstStart / interval);
        const maxCycles = cycles === 0 ? Infinity : cycles;

        while (this._burstCycles[b] <= expectedCycle && this._burstCycles[b] < maxCycles) {
          const count = Math.round(sampleValueRange(burst.count));
          this._emit(count);
          this._burstCycles[b]++;
        }
      }
    }

    // Check duration AFTER emission so duration:0 bursts fire on their first tick
    if (this._duration !== Infinity && this._elapsed >= this._duration) {
      if (this._loop) {
        this._elapsed -= this._duration;
        for (let b = 0; b < this._bursts.length; b++) {
          this._burstTimers[b] = 0;
          this._burstCycles[b] = 0;
        }
      } else {
        this._emitting = false;
      }
    }
  }

  // ── Emit N Particles ──

  private _emit(count: number): void {
    const d = this._data;
    const p = this._particle;
    const is2D = this._mode === "2d";

    for (let n = 0; n < count; n++) {
      if (this._freeList.length === 0) return; // Pool exhausted
      const i = this._freeList.pop()!;

      // Sample position and direction from shape
      const [sx, sy, sz, dx, dy, dz] = this._sampleShape(is2D);

      // Apply emitter world transform to spawn position
      if (this._space === "world" && this.source) {
        this._tmpPosition.set(sx, sy, sz);
        this._tmpPosition.applyQuaternion(this._emitterQuat);
        this._tmpPosition.add(this._emitterPos);
        d.posX[i] = this._tmpPosition.x;
        d.posY[i] = this._tmpPosition.y;
        d.posZ[i] = this._tmpPosition.z;
      } else {
        d.posX[i] = sx;
        d.posY[i] = sy;
        d.posZ[i] = sz;
      }

      // Speed and velocity
      const speed = sampleValueRange(p.speed ?? 5);
      d.initialSpeed[i] = speed;

      // Apply emitter rotation to direction for world-space
      if (this._space === "world" && this.source) {
        this._tmpPosition.set(dx, dy, dz);
        this._tmpPosition.applyQuaternion(this._emitterQuat);
        d.velX[i] = this._tmpPosition.x * speed;
        d.velY[i] = this._tmpPosition.y * speed;
        d.velZ[i] = this._tmpPosition.z * speed;
      } else {
        d.velX[i] = dx * speed;
        d.velY[i] = dy * speed;
        d.velZ[i] = dz * speed;
      }

      // Acceleration
      const acc = p.acceleration ?? [0, 0, 0];
      const gravity = p.gravity ?? 0;
      d.accX[i] = acc[0];
      d.accY[i] = acc[1] - gravity;
      d.accZ[i] = acc[2];

      // Scalar properties
      d.age[i] = 0;
      d.lifetime[i] = Math.max(0.001, sampleValueRange(p.lifetime ?? 1));
      const size = sampleValueRange(p.size ?? 1);
      d.size[i] = size;
      d.initialSize[i] = size;
      d.rotation[i] = sampleValueRange(p.rotation ?? 0);
      const rotSpeed = sampleValueRange(p.rotationSpeed ?? 0);
      d.rotationSpeed[i] = rotSpeed;
      d.initialRotationSpeed[i] = rotSpeed;
      const alpha = sampleValueRange(p.alpha ?? 1);
      d.alpha[i] = alpha;
      d.initialAlpha[i] = alpha;
      d.drag[i] = p.drag ?? 0;

      // Color
      const [r, g, b] = sampleColorRange(p.color ?? "#ffffff");
      d.colorR[i] = r;
      d.colorG[i] = g;
      d.colorB[i] = b;

      // Sprite animation
      if (this._spriteSheet) {
        const totalFrames =
          this._spriteSheet.totalFrames ??
          this._spriteSheet.columns * this._spriteSheet.rows;
        d.spriteFrame[i] = this._spriteSheet.randomStart
          ? Math.floor(Math.random() * totalFrames)
          : (this._spriteSheet.startFrame ?? 0);
        d.spriteElapsed[i] = 0;
      } else {
        d.spriteFrame[i] = 0;
        d.spriteElapsed[i] = 0;
      }

      d.alive[i] = 1;
      this._aliveCount++;

      this._onParticleBorn?.(i);
    }
  }

  // ── Update Phase ──

  private _updatePhase(delta: number): void {
    const d = this._data;
    const ol = this._overLifetime;

    for (let i = 0; i < this._maxParticles; i++) {
      if (!d.alive[i]) continue;

      // Age
      d.age[i] += delta;
      if (d.age[i] >= d.lifetime[i]) {
        // Kill particle
        d.alive[i] = 0;
        this._aliveCount--;
        this._freeList.push(i);
        this._onParticleDeath?.(i);
        continue;
      }

      const t = d.age[i] / d.lifetime[i]; // Normalized lifetime [0, 1]

      // Drag
      const drag = d.drag[i];
      if (drag > 0) {
        const factor = 1 - drag * delta;
        d.velX[i] *= factor;
        d.velY[i] *= factor;
        d.velZ[i] *= factor;
      }

      // Velocity += acceleration * dt
      d.velX[i] += d.accX[i] * delta;
      d.velY[i] += d.accY[i] * delta;
      d.velZ[i] += d.accZ[i] * delta;

      // Over-lifetime speed multiplier
      if (ol.speed) {
        const speedMul = evaluateCurve(ol.speed, t);
        const currentSpeed = Math.sqrt(
          d.velX[i] * d.velX[i] +
            d.velY[i] * d.velY[i] +
            d.velZ[i] * d.velZ[i],
        );
        if (currentSpeed > 0.0001) {
          const targetSpeed = d.initialSpeed[i] * speedMul;
          const scale = targetSpeed / currentSpeed;
          d.velX[i] *= scale;
          d.velY[i] *= scale;
          d.velZ[i] *= scale;
        }
      }

      // Position += velocity * dt
      d.posX[i] += d.velX[i] * delta;
      d.posY[i] += d.velY[i] * delta;
      d.posZ[i] += d.velZ[i] * delta;

      // Over-lifetime size
      if (ol.size) {
        d.size[i] = d.initialSize[i] * evaluateCurve(ol.size, t);
      }

      // Over-lifetime alpha
      if (ol.alpha) {
        d.alpha[i] = d.initialAlpha[i] * evaluateCurve(ol.alpha, t);
      }

      // Over-lifetime color
      if (ol.color) {
        const [cr, cg, cb] = evaluateColorGradient(ol.color, t);
        d.colorR[i] = cr;
        d.colorG[i] = cg;
        d.colorB[i] = cb;
      }

      // Over-lifetime rotation speed
      if (ol.rotationSpeed) {
        d.rotationSpeed[i] =
          d.initialRotationSpeed[i] * evaluateCurve(ol.rotationSpeed, t);
      }

      // Rotation
      d.rotation[i] += d.rotationSpeed[i] * delta;

      // Sprite animation
      if (this._spriteSheet) {
        const fps = this._spriteSheet.fps ?? 30;
        const totalFrames =
          this._spriteSheet.totalFrames ??
          this._spriteSheet.columns * this._spriteSheet.rows;
        d.spriteElapsed[i] += delta;
        const frameAdvance = Math.floor(d.spriteElapsed[i] * fps);
        if (frameAdvance > 0) {
          d.spriteElapsed[i] -= frameAdvance / fps;
          let newFrame = d.spriteFrame[i] + frameAdvance;
          if (this._spriteSheet.loop ?? true) {
            newFrame = newFrame % totalFrames;
          } else {
            newFrame = Math.min(newFrame, totalFrames - 1);
          }
          d.spriteFrame[i] = newFrame;
        }
      }
    }
  }

  // ── Write GPU Buffers ──

  private _writePhase(): void {
    if (this._aliveCount === 0) {
      this.mesh.count = 0;
      this.mesh.visible = false;
      return;
    }

    this.mesh.visible = true;
    const d = this._data;
    let writeIndex = 0;

    this._tmpQuaternion.identity();

    for (let i = 0; i < this._maxParticles; i++) {
      if (!d.alive[i]) continue;

      // Position
      this._tmpPosition.set(d.posX[i], d.posY[i], d.posZ[i]);

      // Scale (uniform)
      const s = d.size[i];
      this._tmpScale.set(s, s, s);

      // Compose matrix (rotation handled in shader for billboard)
      this._tmpMatrix.compose(
        this._tmpPosition,
        this._tmpQuaternion,
        this._tmpScale,
      );
      this.mesh.setMatrixAt(writeIndex, this._tmpMatrix);

      // Color
      this._tmpColor.setRGB(d.colorR[i], d.colorG[i], d.colorB[i]);
      this.mesh.setColorAt(writeIndex, this._tmpColor);

      // Custom attributes
      this._alphaArray[writeIndex] = d.alpha[i];
      this._spriteFrameArray[writeIndex] = d.spriteFrame[i];
      this._rotationArray[writeIndex] = d.rotation[i];

      writeIndex++;
    }

    this.mesh.count = writeIndex;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
    this._alphaAttr.needsUpdate = true;
    this._spriteFrameAttr.needsUpdate = true;
    this._rotationAttr.needsUpdate = true;
  }

  // ── Shape Sampling ──

  private _sampleShape(
    is2D: boolean,
  ): [number, number, number, number, number, number] {
    const cfg = this._shape;

    switch (cfg.shape) {
      case "point":
        return [0, 0, 0, 0, 1, 0];

      case "cone": {
        const angle = (cfg as { angle?: number }).angle ?? Math.PI / 4;
        const radius = (cfg as { radius?: number }).radius ?? 1;
        const surface = (cfg as { surface?: boolean }).surface ?? false;
        const theta = Math.random() * Math.PI * 2;
        const phi = Math.random() * angle;
        const r = surface ? radius : Math.random() * radius;
        const sinPhi = Math.sin(phi);
        const cosPhi = Math.cos(phi);
        const x = r * sinPhi * Math.cos(theta);
        const z = is2D ? 0 : r * sinPhi * Math.sin(theta);
        const y = r * cosPhi;
        const dx = sinPhi * Math.cos(theta);
        const dz = is2D ? 0 : sinPhi * Math.sin(theta);
        const dy = cosPhi;
        return [x, y, z, dx, dy, dz];
      }

      case "sphere": {
        const radius = (cfg as { radius?: number }).radius ?? 1;
        const surface = (cfg as { surface?: boolean }).surface ?? false;
        const theta = Math.random() * Math.PI * 2;
        const phi = Math.acos(2 * Math.random() - 1);
        const r = surface ? radius : Math.cbrt(Math.random()) * radius;
        const sinPhi = Math.sin(phi);
        const x = r * sinPhi * Math.cos(theta);
        const y = r * Math.cos(phi);
        const z = is2D ? 0 : r * sinPhi * Math.sin(theta);
        const len = Math.sqrt(x * x + y * y + z * z) || 1;
        return [x, y, z, x / len, y / len, z / len];
      }

      case "rectangle": {
        const w = (cfg as { width?: number }).width ?? 1;
        const h = (cfg as { height?: number }).height ?? 1;
        const x = (Math.random() - 0.5) * w;
        const y = (Math.random() - 0.5) * h;
        return [x, y, 0, 0, 0, is2D ? 0 : 1];
      }

      case "edge": {
        const from = (cfg as { from?: [number, number, number] }).from ?? [
          -0.5, 0, 0,
        ];
        const to = (cfg as { to?: [number, number, number] }).to ?? [
          0.5, 0, 0,
        ];
        const t = Math.random();
        const x = from[0] + (to[0] - from[0]) * t;
        const y = from[1] + (to[1] - from[1]) * t;
        const z = from[2] + (to[2] - from[2]) * t;
        return [x, y, z, 0, 1, 0];
      }

      case "ring": {
        const outerR = (cfg as { radius?: number }).radius ?? 1;
        const innerR = (cfg as { innerRadius?: number }).innerRadius ?? outerR * 0.8;
        const theta = Math.random() * Math.PI * 2;
        const r = innerR + Math.random() * (outerR - innerR);
        const x = r * Math.cos(theta);
        const z = is2D ? 0 : r * Math.sin(theta);
        const y = is2D ? r * Math.sin(theta) : 0;
        const len = Math.sqrt(x * x + y * y + z * z) || 1;
        return [x, y, z, x / len, y / len, z / len];
      }
    }
  }

  // ── Dispose ──

  dispose(): void {
    this.mesh.geometry.dispose();
    this._material.dispose();
    if (this._material.uniforms.uTexture.value) {
      // Only dispose textures we loaded from URL
      const tex = this._material.uniforms.uTexture.value as Texture;
      tex.dispose();
    }
    // Remove from parent
    if (this.mesh.parent) {
      this.mesh.parent.remove(this.mesh);
    }
  }
}

// ─── ParticleManager ─────────────────────────────────────────────────────────

class ParticleManager {
  private _emitters = new Map<string, EmitterInstance>();
  private _mode: WorldMode = "3d";

  setMode(mode: WorldMode): void {
    this._mode = mode;
    for (const emitter of this._emitters.values()) {
      emitter.setMode(mode);
    }
  }

  createEmitter(config: ParticleEmitterConfig): string {
    const emitter = new EmitterInstance(config, this._mode);
    this._emitters.set(emitter.id, emitter);
    return emitter.id;
  }

  destroyEmitter(id: string): void {
    const emitter = this._emitters.get(id);
    if (!emitter) return;
    emitter.dispose();
    this._emitters.delete(id);
  }

  getEmitter(id: string): EmitterInstance | undefined {
    return this._emitters.get(id);
  }

  tick(delta: number): void {
    for (const emitter of this._emitters.values()) {
      emitter.tick(delta);
    }
  }

  dispose(): void {
    for (const emitter of this._emitters.values()) {
      emitter.dispose();
    }
    this._emitters.clear();
  }
}

// ─── Singleton ───────────────────────────────────────────────────────────────

let _instance: ParticleManager | null = null;

export function getParticleManager(): ParticleManager {
  if (!_instance) _instance = new ParticleManager();
  return _instance;
}

export function destroyParticleManager(): void {
  _instance?.dispose();
  _instance = null;
}
