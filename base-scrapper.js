import { chromium } from "playwright";
import fs from "fs";

const BASE_URL = "https://mypcards.com";
const START_URL = `${BASE_URL}/yugioh/rarity-collection-5`;

const OUTPUT_FILE = "cards.csv";
const PAGE_FILE = "page.txt";
const USER_DATA_DIR = "./user-data";

const MAX_PAGE_RETRIES = 3;

// CSV
function escapeCSV(str) {
  return `"${String(str).replace(/"/g, '""')}"`;
}

function appendToCSV(rows, writeHeader = false) {
  const lines = rows.map(
    (r) => `${escapeCSV(r.card_name)},${escapeCSV(r.offer_url)}`
  );

  const content =
    (writeHeader ? "card_name,offer_url\n" : "") +
    lines.join("\n") +
    "\n";

  const fd = fs.openSync(OUTPUT_FILE, "a");
  fs.writeSync(fd, content);
  fs.fsyncSync(fd);
  fs.closeSync(fd);

  console.log(`💾 Wrote ${rows.length} rows`);
}

// Resume
function getStartPage() {
  if (!fs.existsSync(PAGE_FILE)) return 1;
  const val = parseInt(fs.readFileSync(PAGE_FILE, "utf-8"), 10);
  return isNaN(val) ? 1 : val;
}

function saveNextPage(page) {
  fs.writeFileSync(PAGE_FILE, String(page), "utf-8");
}

// Random delay helper
function randomDelay() {
  return 2000 + Math.random() * 3000; // 2–5 seconds
}

async function main() {
  const context = await chromium.launchPersistentContext(USER_DATA_DIR, {
    headless: false,
    args: ["--no-sandbox"],
  });

  const page = await context.newPage();

  const seen = new Set();
  let isFirstWrite = !fs.existsSync(OUTPUT_FILE);

  let currentPage = getStartPage();
  console.log(`▶️ Starting from page ${currentPage}`);

  while (true) {
    const url = `${START_URL}?pagina=${currentPage}`;
    console.log(`\nFetching page ${currentPage}...`);

    let success = false;

    for (let attempt = 1; attempt <= MAX_PAGE_RETRIES; attempt++) {
      try {
        console.log(`→ Attempt ${attempt}`);

        await page.goto(url, {
          waitUntil: "domcontentloaded",
          timeout: 60000,
        });

        // ✅ Random delay after load
        const delay = randomDelay();
        console.log(`⏳ Waiting ${(delay / 1000).toFixed(2)}s`);
        await page.waitForTimeout(delay);

        // Cloudflare wait
        for (let i = 0; i < 10; i++) {
          let html = "";
          try {
            html = await page.content();
          } catch {}

          if (!html.includes("Just a moment")) break;

          console.log("⏳ Waiting for Cloudflare...");
          await page.waitForTimeout(3000);
        }

        await page.waitForSelector("li[class*='stream']", {
          timeout: 15000,
        });

        const cards = await page.$$eval("li[class*='stream']", (items) =>
          items
            .map((el) => {
              const card = el.querySelector(".card");
              if (!card || card.classList.contains("outro-produto")) return null;

              const name = card.querySelector("h3")?.innerText?.trim();
              const href = card
                .querySelector("a.bt-offers")
                ?.getAttribute("href");

              if (!name || !href) return null;
              if (href === "#") return null;
              if (!href.includes("/produto/")) return null;

              return {
                card_name: name,
                offer_url: "https://mypcards.com" + href,
              };
            })
            .filter(Boolean)
        );

        console.log(`→ Found ${cards.length} valid cards`);

        if (cards.length === 0) {
          console.log("🏁 No more cards. Finished.");
          await context.close();
          console.log("\n✅ Done.");
          return;
        }

        const newCards = [];

        for (const card of cards) {
          if (seen.has(card.offer_url)) continue;
          seen.add(card.offer_url);
          newCards.push(card);
        }

        console.log(`🧪 New vs total: ${newCards.length}/${cards.length}`);

        appendToCSV(newCards, isFirstWrite);
        isFirstWrite = false;

        saveNextPage(currentPage + 1);

        success = true;
        break;
      } catch (err) {
        console.warn(`⚠️ Attempt ${attempt} failed: ${err.message}`);

        if (attempt < MAX_PAGE_RETRIES) {
          console.log("🔁 Retrying...");
          await page.waitForTimeout(5000);
        }
      }
    }

    if (!success) {
      console.error(`❌ Failed page ${currentPage}, skipping...`);
      currentPage++;
      continue;
    }

    currentPage++;
  }
}

main();