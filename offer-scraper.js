import { chromium } from "playwright-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import fs from "fs";
import readline from "readline";
import xlsx from "xlsx";
import { execFileSync } from "child_process";

chromium.use(StealthPlugin());

// ─── Constants ────────────────────────────────────────────────────────────────

const MAX_RETRIES     = 4;
const BASE_DELAY      = 8000;
const JITTER          = 22000; // 8–30s between cards
const PAGE_BASE_DELAY = 3000;
const PAGE_JITTER     = 7000;  // 3–10s between cert pages

// ─── CLI helpers ──────────────────────────────────────────────────────────────

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

function ask(question) {
  return new Promise((resolve) => rl.question(question, (ans) => resolve(ans.trim())));
}

async function askNumber(question, min, max, defaultVal) {
  while (true) {
    const raw = await ask(question);
    if (raw === "" && defaultVal !== undefined) return defaultVal;
    const n = parseInt(raw, 10);
    if (!isNaN(n) && n >= min && n <= max) return n;
    console.log(`  Enter a number between ${min} and ${max}${defaultVal !== undefined ? ` (or Enter for ${defaultVal})` : ""}.`);
  }
}

function listFiles(extensions) {
  return fs.readdirSync(".").filter((f) =>
    extensions.some((ext) => f.toLowerCase().endsWith(ext))
  );
}

