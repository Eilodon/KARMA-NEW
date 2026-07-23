/**
 * Casper-track variant of manifest.mjs — same Remotion manifest-building logic, different
 * editorial structure (courtroom/lifecycle/governance instead of Terminal3/Pharos escrow) and
 * chain facts (Casper testnet.cspr.live, no wei-budget dependency). Writes to the SAME
 * remotion/src/manifest.json the Pharos build writes to — that file is a regenerable build
 * artifact, not a source file; re-running demo-video/build.sh from the untouched Pharos
 * manifest.mjs regenerates the original any time.
 *
 *   OUT=... REMOTION=... EXPLORER=... CONTRACT=... node demo-video/manifest_casper.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const OUT = process.env.OUT || "demo-video/out_casper";
const REMOTION = process.env.REMOTION || "demo-video/remotion";
const EXPLORER = (process.env.EXPLORER || "https://testnet.cspr.live").replace(/\/+$/, "");
const FPS = Number(process.env.FPS || 30);
const PAD = 0.4;
const MIN_TERMINAL = 6;

const PUBLIC = path.join(REMOTION, "public");
for (const d of ["clips", "audio", "shots"]) fs.mkdirSync(path.join(PUBLIC, d), { recursive: true });

const exists = (p) => { try { fs.accessSync(p); return true; } catch { return false; } };
const probe = (p) => {
  try {
    return parseFloat(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", p], { encoding: "utf8" }).trim()) || 0;
  } catch { return 0; }
};
const copy = (src, rel) => { if (exists(src)) { fs.copyFileSync(src, path.join(PUBLIC, rel)); return rel; } return null; };

// editorial structure: the "9 institutions" story, told through 3 real live flows.
const SEGMENTS = [
  { id: "title", kind: "title", chapter: "", proof: "" },
  { id: "lifecycle", kind: "terminal", chapter: "The economic loop", proof: "register → bond → escrow → deliver → confirm → withdraw — 6 real tx", showTxs: true },
  { id: "courtroom", kind: "terminal", chapter: "The courtroom, for real", proof: "dispute → respond → arbitrate — reputation slashed 50→40, live" },
  { id: "governance", kind: "terminal", chapter: "Reputation travels", proof: "propose → approve — a real 48h timelock, not a claim" },
  { id: "explorer", kind: "shot", chapter: "Receipts", proof: "Every Casper transaction is verifiable on Testnet" },
  { id: "outro", kind: "outro", chapter: "", proof: "" },
];

const narration = exists(path.join(OUT, "narration.json"))
  ? JSON.parse(fs.readFileSync(path.join(OUT, "narration.json"), "utf8"))
  : { blocks: {} };

let txs = [], contract = process.env.CONTRACT || "";
if (exists(path.join(OUT, "demo_json.json"))) {
  try { const j = JSON.parse(fs.readFileSync(path.join(OUT, "demo_json.json"), "utf8")); txs = j.txs || []; contract = j.contract || contract; } catch {}
}

const segments = [];
for (const s of SEGMENTS) {
  const nb = narration.blocks?.[s.id];
  const narr = nb ? { src: copy(path.join(OUT, "audio", path.basename(nb.file)), `audio/${s.id}.mp3`), duration: nb.duration } : null;
  let clip = null, clipDuration = 0, last = null;
  if (s.kind === "terminal") {
    const mp4 = path.join(OUT, "clips", `${s.id}.mp4`);
    if (exists(mp4)) { clip = copy(mp4, `clips/${s.id}.mp4`); clipDuration = probe(mp4); last = copy(path.join(OUT, "clips", `${s.id}.last.png`), `clips/${s.id}.last.png`); }
  }
  let shot = null;
  if (s.kind === "shot") shot = copy(path.join(OUT, "shots", "tx.png"), "shots/tx.png");
  const contractShot = s.kind === "outro" ? copy(path.join(OUT, "shots", "contract.png"), "shots/contract.png") : null;

  const base = Math.max(clipDuration, narr?.duration || 0, s.kind === "terminal" || s.kind === "shot" ? MIN_TERMINAL : 3);
  const durationInFrames = Math.round((base + PAD) * FPS);
  segments.push({ ...s, narr, clip, clipDuration, clipFrames: Math.round(clipDuration * FPS), last, shot, contractShot, durationInFrames });
}

const manifest = {
  fps: FPS,
  width: 1920,
  height: 1080,
  explorer: EXPLORER,
  contract,
  txs,
  segments,
  chainLabel: "Casper Testnet",
  title: "KARMA",
  subtitle: "A trust and settlement protocol for the agent economy — not a single-chain app",
  liveTag: "● LIVE · Casper Testnet, governance-hardened",
  tagline: "Prove it, don't tell it.",
  outroFeatures: [
    "Full job lifecycle — 6 real tx, reputation earned",
    "The courtroom, for real — dispute, arbitrate, reputation slashed",
    "Reputation travels — governed cross-chain rep, real 48h timelock",
    "120/120 Odra contract tests · 25 MCP tools · governance-hardened",
  ],
  outroBuiltOnLine: "A protocol, not a single chain — verifiable on-chain",
  outroRepoLine: "github.com/Eilodon/KARMA · docs/standards/IPaymentPlugin-v1.md",
};
fs.mkdirSync(path.join(REMOTION, "src"), { recursive: true });
fs.writeFileSync(path.join(REMOTION, "src", "manifest.json"), JSON.stringify(manifest, null, 2));

const total = segments.reduce((a, s) => a + s.durationInFrames, 0);
console.log(`manifest: ${segments.length} segments, ${total} frames = ${(total / FPS).toFixed(1)}s`);
for (const s of segments) console.log(`  ${s.id.padEnd(11)} ${(s.durationInFrames / FPS).toFixed(1)}s  clip=${s.clip ? "yes" : "—"} narr=${s.narr?.src ? "yes" : "—"}`);
