const puppeteer = require('puppeteer');
const cheerio = require('cheerio');

const TARGET_URL = 'https://www.logammulia.com/id/harga-emas-hari-ini';
const DENPASAR_CODE = 'ADPS';

async function scrapeHargaEmas() {
  const browser = await puppeteer.launch({ headless: true, args: ["--no-sandbox", "--disable-setuid-sandbox"] });
  const page = await browser.newPage();

  await page.setUserAgent(
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  );

  try {
    await page.goto(TARGET_URL, { waitUntil: 'networkidle2', timeout: 60000 });
    await page.waitForSelector('table.table-bordered tbody tr td', { timeout: 20000 });

    // Open the location modal (Fancybox AJAX popup)
    await page.evaluate(() => {
      const link = Array.from(document.querySelectorAll('a[data-fancybox]')).find(
        (a) => a.getAttribute('data-src')?.includes('change-location')
      );
      if (link) link.click();
    });

    await page.waitForSelector('#location', { timeout: 20000 });
    await page.select('#location', DENPASAR_CODE);

    await Promise.all([
      page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }),
      page.evaluate(() => document.getElementById('change-location').submit()),
    ]);

    await page.waitForSelector('table.table-bordered tbody tr td', { timeout: 20000 });

    const html = await page.content();
    return parseTable(html);
  } finally {
    await browser.close();
  }
}

function toSnakeCase(str) {
  return str.trim().toLowerCase().replace(/\s+/g, '_');
}

function parseTable(html) {
  const $ = cheerio.load(html);
  // Use Map to preserve insertion order for categories.
  // Each category value is an array of [weight, prices] pairs (sorted later).
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
    }]);
  });

  // Sort each category's entries by weight numerically
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