async function pickFile(label, extensions) {
  const files = listFiles(extensions);
  if (files.length === 0) {
    console.log(`No ${extensions.join("/")} files found in current directory.`);
    process.exit(1);
  }
  console.log(`\n${label}:`);
  files.forEach((f, i) => console.log(`  [${i + 1}] ${f}`));
  const idx = await askNumber(`Choose (1-${files.length}): `, 1, files.length, 1);
  return files[idx - 1];
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function randomDelay(base = BASE_DELAY, jitter = JITTER) {
  return base + Math.random() * jitter;
}

function escapeCSV(val) {
  return `"${String(val ?? "").replace(/"/g, '""')}"`;
}

function parseBRL(raw) {
  return parseFloat(
    raw.replace(/R\$\s*/g, "").trim().replace(/\./g, "").replace(",", ".")
  );
}

// ─── Progress ─────────────────────────────────────────────────────────────────

function loadProgress(progressFile) {
  if (!fs.existsSync(progressFile)) return new Set();
  try {
    return new Set(JSON.parse(fs.readFileSync(progressFile, "utf-8")).done ?? []);
  } catch { return new Set(); }
}

function saveProgress(progressFile, done) {
  fs.writeFileSync(progressFile, JSON.stringify({ done: [...done] }, null, 2));
}

// ─── CSV ──────────────────────────────────────────────────────────────────────

function readInputCards(inputFile) {
  if (!fs.existsSync(inputFile)) {
    console.error(`Input file "${inputFile}" not found.`);
    process.exit(1);
  }

  const isXlsx = inputFile.toLowerCase().endsWith(".xlsx");

  if (isXlsx) {
    // Ask which sheet and which columns contain name and URL
    // (resolved synchronously via readFileSync — sheet selection happens in CLI step)
    const wb = xlsx.readFile(inputFile);
    // _sheetName and _nameCol and _urlCol are injected by the CLI before calling this
    const ws = wb.Sheets[readInputCards._sheet];
    const rows = xlsx.utils.sheet_to_json(ws, { header: 1 }).slice(1);
    return rows
      .map((row) => ({
        card_name: String(row[readInputCards._nameCol] ?? "").trim(),
        offer_url: String(row[readInputCards._urlCol]  ?? "").trim(),
      }))
      .filter((r) => r.card_name && r.offer_url && r.offer_url.startsWith("http"));
  }

  // CSV
  const lines = fs.readFileSync(inputFile, "utf-8").trim().split("\n");
  return lines.slice(1).map((line) => {
    const match = line.match(/^"((?:[^"]|"")*)","((?:[^"]|"")*)"$/);
    if (!match) return null;
    return {
      card_name: match[1].replace(/""/g, '"'),
      offer_url: match[2].replace(/""/g, '"'),
    };
  }).filter(Boolean);
}

function initOutputCSV(outputCsv) {
  if (!fs.existsSync(outputCsv)) {
    fs.writeFileSync(outputCsv, "card_name,offer_url,rarity,lowest,highest,average,offer_count\n", "utf-8");
  }
}

function appendResults(outputCsv, rows) {
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
  fs.appendFileSync(outputCsv, lines.join("\n") + "\n", "utf-8");
}

function purgeCardFromCSV(outputCsv, offerUrl) {
  if (!fs.existsSync(outputCsv)) return;
  const lines  = fs.readFileSync(outputCsv, "utf-8").split("\n");
  const header = lines[0];
  const kept   = lines.slice(1).filter((line) => {
    if (!line.trim()) return false;
    const m = line.match(/^"(?:[^"]|"")*","((?:[^"]|"")*)"/);
    return !(m && m[1] === offerUrl);
  });
  fs.writeFileSync(outputCsv, [header, ...kept].join("\n") + "\n", "utf-8");
}

function initOutputXlsx(outputFile, sheetName) {
  let wb;
  if (fs.existsSync(outputFile)) {
    wb = xlsx.readFile(outputFile);
  } else {
    wb = xlsx.utils.book_new();
  }
  if (!wb.SheetNames.includes(sheetName)) {
    const ws = xlsx.utils.aoa_to_sheet([
      ["card_name", "offer_url", "rarity", "lowest", "highest", "average", "offer_count"]
    ]);
    xlsx.utils.book_append_sheet(wb, ws, sheetName);
    xlsx.writeFile(wb, outputFile);
  }
}

/**
 * Update price columns in an existing xlsx sheet in-place.
 * Matches rows by offer_url + rarity, updates lowest/highest/average/offer_count.
 * colMap: { url, rarity, lowest, highest, average, offer_count } — 0-based col indices
 */
/**
 * Update price columns in place using the Python openpyxl helper,
 * which preserves all cell formatting, styles and formulas.
 */
function updateResultsXlsx(outputFile, sheetName, stats, colMap) {
  const statsJson = JSON.stringify(stats.map((s) => ({
    offer_url:   s.offer_url,
    rarity:      s.rarity,
    lowest:      parseFloat(s.lowest.toFixed(2)),
    highest:     parseFloat(s.highest.toFixed(2)),
    average:     parseFloat(s.average.toFixed(2)),
    offer_count: s.offer_count,
  })));

  try {
    const result = execFileSync("python3", [
      "update-xlsx.py",
      outputFile,
      sheetName,
      String(colMap.url         + 1),
      String(colMap.rarity      + 1),
      String(colMap.lowest      + 1),
      String(colMap.highest     + 1),
      String(colMap.average     + 1),
      String(colMap.offer_count + 1),
      statsJson,
    ], { encoding: "utf-8" });

    const match = result.match(/updated:(\d+)/);
    if (match) console.log(`    xlsx updated: ${match[1]} rows`);
  } catch (err) {
    // Surface openpyxl missing error clearly
    if (err.stdout?.includes("ERROR:") || err.stderr?.includes("ERROR:")) {
      console.error("\n" + (err.stdout || err.stderr));
      console.error("Install openpyxl and re-run.");
      process.exit(1);
    }
    console.warn(`    xlsx update failed: ${err.message}`);
  }
}

/**
 * Append new rows to an xlsx sheet (for new/empty sheets).
 */
function appendResultsXlsx(outputFile, sheetName, rows) {
  const wb = xlsx.readFile(outputFile);
  const ws = wb.Sheets[sheetName];
  const existing = xlsx.utils.sheet_to_json(ws, { header: 1 });
  const newRows = rows.map((r) => [
    r.card_name, r.offer_url, r.rarity,
    parseFloat(r.lowest.toFixed(2)),
    parseFloat(r.highest.toFixed(2)),
    parseFloat(r.average.toFixed(2)),
    r.offer_count,
  ]);
  wb.Sheets[sheetName] = xlsx.utils.aoa_to_sheet([...existing, ...newRows]);
  xlsx.writeFile(wb, outputFile);
}

function purgeCardFromXlsx(outputFile, sheetName, offerUrl, colMap) {
  if (!fs.existsSync(outputFile)) return;
  const wb   = xlsx.readFile(outputFile);
  const ws   = wb.Sheets[sheetName];
  if (!ws) return;
  const rows    = xlsx.utils.sheet_to_json(ws, { header: 1 });
  const urlIdx  = colMap?.url ?? rows[0]?.indexOf("offer_url") ?? 1;
  const filtered = rows.filter((r, i) => i === 0 || String(r[urlIdx] ?? "") !== offerUrl);
  wb.Sheets[sheetName] = xlsx.utils.aoa_to_sheet(filtered);
  xlsx.writeFile(wb, outputFile);
}

// ─── Cookies ──────────────────────────────────────────────────────────────────

function loadCookies(cookiesFile) {
  const raw = fs.readFileSync(cookiesFile, "utf-8").trim();

  if (raw.startsWith("[")) {
    return JSON.parse(raw).map((c) => ({
      name: c.name, value: c.value, domain: c.domain,
      path: c.path ?? "/", expires: c.expirationDate ?? -1,
      httpOnly: c.httpOnly ?? false, secure: c.secure ?? false,
      sameSite: c.sameSite === "no_restriction" ? "None"
              : c.sameSite === "strict"         ? "Strict" : "Lax",
    }));
  }

  // Netscape format
  return raw.split("\n")
    .filter((l) => l && !l.startsWith("#"))
    .map((line) => {
      const parts = line.split("\t");
      if (parts.length < 7) return null;
      const [domain,, path, secure, expires, name, value] = parts;
      return { name, value, domain, path: path ?? "/",
               expires: parseInt(expires) || -1,
               httpOnly: false, secure: secure === "TRUE", sameSite: "Lax" };
    }).filter(Boolean);
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

async function parseSection(page, sectionId) {
  return page.$$eval(`#${sectionId} tbody tr[data-key]`, (trs) =>
    trs.map((tr) => {
      const rarityCell = tr.querySelector(".estoque-lista-nomeenfoil");
      const priceCell  = tr.querySelector(".estoque-lista-precoestoque .moeda");
      if (!rarityCell || !priceCell) return null;
      return {
        rarity:   rarityCell.innerText.trim().split(",")[0].trim(),
        priceRaw: priceCell.innerText.trim(),
      };
    }).filter(Boolean)
  );
}

async function sectionHasNext(page, sectionId) {
  return page.evaluate((sid) => {
    const section = document.getElementById(sid);
    if (!section) return false;
    return section.querySelectorAll(".pagination li.next a").length > 0;
  }, sectionId);
}

async function scrapeCard(page, offerUrl) {
  const ok = await loadPage(page, offerUrl);
  if (!ok) {
    console.warn(`    Failed to load card page (Cloudflare?), will retry next run.`);
    return null;
  }

  const othersRows = await parseSection(page, "lista-anuncio-demais-vendedores");
  const certRows   = await parseSection(page, "lista-anuncio-lojistas-certificados");
  let certPage     = 1;
  let certDone     = !await sectionHasNext(page, "lista-anuncio-lojistas-certificados");

  while (!certDone) {
    certPage++;
    const pause = randomDelay(PAGE_BASE_DELAY, PAGE_JITTER);
    console.log(`    [cert] page ${certPage} — pausing ${(pause / 1000).toFixed(1)}s`);
    await page.waitForTimeout(pause);

    const certUrl = `${offerUrl}?estoque-cert-page=${certPage}`;
    const certOk  = await loadPage(page, certUrl);
    if (!certOk) {
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
  console.log("\n=== MYP Offer Scraper ===\n");

  // ── Step 1: Input file (CSV or XLSX) ──────────────────────────────────────
  const inputCsv = await pickFile("Input cards file", [".csv", ".xlsx"]);

  // If xlsx, ask which sheet and which columns hold name + URL
  if (inputCsv.toLowerCase().endsWith(".xlsx")) {
    const wb = xlsx.readFile(inputCsv);
    const sheets = wb.SheetNames;
    console.log(`\nSheets in "${inputCsv}":`);
    sheets.forEach((s, i) => console.log(`  [${i + 1}] ${s}`));
    const sheetIdx = await askNumber(`Choose sheet (1-${sheets.length}): `, 1, sheets.length, 1);
    readInputCards._sheet = sheets[sheetIdx - 1];

    const ws = wb.Sheets[readInputCards._sheet];
    const headerRow = xlsx.utils.sheet_to_json(ws, { header: 1 })[0] ?? [];
    console.log(`\nColumns in "${readInputCards._sheet}":`);
    headerRow.forEach((h, i) => { if (h) console.log(`  [${i + 1}] ${h}`); });

    const maxCol = headerRow.length;
    readInputCards._nameCol = (await askNumber(`Column for Card Name (1-${maxCol}): `, 1, maxCol, 1)) - 1;
    readInputCards._urlCol  = (await askNumber(`Column for Offer URL (1-${maxCol}): `, 1, maxCol, 1)) - 1;
  }

  // ── Step 2: Output file (CSV or XLSX) ────────────────────────────────────
  const existingOutputs = listFiles([".csv", ".xlsx"]);
  let outputFile;
  let outputIsXlsx = false;
  let outputSheet  = "Offers";

  console.log("\nOutput file:");
  if (existingOutputs.length > 0) {
    existingOutputs.forEach((f, i) => console.log(`  [${i + 1}] ${f}`));
    console.log(`  [${existingOutputs.length + 1}] Create new CSV → offers.csv`);
    console.log(`  [${existingOutputs.length + 2}] Create new XLSX → offers.xlsx`);
    const idx = await askNumber(`Choose (1-${existingOutputs.length + 2}): `, 1, existingOutputs.length + 2, existingOutputs.length + 1);
    if (idx <= existingOutputs.length) {
      outputFile    = existingOutputs[idx - 1];
      outputIsXlsx  = outputFile.toLowerCase().endsWith(".xlsx");
    } else if (idx === existingOutputs.length + 2) {
      outputFile   = "offers.xlsx";
      outputIsXlsx = true;
    } else {
      outputFile = "offers.csv";
    }
  } else {
    console.log("  [1] Create new CSV → offers.csv");
    console.log("  [2] Create new XLSX → offers.xlsx");
    const idx = await askNumber("Choose (1-2): ", 1, 2, 1);
    outputFile   = idx === 2 ? "offers.xlsx" : "offers.csv";
    outputIsXlsx = idx === 2;
  }

  // If xlsx output, ask which sheet and map columns
  let outputColMap = null;
  let outputIsUpdate = false; // true = update in place, false = append

  if (outputIsXlsx && fs.existsSync(outputFile)) {
    const wb = xlsx.readFile(outputFile);
    const sheets = wb.SheetNames;
    console.log(`\nSheets in "${outputFile}":`);
    sheets.forEach((s, i) => console.log(`  [${i + 1}] ${s}`));
    console.log(`  [${sheets.length + 1}] Create new sheet`);
    const idx = await askNumber(`Choose (1-${sheets.length + 1}): `, 1, sheets.length + 1, 1);
    if (idx <= sheets.length) {
      outputSheet = sheets[idx - 1];

      // Existing sheet — ask if updating in place or appending
      console.log(`\nSheet "${outputSheet}" already exists.`);
      console.log("  [1] Update existing rows in place (match by URL + rarity)");
      console.log("  [2] Append new rows");
      const mode = await askNumber("Choose (1-2): ", 1, 2, 1);
      outputIsUpdate = mode === 1;

      if (outputIsUpdate) {
        // Map which columns hold the data we need to update
        const ws = wb.Sheets[outputSheet];
        const headerRow = xlsx.utils.sheet_to_json(ws, { header: 1 })[0] ?? [];
        console.log(`\nMap columns in "${outputSheet}" for update:`);
        headerRow.forEach((h, i) => { if (h) console.log(`  [${i + 1}] ${h}`); });
        const maxCol = headerRow.length;
        const g = (label, def) => askNumber(`  ${label} column (1-${maxCol}): `, 1, maxCol, def + 1).then((n) => n - 1);
        // Try to auto-detect by header name first
        const hi = (name) => headerRow.findIndex((h) => String(h).toLowerCase().includes(name.toLowerCase()));
        outputColMap = {
          url:         await g("Offer URL",    hi("url") >= 0 ? hi("url") : 1),
          rarity:      await g("Rarity",       hi("rarity") >= 0 ? hi("rarity") : 2),
          lowest:      await g("Lowest",       hi("lowest") >= 0 ? hi("lowest") : 3),
          highest:     await g("Highest",      hi("highest") >= 0 ? hi("highest") : 5),
          average:     await g("Average",      hi("average") >= 0 ? hi("average") : 4),
          offer_count: await g("Offer count",  hi("offer") >= 0 ? hi("offer") : 6),
        };
      }
    } else {
      outputSheet = await ask("New sheet name: ") || "Offers";
    }
  }

  // ── Step 3: Cookies ────────────────────────────────────────────────────────
  const cookiesFile = await pickFile("Cookies file", [".json", ".txt"]);

  // ── Step 4: Progress file ──────────────────────────────────────────────────
  const progressFile = outputFile.replace(/\.(csv|xlsx)$/i, "-progress.json");
  console.log(`\nProgress file: ${progressFile}`);

  // ── Step 5: Resume URL ─────────────────────────────────────────────────────
  const cards = readInputCards(inputCsv);
  const done  = loadProgress(progressFile);

  console.log(`\nTotal cards: ${cards.length}. Already done: ${done.size}.`);
  console.log("Resume URL (paste a card URL to restart from that card, or Enter to continue normally):");
  const resumeInput = await ask("> ");
  const resumeUrl   = resumeInput || null;

  let startIndex = 0;
  if (resumeUrl) {
    const idx = cards.findIndex((c) => c.offer_url === resumeUrl);
    if (idx !== -1) {
      startIndex = idx;
      console.log(`Resuming from card ${idx + 1}: ${cards[idx].card_name}`);
      if (outputIsXlsx) purgeCardFromXlsx(outputFile, outputSheet, resumeUrl, outputColMap);
      else purgeCardFromCSV(outputFile, resumeUrl);
      done.delete(resumeUrl);
      saveProgress(progressFile, done);
      console.log(`Purged existing data for resume card.`);
    } else {
      console.warn(`URL not found in input — starting from beginning.`);
    }
  }

  // ── Step 6: Filter by flag column ─────────────────────────────────────────
  // Only applies when input is xlsx — check if a flag column exists
  let flagFilteredUrls     = null; // null = no filter, Set = only scrape these urls
  let flagFilteredRarities = null; // null = all rarities, Map<url, Set<rarity>> = specific only

  if (inputCsv.toLowerCase().endsWith(".xlsx")) {
    const wb2 = xlsx.readFile(inputCsv);
    const ws2 = wb2.Sheets[readInputCards._sheet];
    const headerRow2 = xlsx.utils.sheet_to_json(ws2, { header: 1 })[0] ?? [];

    console.log(`
Flag/interest column (e.g. "Tenho") to focus scrape on — Enter to skip:`);
    headerRow2.forEach((h, i) => { if (h) console.log(`  [${i + 1}] ${h}`); });
    console.log(`  [${headerRow2.length + 1}] No filter — scrape all`);

    const flagIdx = await askNumber(
      `Choose (1-${headerRow2.length + 1}, Enter = no filter): `,
      1, headerRow2.length + 1, headerRow2.length + 1
    );

    if (flagIdx <= headerRow2.length) {
      const colIdx  = flagIdx - 1;
      const colName = headerRow2[colIdx];
      const allRows2 = xlsx.utils.sheet_to_json(ws2, { header: 1 }).slice(1);

      // Ask whether to scrape only the flagged rarities or all rarities of flagged cards
      console.log(`\nFor flagged cards, scrape:`);
      console.log(`  [1] Only the specific flagged rarities`);
      console.log(`  [2] All rarities of flagged cards`);
      const rarityMode = await askNumber("Choose (1-2): ", 1, 2, 2);

      const flaggedRows = allRows2.filter(
        (r) => String(r[colIdx] ?? "").trim().toLowerCase() === "x"
      );

      // flagFilteredUrls: Set of URLs to scrape
      flagFilteredUrls = new Set(
        flaggedRows
          .map((r) => String(r[readInputCards._urlCol] ?? "").trim())
          .filter(Boolean)
      );

      // flagFilteredRarities: Map of url -> Set of rarities (only used in mode 1)
      // null means "all rarities"
      if (rarityMode === 1) {
        const rarityCol = headerRow2.findIndex(
          (h) => h && String(h).toLowerCase().includes("rarity")
        );
        if (rarityCol >= 0) {
          flagFilteredRarities = new Map();
          for (const r of flaggedRows) {
            const url    = String(r[readInputCards._urlCol] ?? "").trim();
            const rarity = String(r[rarityCol] ?? "").trim();
            if (!url) continue;
            if (!flagFilteredRarities.has(url)) flagFilteredRarities.set(url, new Set());
            flagFilteredRarities.get(url).add(rarity);
          }
          console.log(`Filtering to ${flagFilteredUrls.size} cards, specific rarities only.`);
        } else {
          console.log(`No rarity column found — falling back to all rarities.`);
        }
      } else {
        console.log(`Filtering to ${flagFilteredUrls.size} cards, all rarities.`);
      }
    }
  }

  // ── Step 7: Limit ──────────────────────────────────────────────────────────
  const pending = cards.slice(startIndex).filter((c) =>
    !done.has(c.offer_url) &&
    (flagFilteredUrls === null || flagFilteredUrls.has(c.offer_url))
  );
  console.log(`
Pending cards: ${pending.length}`);
  const limit = await askNumber(
    `How many to scrape this run? (1-${pending.length}, Enter = all): `,
    1, pending.length, pending.length
  );

  rl.close();

  // ── Browser setup ──────────────────────────────────────────────────────────
  if (outputIsXlsx) initOutputXlsx(outputFile, outputSheet);
  else initOutputCSV(outputFile);

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

  await context.addCookies(loadCookies(cookiesFile));
  console.log("\nCookies loaded. Warming up...");

  const page = await context.newPage();
  await page.goto("https://mypcards.com/yugioh", { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(8000 + Math.random() * 7000);
  console.log("Warm-up done. Starting scrape.\n");

  let scraped = 0, failed = 0;

  for (let i = startIndex; i < cards.length; i++) {
    if (scraped + failed >= limit) break;

    const { card_name, offer_url } = cards[i];

    if (done.has(offer_url)) {
      console.log(`[${i + 1}/${cards.length}] SKIP: ${card_name}`);
      continue;
    }

    if (flagFilteredUrls !== null && !flagFilteredUrls.has(offer_url)) {
      continue; // not flagged, skip silently
    }

    console.log(`\n[${i + 1}/${cards.length}] ${card_name}`);
    console.log(`  ${offer_url}`);

    const allRows = await scrapeCard(page, offer_url);

    if (allRows === null) {
      console.warn(`  Blocked by Cloudflare — will retry next run.`);
      failed++;
      const pause = randomDelay();
      console.log(`  Waiting ${(pause / 1000).toFixed(1)}s...`);
      await page.waitForTimeout(pause);
      continue;
    }

    console.log(`  Rows collected: ${allRows.length}`);

    if (allRows.length > 0) {
      let stats = computeStats(card_name, offer_url, allRows);

      // If filtering by specific rarities, drop stats rows not in the flagged set
      if (flagFilteredRarities !== null && flagFilteredRarities.has(offer_url)) {
        const allowed = flagFilteredRarities.get(offer_url);
        stats = stats.filter((s) => allowed.has(s.rarity));
      }

      if (outputIsXlsx) {
        if (outputIsUpdate) updateResultsXlsx(outputFile, outputSheet, stats, outputColMap);
        else appendResultsXlsx(outputFile, outputSheet, stats);
      } else {
        appendResults(outputFile, stats);
      }
      console.log(`  Rarities: ${stats.map((s) => `${s.rarity}(${s.offer_count})`).join(", ")}`);
    } else {
      console.log("  No offers found.");
    }

    done.add(offer_url);
    saveProgress(progressFile, done);
    scraped++;

    const pause = randomDelay();
    console.log(`  Next card in ${(pause / 1000).toFixed(1)}s...`);
    await page.waitForTimeout(pause);
  }

  await browser.close();
  console.log(`\nDone. Scraped: ${scraped}, Blocked: ${failed}. Results in ${outputFile}`);
}

main();