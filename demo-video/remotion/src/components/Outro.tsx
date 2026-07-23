import React from "react";
import { AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";
import { theme } from "../theme";

const Feature: React.FC<{ text: string; delay: number }> = ({ text, delay }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const s = spring({ frame: frame - delay, fps, config: { damping: 200 }, durationInFrames: 16 });
  return (
    <div
      style={{
        opacity: interpolate(s, [0, 1], [0, 1]),
        transform: `translateX(${interpolate(s, [0, 1], [-30, 0])}px)`,
        display: "flex",
        alignItems: "center",
        gap: 14,
        fontSize: 32,
        color: theme.text,
        fontFamily: theme.sans,
      }}
    >
      <span style={{ color: theme.green, fontFamily: theme.mono }}>✓</span> {text}
    </div>
  );
};

export const Outro: React.FC<{
  contract: string;
  explorer: string;
  features?: string[];
  builtOnLine?: string;
  repoLine?: string;
}> = ({
  contract,
  features = [
    "Verifiable DID identity — SIWE / EIP-191",
    "TEE-signed, bounded, revocable delegation",
    "Dual-layer trust — identity + on-chain reputation",
    "8 T3N tools · ~23 SDK surfaces · 457 tests green",
  ],
  builtOnLine = "Built on Terminal3 · verifiable on-chain",
  repoLine = "github.com/Eilodon/KARMA · @terminal3/t3n-sdk",
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const a = spring({ frame, fps, config: { damping: 200 }, durationInFrames: 22 });

  return (
    <AbsoluteFill
      style={{
        background: `radial-gradient(1400px 800px at 50% 45%, #15122b 0%, ${theme.bg} 65%)`,
        justifyContent: "center",
        alignItems: "center",
        fontFamily: theme.sans,
      }}
    >
      <div
        style={{
          fontSize: 120,
          fontWeight: 900,
          letterSpacing: 8,
          color: theme.text,
          opacity: interpolate(a, [0, 1], [0, 1]),
          transform: `translateY(${interpolate(a, [0, 1], [30, 0])}px)`,
          textShadow: `0 0 50px ${theme.accent}`,
        }}
      >
        KARMA
      </div>

      <div style={{ marginTop: 36, display: "flex", flexDirection: "column", gap: 16 }}>
        {features.map((text, i) => (
          <Feature key={text} text={text} delay={8 + i * 8} />
        ))}
      </div>

      <div
        style={{
          marginTop: 48,
          fontFamily: theme.mono,
          fontSize: 26,
          color: theme.cyan,
          opacity: interpolate(spring({ frame: frame - 40, fps, durationInFrames: 16 }), [0, 1], [0, 1]),
          textAlign: "center",
        }}
      >
        <div style={{ color: theme.dim, fontSize: 22, marginBottom: 8 }}>{builtOnLine}</div>
        {contract}
        <div style={{ color: theme.dim, fontSize: 22, marginTop: 8 }}>{repoLine}</div>
      </div>

      <div
        style={{
          marginTop: 44,
          fontSize: 34,
          color: theme.accent,
          fontWeight: 700,
          letterSpacing: 2,
          opacity: interpolate(spring({ frame: frame - 50, fps, durationInFrames: 16 }), [0, 1], [0, 1]),
        }}
      >
        Prove it, don&apos;t tell it.
      </div>
    </AbsoluteFill>
  );
};
