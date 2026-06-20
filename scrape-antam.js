const puppeteer = require('puppeteer');
const cheerio = require('cheerio');

const BUY_URL = 'https://www.logammulia.com/id/harga-emas-hari-ini';
const BUYBACK_URL = 'https://www.logammulia.com/id/sell/gold';
const DENPASAR_CODE = 'ADPS';

async function selectLocation(page) {
  await page.evaluate(() => {
    const link = Array.from(document.querySelectorAll('a[data-fancybox]')).find(
      (a) => a.getAttribute('data-src')?.includes('change-location')
    );
    if (link) link.click();
  });
  await page.waitForSelector('#location', { timeout: 90000 });
  await page.select('#location', DENPASAR_CODE);
  await Promise.all([
    page.waitForNavigation({ waitUntil: 'load', timeout: 120000 }),
    page.evaluate(() => document.getElementById('change-location').submit()),
  ]);
}

async function scrapeHargaEmas() {
  const browser = await puppeteer.launch({ headless: true, args: ["--no-sandbox", "--disable-setuid-sandbox"] });
  const page = await browser.newPage();

  await page.setUserAgent(
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  );

  try {
    // --- Buy prices ---
    await page.goto(BUY_URL, { waitUntil: 'load', timeout: 180000 });
    await page.waitForSelector('table.table-bordered tbody tr td', { timeout: 90000 });
    await selectLocation(page);
    await page.waitForSelector('table.table-bordered tbody tr td', { timeout: 90000 });
    const buyHtml = await page.content();
    const buyData = parseTable(buyHtml);

    // --- Buyback prices ---
    await page.goto(BUYBACK_URL, { waitUntil: 'load', timeout: 180000 });
    await page.waitForSelector('table.table-bordered tbody tr td', { timeout: 90000 });
    try { await selectLocation(page); } catch (_) {}
    try { await page.waitForSelector('table.table-bordered tbody tr td', { timeout: 30000 }); } catch (_) {}
    const buybackHtml = await page.content();
    const buybackMap = parseBuybackTable(buybackHtml);

    // Merge buyback prices into buy data (match by weight across all categories)
    for (const [, entries] of buyData) {
      for (const [weight, prices] of entries) {
        prices.harga_buyback = buybackMap.get(weight) || null;
      }
    }

    return buyData;
  } finally {
    await browser.close();
  }
}

function toSnakeCase(str) {
  return str.trim().toLowerCase().replace(/\s+/g, '_');
}

function parseTable(html) {
  const $ = cheerio.load(html);
  const result = new Map();
  let currentSection = null;

  $('table.table-bordered').first().find('tbody tr').each((_, tr) => {
    const sectionHeader = $(tr).find('th[colspan]');
    if (sectionHeader.length) {
      currentSection = toSnakeCase(sectionHeader.text());
      if (!result.has(currentSection)) result.set(currentSection, []);
      return;
    }

    if (!currentSection) return;

    const cells = $(tr).find('td');
    if (cells.length < 3) return;

    const berat = $(cells.eq(0)).text().trim().replace(/\s*gr$/i, '');
    result.get(currentSection).push([berat, {
      harga_dasar: $(cells.eq(1)).text().trim(),
      harga_final: $(cells.eq(2)).text().trim(),
      harga_buyback: null,
    }]);
  });

  for (const [, entries] of result) {
    entries.sort(([a], [b]) => parseFloat(a) - parseFloat(b));
  }

  return result;
}

// Returns Map<weight, buybackPrice> from the sell/buyback page
function parseBuybackTable(html) {
  const $ = cheerio.load(html);
  const map = new Map();

  $('table.table-bordered').first().find('tbody tr').each((_, tr) => {
    if ($(tr).find('th[colspan]').length) return;

    const cells = $(tr).find('td');
    if (cells.length < 2) return;

    const berat = $(cells.eq(0)).text().trim().replace(/\s*gr$/i, '');
    if (!berat || isNaN(parseFloat(berat))) return;

    const price = $(cells.eq(1)).text().trim();
    if (price) map.set(berat, price);
  });

  return map;
}

function toJson(data) {
  // data is a Map<string, Array<[weight, prices]>>
  // Build JSON string manually — avoids JS engine's integer-key hoisting.
  const categoryLines = [...data.entries()].map(([cat, entries]) => {
    const itemLines = entries.map(([w, v]) => `      "${w}": ${JSON.stringify(v)}`);
    return `  "${cat}": {\n${itemLines.join(',\n')}\n  }`;
  });
  return '{\n' + categoryLines.join(',\n') + '\n}';
}

scrapeHargaEmas()
  .then((data) => console.log(toJson(data)))
  .catch((err) => {
    console.error('Scrape failed:', err.message);
    process.exit(1);
  });
