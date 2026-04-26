import { chromium } from "playwright-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import fs from "fs";

chromium.use(StealthPlugin());

// ─── Config ───────────────────────────────────────────────────────────────────

const INPUT_CSV     = "cards.csv";
const OUTPUT_CSV    = "offers.csv";
const PROGRESS_FILE = "offers-progress.json";
const COOKIES_FILE  = "cookies.json";

// Resume from this URL (the one you stopped at). Set to null to start from
// the beginning, or to a specific offer_url to resume from that card onward.
const RESUME_FROM_URL = "https://mypcards.com/yugioh/produto/320822/trap-dustshoot";

const MAX_RETRIES  = 4;
const BASE_DELAY   = 8000;   // minimum ms between requests
const JITTER       = 22000;  // adds up to 22s on top → total range: 8–30s

// Delay between paginated sub-pages within a single card (shorter)
const PAGE_BASE_DELAY  = 3000;
const PAGE_JITTER      = 7000; // 3–10s between sub-pages

// ─── Helpers ──────────────────────────────────────────────────────────────────

function randomDelay(base = BASE_DELAY, jitter = JITTER) {
  return base + Math.random() * jitter;
}

function escapeCSV(val) {
  return `"${String(val ?? "").replace(/"/g, '""')}"`;
}

/**
 * Parse "R$ 1.234,56" → 1234.56  (Brazilian locale)
 */
function parseBRL(raw) {
  return parseFloat(
    raw
      .replace(/R\$\s*/g, "")
      .trim()
      .replace(/\./g, "")
      .replace(",", ".")
  );
}

// ─── Progress ─────────────────────────────────────────────────────────────────

function loadProgress() {
  if (!fs.existsSync(PROGRESS_FILE)) return new Set();
  try {
    const data = JSON.parse(fs.readFileSync(PROGRESS_FILE, "utf-8"));
    return new Set(data.done ?? []);
  } catch {
    return new Set();
  }
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
    fs.writeFileSync(
      OUTPUT_CSV,
      "card_name,offer_url,rarity,lowest,highest,average,offer_count\n",
      "utf-8"
    );
  }
}

function appendResults(rows) {
  const lines = rows.map((r) =>
    [
      escapeCSV(r.card_name),
      escapeCSV(r.offer_url),
      escapeCSV(r.rarity),
      escapeCSV(r.lowest.toFixed(2)),
      escapeCSV(r.highest.toFixed(2)),
      escapeCSV(r.average.toFixed(2)),
      escapeCSV(r.offer_count),
    ].join(",")
  );
  fs.appendFileSync(OUTPUT_CSV, lines.join("\n") + "\n", "utf-8");
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

/**
 * Returns true if the current page looks like a real mypcards page.
 * Cloudflare block/challenge pages won't contain the site's nav structure.
 */
async function isRealPage(page) {
  let content = "";
  try { content = await page.content(); } catch {}
  if (content.includes("Just a moment"))  return false;
  if (content.includes("cf-error-code"))  return false;
  if (!content.includes("mypcards"))      return false;
  return true;
}

/**
 * Parse offer rows from a specific section of the currently loaded page.
 * sectionId: "lista-anuncio-lojistas-certificados" | "lista-anuncio-demais-vendedores"
 */
async function parseSection(page, sectionId) {
  return page.$$eval(`#${sectionId} tbody tr[data-key]`, (trs) =>
    trs.map((tr) => {
      const rarityCell = tr.querySelector(".estoque-lista-nomeenfoil");
      const priceCell  = tr.querySelector(".estoque-lista-precoestoque .moeda");
      if (!rarityCell || !priceCell) return null;
      const rarity   = rarityCell.innerText.trim().split(",")[0].trim();
      const priceRaw = priceCell.innerText.trim();
      return { rarity, priceRaw };
    }).filter(Boolean)
  );
}

/**
 * Check if a section has a next page link.
 */
async function sectionHasNext(page, sectionId) {
  return page.evaluate((sid) => {
    const section = document.getElementById(sid);
    if (!section) return false;
    return section.querySelectorAll(".pagination li.next a").length > 0;
  }, sectionId);
}

/**
 * Navigate to a URL with retry + Cloudflare wait.
 * Returns true on success, false if still blocked after all retries.
 */
async function loadPage(page, url) {
  console.log(`    Loading: ${url}`);

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

      return true;
    } catch (err) {
      console.warn(`    Attempt ${attempt} failed: ${err.message}`);
      if (attempt < MAX_RETRIES) await page.waitForTimeout(8000);
    }
  }

  return false;
}

/**
 * Scrape all offers for a card.
 * - Regular sellers (demais-vendedores): scraped once from the base URL, no pagination.
 * - Certified sellers (lojistas-certificados): paginated via estoque-cert-page param.
 */
