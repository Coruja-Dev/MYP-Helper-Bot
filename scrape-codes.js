import { chromium } from "playwright-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import fs from "fs";

chromium.use(StealthPlugin());

// ─── Config ───────────────────────────────────────────────────────────────────

const INPUT_CSV     = "cards.csv";
const OUTPUT_CSV    = "cards-with-codes.csv";
const PROGRESS_FILE = "codes-progress.json";
const COOKIES_FILE  = "cookies.json";

const MAX_RETRIES = 4;
const BASE_DELAY  = 6000;
const JITTER      = 14000; // 6–20s between cards

// ─── Helpers ──────────────────────────────────────────────────────────────────

function randomDelay() {
  return BASE_DELAY + Math.random() * JITTER;
}

function escapeCSV(val) {
  return `"${String(val ?? "").replace(/"/g, '""')}"`;
}

// ─── Progress ─────────────────────────────────────────────────────────────────

function loadProgress() {
  if (!fs.existsSync(PROGRESS_FILE)) return new Set();
  try {
    return new Set(JSON.parse(fs.readFileSync(PROGRESS_FILE, "utf-8")).done ?? []);
  } catch { return new Set(); }
}

function saveProgress(done) {
  fs.writeFileSync(PROGRESS_FILE, JSON.stringify({ done: [...done] }, null, 2));
}

// ─── CSV ──────────────────────────────────────────────────────────────────────

function readInputCards() {
  if (!fs.existsSync(INPUT_CSV)) {
    console.error(`Input file "${INPUT_CSV}" not found.`);
    process.exit(1);
  }
  const lines = fs.readFileSync(INPUT_CSV, "utf-8").trim().split("\n");
  return lines.slice(1).map((line) => {
    const match = line.match(/^"((?:[^"]|"")*)","((?:[^"]|"")*)"$/);
    if (!match) return null;
    return {
      card_name: match[1].replace(/""/g, '"'),
      offer_url: match[2].replace(/""/g, '"'),
    };
  }).filter(Boolean);
}

function initOutputCSV() {
  if (!fs.existsSync(OUTPUT_CSV)) {
    fs.writeFileSync(OUTPUT_CSV, "card_code,card_name,offer_url\n", "utf-8");
  }
}

function appendRow(code, card_name, offer_url) {
  fs.appendFileSync(
    OUTPUT_CSV,
    `${escapeCSV(code)},${escapeCSV(card_name)},${escapeCSV(offer_url)}\n`,
    "utf-8"
  );
}

// ─── Cookies ──────────────────────────────────────────────────────────────────

function loadCookies() {
  const raw = JSON.parse(fs.readFileSync(COOKIES_FILE, "utf-8"));
  return raw.map((c) => ({
    name:     c.name,
    value:    c.value,
    domain:   c.domain,
    path:     c.path ?? "/",
    expires:  c.expirationDate ?? -1,
    httpOnly: c.httpOnly ?? false,
    secure:   c.secure ?? false,
    sameSite: c.sameSite === "no_restriction" ? "None"
            : c.sameSite === "strict"         ? "Strict"
            :                                   "Lax",
  }));
}

// ─── Scraping ─────────────────────────────────────────────────────────────────

async function isRealPage(page) {
  let content = "";
  try { content = await page.content(); } catch {}
  if (content.includes("Just a moment")) return false;
  if (content.includes("cf-error-code"))  return false;
  if (!content.includes("mypcards"))      return false;
  return true;
}

async function scrapeCode(page, url) {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });

      let realPage = false;
      for (let i = 0; i < 15; i++) {
        if (await isRealPage(page)) { realPage = true; break; }
        console.log(`    Cloudflare detected (attempt ${attempt}, poll ${i + 1}/15)...`);
        await page.waitForTimeout(4000);
      }

      if (!realPage) {
        console.warn(`    Still blocked. Attempt ${attempt}/${MAX_RETRIES}.`);
        await page.waitForTimeout(15000);
        continue;
      }

      // Find the Código field — label + sibling text
      const rawCode = await page.evaluate(() => {
        const labels = Array.from(document.querySelectorAll(".view-field label"));
        const codigoLabel = labels.find((l) => l.innerText.trim() === "Código");
        if (!codigoLabel) return null;
        // The code is the text node after the label inside the same .view-field div
        const field = codigoLabel.closest(".view-field");
        if (!field) return null;
        return field.innerText.replace("Código", "").trim();
      });

      if (!rawCode) {
        console.warn(`    Code not found on page.`);
        return null;
      }

      // Strip "yugioh_" prefix → "ra05-en027"
      const code = rawCode.replace(/^yugioh_/i, "");
      return code;

    } catch (err) {
      console.warn(`    Attempt ${attempt} failed: ${err.message}`);
      if (attempt < MAX_RETRIES) await page.waitForTimeout(8000);
    }
  }

  return null;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const cards = readInputCards();
  const done  = loadProgress();
  initOutputCSV();

  console.log(`Total cards: ${cards.length}. Already done: ${done.size}.`);

  const browser = await chromium.launch({
    headless: false,
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--start-minimized"],
  });

  const context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
      "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    extraHTTPHeaders: {
      "Accept-Language": "pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7",
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
      "Referer": "https://mypcards.com/",
    },
  });

  await context.addCookies(loadCookies());

  const page = await context.newPage();

  // Warm up
  console.log("Warming up — visiting homepage...");
  await page.goto("https://mypcards.com/yugioh", { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(8000 + Math.random() * 7000);
  console.log("Warm-up done. Starting.\n");

  for (let i = 0; i < cards.length; i++) {
    const { card_name, offer_url } = cards[i];

    if (done.has(offer_url)) {
      console.log(`[${i + 1}/${cards.length}] SKIP: ${card_name}`);
      continue;
    }

    console.log(`[${i + 1}/${cards.length}] ${card_name}`);

    const code = await scrapeCode(page, offer_url);

    if (code === null) {
      console.warn(`  Could not retrieve code — will retry next run.`);
      const pause = randomDelay();
      await page.waitForTimeout(pause);
      continue;
    }

    console.log(`  Code: ${code}`);
    appendRow(code, card_name, offer_url);

    done.add(offer_url);
    saveProgress(done);

    const pause = randomDelay();
    console.log(`  Next in ${(pause / 1000).toFixed(1)}s...`);
    await page.waitForTimeout(pause);
  }

  await browser.close();
  console.log(`\nDone. Results in ${OUTPUT_CSV}`);
}

main();