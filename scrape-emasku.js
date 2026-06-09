const puppeteer = require('puppeteer');
const cheerio = require('cheerio');

const TARGET_URL = 'https://www.emasku.co.id/id/gold-price';

async function scrapeHargaEmas() {
  const browser = await puppeteer.launch({ headless: true, args: ["--no-sandbox", "--disable-setuid-sandbox"] });
  const page = await browser.newPage();

  await page.setUserAgent(
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  );

  try {
    await page.goto(TARGET_URL, { waitUntil: 'networkidle2', timeout: 30000 });
    await page.waitForSelector('table tbody tr td', { timeout: 10000 });

    const html = await page.content();
    return parseTable(html);
  } finally {
    await browser.close();
  }
}

function toSnakeCase(str) {
  return str.trim().toLowerCase().replace(/\s+/g, '_');
}

function parsePrice(cell) {
  // Cells contain "Rp" in one span and the number in another.
  // Strip non-numeric characters except dots used as thousand separators.
  return cell.replace(/rp\.?/gi, '').replace(/\s+/g, '').trim();
}

function parseTable(html) {
  const $ = cheerio.load(html);
  // Map preserves insertion order regardless of key type
  const result = new Map();
  let currentSection = null;

  $('table tbody tr').each((_, tr) => {
    // Section separator: single td with colspan
    const separator = $(tr).find('td[colspan]');
    if (separator.length) {
      currentSection = toSnakeCase(separator.text());
      if (!result.has(currentSection)) result.set(currentSection, []);
      return;
    }

    if (!currentSection) return;

    const cells = $(tr).find('td');
    if (cells.length < 2) return;

    // Weight cell: "0.1 gr" — strip the " gr" suffix
    const berat = $(cells.eq(0)).text().trim().replace(/\s*gr$/i, '').trim();
    const hargaDasar = parsePrice($(cells.eq(1)).text());

    result.get(currentSection).push([berat, {
      harga_dasar: hargaDasar,
      harga_final: hargaDasar,
    }]);
  });

  // Sort weights numerically within each category
  for (const [, entries] of result) {
    entries.sort(([a], [b]) => parseFloat(a) - parseFloat(b));
  }

  return result;
}

function toJson(data) {
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
