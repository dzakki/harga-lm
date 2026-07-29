const puppeteer = require('puppeteer');
const cheerio = require('cheerio');

const BUY_URL = 'https://www.logammulia.com/id/harga-emas-hari-ini';
const BUYBACK_URL = 'https://www.logammulia.com/id/sell/gold';
const DENPASAR_CODE = 'ADPS';

async function selectLocation(page) {
  const clicked = await page.evaluate(() => {
    // The page also has a "change-location-chart" link (for a price chart widget)
    // whose data-src also contains "change-location" — match exactly to avoid
    // opening that popup instead, which has no #location select.
    const link =
      document.getElementById('btnChangeLocation2') ||
      Array.from(document.querySelectorAll('a[data-fancybox]')).find(
        (a) => a.getAttribute('data-src') === 'https://www.logammulia.com/change-location',
      );
    if (!link) return false;
    link.click();
    return true;
  });
  if (!clicked) throw new Error('Change-location link not found on page');
  await page.waitForSelector('#location', { timeout: 90000 });
  await page.select('#location', DENPASAR_CODE);
  // Click the real submit button rather than calling form.submit() directly —
  // the site now runs JS on the button's click event that a programmatic
  // form submit bypasses, which used to leave the request rejected server-side.
  await Promise.all([
    page.waitForNavigation({ waitUntil: 'load', timeout: 120000 }).catch(() => {}),
    page.evaluate(() => document.getElementById('change-location-button').click()),
  ]);
  await page.waitForSelector('table.table-bordered tbody tr td', { timeout: 90000 });
}

async function scrapeHargaEmas() {
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });
  const page = await browser.newPage();

  await page.setUserAgent(
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  );

  try {
    // --- Buy prices ---
    await page.goto(BUY_URL, { waitUntil: 'load', timeout: 180000 });
    await page.waitForSelector('table.table-bordered tbody tr td', { timeout: 90000 });
    await selectLocation(page);
    const buyHtml = await page.content();
    const buyData = parseTable(buyHtml);

    // --- Buyback prices ---
    // logammulia.com/id/sell/gold shows a single per-gram rate that applies to all denominations
    let pricePerGram = null;
    try {
      await page.goto(BUYBACK_URL, { waitUntil: 'networkidle2', timeout: 180000 });
      await page.waitForSelector('#valBasePrice', { timeout: 30000 });
      pricePerGram = await page.$eval('#valBasePrice', (el) => parseFloat(el.value));
      process.stderr.write(`[antam] buyback per gram: ${pricePerGram}\n`);
    } catch (e) {
      process.stderr.write(`[antam] buyback scrape skipped: ${e.message}\n`);
    }

    // Multiply per-gram rate by weight for each entry across all categories
    for (const [, entries] of buyData) {
      for (const [weight, prices] of entries) {
        if (pricePerGram !== null) {
          const total = pricePerGram * parseFloat(weight);
          prices.harga_buyback = Math.round(total).toLocaleString('id-ID');
        }
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

  $('table.table-bordered')
    .first()
    .find('tbody tr')
    .each((_, tr) => {
      const sectionHeader = $(tr).find('th[colspan]');
      if (sectionHeader.length) {
        currentSection = toSnakeCase(sectionHeader.text());
        if (!result.has(currentSection)) result.set(currentSection, []);
        return;
      }

      if (!currentSection) return;

      const cells = $(tr).find('td');
      if (cells.length < 3) return;

      const berat = $(cells.eq(0))
        .text()
        .trim()
        .replace(/\s*gr$/i, '');
      result.get(currentSection).push([
        berat,
        {
          harga_dasar: $(cells.eq(1)).text().trim(),
          harga_final: $(cells.eq(2)).text().trim(),
          harga_buyback: null,
        },
      ]);
    });

  for (const [, entries] of result) {
    entries.sort(([a], [b]) => parseFloat(a) - parseFloat(b));
  }

  return result;
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

