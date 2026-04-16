import { useState, useEffect, type ReactNode, type CSSProperties } from "react";
import type { LoadingProgress } from "../types";

// ── Props ─────────────────────────────────────────────────────────────────────

export interface LoadingScreenProps {
  /** Loading progress data (from AssetLoader render prop) */
  progress: LoadingProgress;
  /**
   * Visual theme preset.
   * - "default": Minimal progress bar with percentage
   * - "gaming": Animated bar with tips, asset names, count
   * - "minimal": Spinner and percentage
   * - "custom": No default UI, renders children only
   * Default: "default"
   */
  theme?: "default" | "gaming" | "minimal" | "custom";
  /** Background color or CSS background value. Default: "#000000" */
  background?: string;
  /** Accent color for the progress bar. Default: "#6366f1" */
  accentColor?: string;
  /** Game logo URL or React element displayed above the progress bar. */
  logo?: string | ReactNode;
  /** Array of loading tips to cycle through (gaming theme). */
  tips?: string[];
  /** Interval in ms to cycle tips. Default: 5000. */
  tipInterval?: number;
  /** Whether to show the current asset being loaded. Default: true. */
  showCurrentAsset?: boolean;
  /** Whether to show loaded/total count. Default: true. */
  showCount?: boolean;
  /** Custom render function for complete control over loading UI. */
  children?: (progress: LoadingProgress) => ReactNode;
}

// ── Styles ────────────────────────────────────────────────────────────────────

const S: Record<string, CSSProperties> = {
  root: {
    position: "absolute",
    inset: 0,
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    fontFamily: "system-ui, -apple-system, sans-serif",
    color: "#e0e0e0",
  },
  logo: {
    marginBottom: 32,
    maxWidth: 200,
    maxHeight: 80,
  },
  barTrack: {
    width: 300,
    height: 6,
    background: "rgba(255,255,255,0.15)",
    borderRadius: 3,
    overflow: "hidden",
  },
  barFill: {
    height: "100%",
    borderRadius: 3,
    transition: "width 0.3s ease",
  },
  pct: {
    marginTop: 12,
    fontSize: 14,
    opacity: 0.8,
  },
  asset: {
    marginTop: 8,
    fontSize: 12,
    opacity: 0.5,
    maxWidth: 300,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  count: {
    marginTop: 4,
    fontSize: 12,
    opacity: 0.4,
  },
  tip: {
    marginTop: 24,
    fontSize: 13,
    opacity: 0.6,
    maxWidth: 400,
    textAlign: "center",
    minHeight: 40,
    transition: "opacity 0.4s ease",
  },
  spinner: {
    width: 32,
    height: 32,
    border: "3px solid rgba(255,255,255,0.2)",
    borderRadius: "50%",
    marginBottom: 16,
    animation: "carverjs-spin 0.8s linear infinite",
  },
};

// ── CSS keyframes (injected once) ─────────────────────────────────────────────

let _injected = false;

function injectKeyframes(): void {
  if (_injected || typeof document === "undefined") return;
  _injected = true;
  const style = document.createElement("style");
  style.textContent = `@keyframes carverjs-spin{to{transform:rotate(360deg)}}`;
  document.head.appendChild(style);
}

// ── Component ─────────────────────────────────────────────────────────────────

/**
 * Pre-built, customizable loading screen. Renders as HTML content
 * within the AssetLoader's fallback slot.
 *
 * Usage:
 *   <AssetLoader
 *     manifest={manifest}
 *     fallback={(p) => <LoadingScreen progress={p} theme="gaming" tips={tips} />}
 *   >
 *     {children}
 *   </AssetLoader>
 */
export function LoadingScreen({
  progress,
  theme = "default",
  background = "#000000",
  accentColor = "#6366f1",
  logo,
  tips,
  tipInterval = 5000,
  showCurrentAsset = true,
  showCount = true,
  children,
}: LoadingScreenProps) {
  injectKeyframes();

  // ── Tip cycling ──
  const [tipIndex, setTipIndex] = useState(0);

  useEffect(() => {
    if (!tips || tips.length <= 1) return;
    const id = setInterval(() => {
      setTipIndex((i) => (i + 1) % tips!.length);
    }, tipInterval);
    return () => clearInterval(id);
  }, [tips, tipInterval]);

  // ── Custom render ──
  if (theme === "custom" && children) {
    return (
      <div style={{ ...S.root, background }}>
        {children(progress)}
      </div>
    );
  }

  const pct = Math.round(progress.progress * 100);
  const barWidth = `${progress.progress * 100}%`;

  // ── Logo ──
  const logoEl = logo ? (
    typeof logo === "string" ? (
      <img src={logo} alt="" style={S.logo} />
    ) : (
      <div style={S.logo}>{logo}</div>
    )
  ) : null;

  // ── Minimal theme: spinner + percentage ──
  if (theme === "minimal") {
    return (
      <div style={{ ...S.root, background }}>
        <div style={{ ...S.spinner, borderTopColor: accentColor }} />
        <div style={S.pct}>{pct}%</div>
      </div>
    );
  }

  // ── Default and Gaming themes ──
  const isGaming = theme === "gaming";

  return (
    <div style={{ ...S.root, background }}>
      {logoEl}

      {/* Progress bar */}
      <div
        style={{
          ...S.barTrack,
          ...(isGaming ? { width: 400, height: 8 } : {}),
        }}
      >
        <div
          style={{
            ...S.barFill,
            width: barWidth,
            background: accentColor,
          }}
        />
      </div>

      {/* Percentage */}
      <div style={S.pct}>{pct}%</div>

      {/* Current asset name */}
      {showCurrentAsset && progress.currentAsset && (
        <div style={S.asset}>Loading {progress.currentAsset}...</div>
      )}

      {/* Loaded count */}
      {showCount && progress.total > 0 && (
        <div style={S.count}>
          {progress.loaded}/{progress.total}
        </div>
      )}

      {/* Tips (gaming theme only) */}
      {isGaming && tips && tips.length > 0 && (
        <div style={S.tip}>{tips[tipIndex]}</div>
      )}

      {/* Errors */}
      {progress.errors.length > 0 && (
        <div style={{ ...S.count, color: "#ef4444", marginTop: 12 }}>
          {progress.errors.length} asset(s) failed to load
        </div>
      )}
    </div>
  );
}
