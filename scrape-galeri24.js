const puppeteer = require('puppeteer');
const cheerio = require('cheerio');

const TARGET_URL = 'https://galeri24.co.id/harga-emas#GALERI%2024';
const CATEGORY = 'galeri_24';

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
    await page.goto(TARGET_URL, { waitUntil: 'networkidle2', timeout: 180000 });
    // Wait for at least one section heading to be rendered
    await page.waitForSelector('.bg-primary-100', { timeout: 10000 });

    const html = await page.content();
    return parseTable(html);
  } finally {
    await browser.close();
  }
}

function stripRp(str) {
  return str.replace(/^Rp/i, '').trim();
}

function parseTable(html) {
  const $ = cheerio.load(html);
  const entries = [];

  // Each section: heading div.bg-primary-100 + sibling data container, both inside the same parent div
  $('.bg-primary-100').each((_, heading) => {
    if ($(heading).text().trim().toUpperCase() !== 'HARGA GALERI 24') return;

    // Data rows are grid-cols-5 divs inside the sibling overflow container
    $(heading)
      .parent()
      .find('.grid-cols-5')
      .each((i, row) => {
        // Skip the header row (col children are Berat / Harga Jual / Harga Buyback)
        const cols = $(row).children('div');
        if (cols.length < 3) return;

        const berat = $(cols.eq(0)).text().trim();
        const hargaJual = stripRp($(cols.eq(1)).text().trim());
        const hargaBuyback = cols.length >= 3 ? stripRp($(cols.eq(2)).text().trim()) : null;

        // Skip the header row (non-numeric berat)
        if (!berat || isNaN(parseFloat(berat))) return;

        entries.push([
          berat,
          {
            harga_dasar: hargaJual,
            harga_final: hargaJual,
            harga_buyback: hargaBuyback || null,
          },
        ]);
      });
  });

  // Sort numerically
  entries.sort(([a], [b]) => parseFloat(a) - parseFloat(b));

  return entries;
}

function toJson(category, entries) {
  const itemLines = entries.map(([w, v]) => `      "${w}": ${JSON.stringify(v)}`);
  const inner = `  "${category}": {\n${itemLines.join(',\n')}\n  }`;
  return '{\n' + inner + '\n}';
}

scrapeHargaEmas()
  .then((entries) => console.log(toJson(CATEGORY, entries)))
  .catch((err) => {
    console.error('Scrape failed:', err.message);
    process.exit(1);
  });

