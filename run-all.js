const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

const SCRIPTS = [
  { script: 'scrape-antam.js',   output: 'antam.json' },
  { script: 'scrape-emasku.js',  output: 'emasku.json' },
  { script: 'scrape-galeri24.js',output: 'galery24.json' },
  { script: 'scrape-ubs.js',     output: 'ubs.json' },
];

function run({ script, output }) {
  return new Promise((resolve, reject) => {
    console.log(`[${script}] starting...`);
    execFile('node', [script], { cwd: __dirname }, (err, stdout, stderr) => {
      if (err) {
        console.error(`[${script}] failed: ${stderr || err.message}`);
        return reject(err);
      }

      const outPath = path.join(__dirname, output);
      fs.writeFileSync(outPath, stdout.trim());
      console.log(`[${script}] done → ${output}`);
      resolve();
    });
  });
}

(async () => {
  const results = await Promise.allSettled(SCRIPTS.map(run));
  const failed = results.filter(r => r.status === 'rejected');
  if (failed.length) {
    console.error(`\n${failed.length} script(s) failed.`);
    process.exit(1);
  }
  console.log('\nAll done.');
})();
