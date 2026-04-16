/* ------------------------------------------------------------------ */
/*  DebugOverlay – DOM-based stats panel for multiplayer diagnostics  */
/* ------------------------------------------------------------------ */

export interface DebugOverlayOptions {
  position?: "top-left" | "top-right" | "bottom-left" | "bottom-right";
  /** Keyboard key used to toggle visibility (default: "F3") */
  keyboardToggle?: string;
}

export interface DebugStats {
  tick: number;
  serverTick: number;
  drift: number;
  /** Per-peer latency map or a single average value */
  latencyMs: Map<string, number> | number;
  /** Packet-loss rate in the range 0-1 */
  packetLossRate: number;
  /** Inbound bandwidth in bytes / second */
  bandwidthIn: number;
  /** Outbound bandwidth in bytes / second */
  bandwidthOut: number;
  networkQuality: "good" | "degraded" | "poor";
  peerCount: number;
  isHost: boolean;
  syncMode: string;
}

const QUALITY_COLORS: Record<string, string> = {
  good: "#00ff00",
  degraded: "#ffff00",
  poor: "#ff4444",
};

export class DebugOverlay {
  private el: HTMLDivElement;
  private visible = true;
  private lastHTML = "";
  private readonly keyboardToggle: string;
  private readonly handleKey: (e: KeyboardEvent) => void;

  constructor(options?: DebugOverlayOptions) {
    const opts = options ?? {};
    this.keyboardToggle = opts.keyboardToggle ?? "F3";

    /* ---- create container ---- */
    this.el = document.createElement("div");

    const pos = opts.position ?? "top-right";
    const posStyles = this.positionStyles(pos);

    Object.assign(this.el.style, {
      position: "fixed",
      ...posStyles,
      background: "rgba(0,0,0,0.75)",
      color: "#00ff00",
      fontFamily: "'Courier New', monospace",
      fontSize: "11px",
      padding: "8px",
      borderRadius: "4px",
      zIndex: "99999",
      pointerEvents: "none",
      whiteSpace: "pre",
      lineHeight: "1.4",
      minWidth: "200px",
      boxSizing: "border-box",
    } as CSSStyleDeclaration);

    document.body.appendChild(this.el);

    /* ---- keyboard listener ---- */
    this.handleKey = (e: KeyboardEvent) => {
      if (e.key === this.keyboardToggle) {
        e.preventDefault();
        this.toggle();
      }
    };
    window.addEventListener("keydown", this.handleKey);
  }

  /* ---- public API ---- */

  update(stats: DebugStats): void {
    if (!this.visible) return;

    const latencyDisplay = this.formatLatency(stats.latencyMs);
    const qualityColor = QUALITY_COLORS[stats.networkQuality] ?? "#00ff00";
    const bwIn = (stats.bandwidthIn / 1024).toFixed(1);
    const bwOut = (stats.bandwidthOut / 1024).toFixed(1);
    const loss = (stats.packetLossRate * 100).toFixed(1);

    const html =
      `<b style="color:#00ccff">== NET DEBUG ==</b>\n` +
      `tick       ${stats.tick}\n` +
      `srv tick   ${stats.serverTick}\n` +
      `drift      ${stats.drift}\n` +
      `latency    ${latencyDisplay} ms\n` +
      `loss       ${loss}%\n` +
      `bw in      ${bwIn} KB/s\n` +
      `bw out     ${bwOut} KB/s\n` +
      `quality    <span style="color:${qualityColor}">${stats.networkQuality}</span>\n` +
      `peers      ${stats.peerCount}\n` +
      `host       ${stats.isHost ? "YES" : "NO"}\n` +
      `sync       ${stats.syncMode}`;

    /* Only touch the DOM when something changed */
    if (html !== this.lastHTML) {
      this.el.innerHTML = html;
      this.lastHTML = html;
    }
  }

  show(): void {
    this.visible = true;
    this.el.style.display = "block";
  }

  hide(): void {
    this.visible = false;
    this.el.style.display = "none";
  }

  toggle(): void {
    if (this.visible) {
      this.hide();
    } else {
      this.show();
    }
  }

  destroy(): void {
    window.removeEventListener("keydown", this.handleKey);
    this.el.remove();
  }

  /* ---- helpers ---- */

  private positionStyles(
    pos: "top-left" | "top-right" | "bottom-left" | "bottom-right",
  ): Record<string, string> {
    switch (pos) {
      case "top-left":
        return { top: "8px", left: "8px" };
      case "top-right":
        return { top: "8px", right: "8px" };
      case "bottom-left":
        return { bottom: "8px", left: "8px" };
      case "bottom-right":
        return { bottom: "8px", right: "8px" };
    }
  }

  private formatLatency(latency: Map<string, number> | number): string {
    if (typeof latency === "number") {
      return latency.toFixed(1);
    }
    if (latency.size === 0) return "—";
    let sum = 0;
    latency.forEach((v) => (sum += v));
    return (sum / latency.size).toFixed(1);
  }
}
