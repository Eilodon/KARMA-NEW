/**
 * Extract "tx: <hash>" lines (with the preceding step label) from the Casper .cast captures,
 * writing out_casper/demo_json.json in the same shape the original Pharos record.sh's
 * DEMO_JSON extraction produced — { contract, txs: [{label, hash}, ...] } — so manifest_casper.mjs
 * can feed real hashes into the TxPanel overlay without the scripts needing a special print format.
 *
 *   node demo-video/extract_casper_txs.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const DV = path.dirname(new URL(import.meta.url).pathname);
const CAST_DIR = path.join(DV, "out_casper", "cast");
const ASCIINEMA = path.join(DV, ".venv", "bin", "asciinema");
const OUT_FILE = path.join(DV, "out_casper", "demo_json.json");

function stripAnsi(s) {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

function extractFromCast(castPath) {
  const raw = execFileSync(ASCIINEMA, ["cat", castPath], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const text = stripAnsi(raw);
  const lines = text.split(/\r?\n/);
  const pairs = [];
  let lastLabel = null;
  const stepRe = /^\s*(?:\d+\.\s*)?([a-z_]+)\s*\(/i;
  const stepRe2 = /^\d+\.\s*([a-z_]+)/i;
  // governance script's specific phrasing (no leading "N. label(" step markers)
  const govRe = /^(proposing|approving|attempting execute)/i;
  const govLabel = { proposing: "propose", approving: "approve", "attempting execute": "execute_attempt" };
  const txRe = /^\s*tx:\s*([0-9a-f]{60,70})\s*$/i;
  const txRe2 = /^\s*(?:submitted\.\s*)?tx hash:\s*([0-9a-f]{60,70})\s*$/i;
  for (const line of lines) {
    const m1 = line.match(stepRe) || line.match(stepRe2);
    if (m1) lastLabel = m1[1];
    const mg = line.match(govRe);
    if (mg) lastLabel = govLabel[mg[1].toLowerCase()] ?? mg[1];
    const m2 = line.match(txRe) || line.match(txRe2);
    if (m2 && lastLabel) {
      pairs.push({ label: lastLabel, hash: m2[1] });
      lastLabel = null;
    }
  }
  return pairs;
}

const segments = ["lifecycle", "courtroom", "governance"];
let allTxs = [];
for (const seg of segments) {
  const castPath = path.join(CAST_DIR, `${seg}.cast`);
  if (!fs.existsSync(castPath)) {
    console.log(`[extract] no cast for ${seg}, skipping`);
    continue;
  }
  const pairs = extractFromCast(castPath);
  console.log(`[extract] ${seg}: ${pairs.length} tx found`);
  for (const p of pairs) console.log(`    ${p.label} -> ${p.hash}`);
  allTxs = allTxs.concat(pairs);
}

const contract = process.env.CASPER_CONTRACT_HASH || "";
fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
fs.writeFileSync(OUT_FILE, JSON.stringify({ contract, txs: allTxs }, null, 2));
console.log(`[extract] wrote ${allTxs.length} txs -> ${OUT_FILE}`);
