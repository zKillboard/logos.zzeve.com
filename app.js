import fs from 'fs';
import fetch from 'node-fetch';
import Database from 'better-sqlite3';

const db = new Database('alliances.db');

// Ensure table exists
db.exec(`
CREATE TABLE IF NOT EXISTS alliances (
  id INTEGER PRIMARY KEY,
  ticker TEXT,
  startDate TEXT,
  size INTEGER,
  has_custom_logo BOOLEAN,
  logoSince TEXT,
  last_checked TEXT
)`);

// Step 1: Fetch alliance IDs
const idListRes = await fetch('https://esi.evetech.net/latest/alliances/?datasource=tranquility');
const allianceIds = await idListRes.json();

// Step 2: Fetch metadata ONLY for missing alliances
const existingIds = new Set(
  db.prepare('SELECT id FROM alliances').all().map(row => row.id)
);

for (const id of allianceIds) {
  if (existingIds.has(id)) continue;

  try {
    const res = await fetch(`https://esi.evetech.net/latest/alliances/${id}/?datasource=tranquility`);
    if (!res.ok) continue;

    const data = await res.json();
    console.log('Fetched data for', data.name);

    db.prepare(`
      INSERT INTO alliances (id, ticker, startDate)
      VALUES (?, ?, ?)
    `).run(
      id,
      data.ticker ?? null,
      data.date_founded ?? null
    );
  } catch (err) {
    console.error(`Metadata error for ${id}:`, err.message);
  }
}

console.log("✅ Alliances updated.");

const concurrency = 10;

const idsToCheck = allianceIds.filter(id => {
  const row = db.prepare('SELECT has_custom_logo FROM alliances WHERE id = ?').get(id);
  return !row?.has_custom_logo;
});

console.log(`Checking ${idsToCheck.length} alliances for custom logos...`);

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

for (let i = 0; i < idsToCheck.length; i += concurrency) {
  const batch = idsToCheck.slice(i, i + concurrency);

  await Promise.all(batch.map(async id => {
    try {
      const res = await fetch(`https://images.evetech.net/Alliance/${id}_128.png`, { method: 'HEAD' });
      const size = parseInt(res.headers.get('content-length'), 10);
      const hasLogo = size !== 9353 ? 1 : 0;
      const logoSince = hasLogo ? new Date().toISOString().split('T')[0] : null;

      if (hasLogo > 0) {
        console.log('new logo', `https://images.evetech.net/Alliance/${id}_128.png`);
        
        db.prepare(`
          UPDATE alliances
          SET size = ?, has_custom_logo = ?, logoSince = ?
          WHERE id = ?
        `).run(size, hasLogo, logoSince, id);        
      }
    } catch (err) {
      console.error(`Logo check error for ${id}:`, err.message);
    }
  }));

  // backoff delay to be polite to ESI CDN
  await delay(200); // 200ms pause between batches
}

console.log("✅ Alliance logos updated.");

// Get all alliances with logos
const allWithLogos = db.prepare(`
  SELECT id, ticker, logoSince, startDate
  FROM alliances
  WHERE has_custom_logo = 1 AND logoSince IS NOT NULL AND startDate IS NOT NULL
  ORDER BY logoSince DESC, ticker ASC
`).all();

// Find newest logoSince date
const newestDate = allWithLogos.length > 0 ? allWithLogos[0].logoSince : null;

// Build newest section
const newest = allWithLogos
  .filter(row => row.logoSince === newestDate)
  .sort((a, b) => new Date(a.startDate) - new Date(b.startDate))  // oldest first

// Group hasLogos by month of alliance creation
const hasLogos = {};
for (const row of allWithLogos) {
  const monthKey = row.startDate.slice(0, 7); // e.g., "2024-06"
  if (!hasLogos[monthKey]) hasLogos[monthKey] = [];
  hasLogos[monthKey].push({
    id: row.id,
    ticker: row.ticker,
    logoSince: row.logoSince,
    startDate: row.startDate
  });
}

// Sort groups by month descending
const grouped = Object.fromEntries(
  Object.entries(hasLogos)
    .sort((a, b) => b[0].localeCompare(a[0]))
);

const output = {
  newest,
  hasLogos: grouped
};

fs.writeFileSync('alliances_with_logos.json', JSON.stringify(output, null, 2));
console.log('✅ Wrote alliances_with_logos.json');