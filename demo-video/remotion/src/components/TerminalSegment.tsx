import React from "react";
import {
  AbsoluteFill,
  Img,
  OffthreadVideo,
  Sequence,
  staticFile,
  useCurrentFrame,
} from "remotion";
import { theme } from "../theme";
import manifest from "../manifest.json";
import type { Segment, Tx } from "../KarmaDemo";
import { TerminalWindow } from "./TerminalWindow";
import { LowerThird } from "./LowerThird";
import { ChapterPill } from "./ChapterPill";
import { TxPanel } from "./TxPanel";

const CHAPTERS = (manifest.segments as unknown as Segment[]).filter((s) => s.chapter);
const chapterPos = (id: string): [number, number] => {
  const i = CHAPTERS.findIndex((s) => s.id === id);
  return [i + 1, CHAPTERS.length];
};

const titleFor = (id: string): string => {
  const map: Record<string, string> = {
    discover: "agent ~ pnpm demo:discover",
    "trust-gate": "agent ~ pnpm demo:trust-gate",
    demo: "agent ~ pnpm demo",
    verify: "agent ~ pnpm demo:verify",
    flagship: "karma ~ t3_demo_capture  ·  Terminal3 testnet",
    economy: "karma ~ pnpm demo  ·  Pharos Atlantic",
    depth: "karma ~ pnpm demo:discover",
    lifecycle: "karma ~ demo_casper_full_job_lifecycle.ts",
    courtroom: "karma ~ demo_casper_courtroom.ts",
    governance: "karma ~ demo_casper_cross_chain_rep_governance.ts",
  };
  return map[id] ?? `agent ~ ${id}`;
};

const PlaceholderTerminal: React.FC<{ id: string }> = ({ id }) => (
  <div
    style={{
      height: 900,
      display: "flex",
      flexDirection: "column",
      justifyContent: "center",
      padding: "0 60px",
      fontFamily: theme.mono,
      color: theme.dim,
      fontSize: 30,
    }}
  >
    <div style={{ color: theme.green }}>$ {titleFor(id).replace("agent ~ ", "")}</div>
    <div style={{ marginTop: 18, color: theme.yellow }}>
      ◐ live capture pending — run demo-video/build.sh with KEYSTORE_PASSWORD set
    </div>
  </div>
);

export const TerminalSegment: React.FC<{ seg: Segment; txs: Tx[]; explorer: string; chainLabel?: string }> = ({
  seg,
  txs,
  explorer,
  chainLabel,
}) => {
  const frame = useCurrentFrame();
  const [idx, total] = chapterPos(seg.id);
  const WIN_W = 1380;
  // If narration is much longer than the clip, stretch playback to fill (slow, readable scroll)
  // instead of a long static freeze. Very short clips still play 1x then freeze their last frame.
  const stretch = seg.clip ? seg.clipFrames / seg.durationInFrames : 1;
  const useStretch = Boolean(seg.clip) && stretch >= 0.35 && stretch < 0.95;

  return (
    <AbsoluteFill
      style={{
        background: `radial-gradient(1200px 700px at 50% 30%, ${theme.bg2} 0%, ${theme.bg} 70%)`,
        justifyContent: "center",
        alignItems: "center",
      }}
    >
      <div style={{ marginTop: -40 }}>
        <TerminalWindow title={titleFor(seg.id)} width={WIN_W}>
          {seg.clip ? (
            useStretch ? (
              <OffthreadVideo
                src={staticFile(seg.clip)}
                playbackRate={stretch}
                style={{ width: WIN_W, display: "block" }}
              />
            ) : frame < seg.clipFrames ? (
              <OffthreadVideo
                src={staticFile(seg.clip)}
                style={{ width: WIN_W, display: "block" }}
              />
            ) : seg.last ? (
              <Img src={staticFile(seg.last)} style={{ width: WIN_W, display: "block" }} />
            ) : null
          ) : (
            <PlaceholderTerminal id={seg.id} />
          )}
        </TerminalWindow>
      </div>

      <ChapterPill label={seg.chapter} index={idx} total={total} />

      <Sequence from={12} name="lower-third">
        <LowerThird text={seg.proof} />
      </Sequence>

      {seg.showTxs ? (
        // Reveal the real on-chain hash summary partway through, kept on screen to the end.
        <Sequence from={Math.round(seg.durationInFrames * 0.45)} name="tx-panel">
          <TxPanel txs={txs} explorer={explorer} chainLabel={chainLabel} />
        </Sequence>
      ) : null}
    </AbsoluteFill>
  );
};