async function scrapeCard(page, offerUrl) {
  // Load the base page once to get the regular sellers + cert page 1
  const ok = await loadPage(page, offerUrl);
  if (!ok) {
    console.warn(`    Failed to load card page (Cloudflare?), will retry next run.`);
    return null;
  }

  const othersRows = await parseSection(page, "lista-anuncio-demais-vendedores");
  const certRows   = await parseSection(page, "lista-anuncio-lojistas-certificados");
  let certPage     = 1;
  let certDone     = !await sectionHasNext(page, "lista-anuncio-lojistas-certificados");

  // Paginate certified sellers only
  while (!certDone) {
    certPage++;
    const pause = randomDelay(PAGE_BASE_DELAY, PAGE_JITTER);
    console.log(`    [cert] page ${certPage} — pausing ${(pause / 1000).toFixed(1)}s`);
    await page.waitForTimeout(pause);

    const certUrl = `${offerUrl}?estoque-cert-page=${certPage}`;
    const ok = await loadPage(page, certUrl);
    if (!ok) {
      console.warn(`    Failed on cert page ${certPage}, stopping pagination.`);
      break;
    }

    certRows.push(...await parseSection(page, "lista-anuncio-lojistas-certificados"));
    certDone = !await sectionHasNext(page, "lista-anuncio-lojistas-certificados");
  }

  console.log(`    cert rows: ${certRows.length}, others rows: ${othersRows.length}`);
  return [...certRows, ...othersRows];
}

function computeStats(cardName, offerUrl, rows) {
  const groups = {};
  for (const row of rows) {
    const price = parseBRL(row.priceRaw);
    if (isNaN(price)) continue;
    if (!groups[row.rarity]) groups[row.rarity] = [];
    groups[row.rarity].push(price);
  }
  return Object.entries(groups).map(([rarity, prices]) => ({
    card_name:   cardName,
    offer_url:   offerUrl,
    rarity,
    lowest:      Math.min(...prices),
    highest:     Math.max(...prices),
    average:     prices.reduce((a, b) => a + b, 0) / prices.length,
    offer_count: prices.length,
  }));
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const cards = readInputCards();
  const done  = loadProgress();
  initOutputCSV();

  // Find resume index and purge any partial data for that card
  let startIndex = 0;
  if (RESUME_FROM_URL) {
    const idx = cards.findIndex((c) => c.offer_url === RESUME_FROM_URL);
    if (idx !== -1) {
      startIndex = idx;
      console.log(`Resuming from card ${idx + 1}: ${cards[idx].card_name}`);

      // Remove any rows for this card already written to the output CSV,
      // since the previous run may have written partial data before stopping.
      if (fs.existsSync(OUTPUT_CSV)) {
        const lines   = fs.readFileSync(OUTPUT_CSV, "utf-8").split("\n");
        const header  = lines[0];
        const kept    = lines.slice(1).filter((line) => {
          if (!line.trim()) return false;
          // Each line is CSV — the offer_url is the second quoted field
          const m = line.match(/^"(?:[^"]|"")*","((?:[^"]|"")*)"/);
          return !(m && m[1] === RESUME_FROM_URL);
        });
        fs.writeFileSync(OUTPUT_CSV, [header, ...kept].join("\n") + "\n", "utf-8");
        console.log(`Purged existing rows for resume card from ${OUTPUT_CSV}.`);
      }

      // Also remove from progress so it gets re-scraped
      done.delete(RESUME_FROM_URL);
      saveProgress(done);
    } else {
      console.warn(`RESUME_FROM_URL not found in input CSV, starting from beginning.`);
    }
  }

  console.log(`Total cards: ${cards.length}. Already done: ${done.size}.`);

  const browser = await chromium.launch({
    headless: false,  // must be false — Cloudflare blocks headless Chromium even with stealth
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--start-minimized"],
  });

  const context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
      "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    extraHTTPHeaders: {
      "Accept-Language": "pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7",
      "Accept":
        "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
      "Referer": "https://mypcards.com/",
    },
  });

  await context.addCookies(loadCookies());
  console.log("Cookies loaded.\n");

  const page = await context.newPage();

  // Warm up: visit the homepage first so Cloudflare sees a real browser
  // session before we start hitting individual card pages.
  console.log("Warming up — visiting homepage...");
  await page.goto("https://mypcards.com/yugioh", { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(8000 + Math.random() * 7000); // 8–15s
  console.log("Warm-up done. Starting scrape.\n");

  for (let i = startIndex; i < cards.length; i++) {
    const { card_name, offer_url } = cards[i];

    if (done.has(offer_url)) {
      console.log(`[${i + 1}/${cards.length}] SKIP: ${card_name}`);
      continue;
    }

    console.log(`\n[${i + 1}/${cards.length}] ${card_name}`);
    console.log(`  ${offer_url}`);

    const allRows = await scrapeCard(page, offer_url);

    if (allRows === null) {
      console.warn(`  Blocked by Cloudflare — skipping for now, will retry next run.`);
      // Do NOT mark as done so it gets retried on next run
      const pause = randomDelay();
      console.log(`  Waiting ${(pause / 1000).toFixed(1)}s before next card...`);
      await page.waitForTimeout(pause);
      continue;
    }

    console.log(`  Rows collected: ${allRows.length}`);

    if (allRows.length > 0) {
      const stats = computeStats(card_name, offer_url, allRows);
      appendResults(stats);
      console.log(`  Rarities: ${stats.map((s) => `${s.rarity}(${s.offer_count})`).join(", ")}`);
    } else {
      console.log("  No offers found.");
    }

    done.add(offer_url);
    saveProgress(done);

    const pause = randomDelay();
    console.log(`  Next card in ${(pause / 1000).toFixed(1)}s...`);
    await page.waitForTimeout(pause);
  }

  await browser.close();
  console.log(`\nDone. Results in ${OUTPUT_CSV}`);
}

main();