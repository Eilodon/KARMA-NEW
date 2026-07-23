/**
 * Casper-track variant of shoot-explorer.mjs — screenshots testnet.cspr.live instead of
 * pharosscan. Casper's explorer URL convention differs from an EVM one: deploys are
 * /deploy/<hash>, contract packages are /contract-package/<hash-without-"hash-"-prefix>.
 * Best-effort, never fatal — same posture as the original.
 *
 *   EXPLORER=... DEMO_JSON_FILE=... SHOTS_DIR=... CONTRACT=... node shoot_explorer_casper.mjs
 */
import fs from "node:fs";
import path from "node:path";
import puppeteer from "puppeteer-core";

const CHROME = process.env.CHROME || "/usr/bin/google-chrome";
const EXPLORER = (process.env.EXPLORER || "https://testnet.cspr.live").replace(/\/+$/, "");
const SHOTS_DIR = process.env.SHOTS_DIR || "demo-video/out_casper/shots";
const DEMO_JSON_FILE = process.env.DEMO_JSON_FILE || "demo-video/out_casper/demo_json.json";

function loadManifest() {
  try {
    const j = JSON.parse(fs.readFileSync(DEMO_JSON_FILE, "utf8"));
    if (j && Array.isArray(j.txs) && j.txs.length) return j;
  } catch { /* fall through */ }
  console.log(`[shoot] no demo_json.json — nothing to screenshot`);
  return { contract: process.env.CONTRACT || "", txs: [] };
}

async function shoot(page, url, outfile) {
  console.log(`[shoot] ${url}`);
  try {
    await page.goto(url, { waitUntil: "networkidle2", timeout: 45000 });
  } catch {
    try { await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 }); }
    catch (e) { console.log(`[shoot]   nav failed: ${e.message}`); return false; }
  }
  await new Promise((r) => setTimeout(r, 2500));
  await page.screenshot({ path: outfile });
  console.log(`[shoot]   -> ${outfile}`);
  return true;
}

async function main() {
  fs.mkdirSync(SHOTS_DIR, { recursive: true });
  const m = loadManifest();
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: "new",
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--hide-scrollbars"],
  });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 1024, deviceScaleFactor: 2 });

    const headline = m.txs.find((t) => t.label === "arbitrate") || m.txs[m.txs.length - 1];
    if (headline) await shoot(page, `${EXPLORER}/deploy/${headline.hash}`, path.join(SHOTS_DIR, "tx.png"));
    const contractHex = (m.contract || "").replace(/^hash-/, "");
    if (contractHex) await shoot(page, `${EXPLORER}/contract-package/${contractHex}`, path.join(SHOTS_DIR, "contract.png"));
  } finally {
    await browser.close();
  }
}

main().catch((e) => { console.error("[shoot] FAIL:", e.message); process.exit(0); });
