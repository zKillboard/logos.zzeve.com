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
	break;
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
let newestDate = allWithLogos.length > 0 ? allWithLogos[0].logoSince : null;

// Build newest section
let newest = allWithLogos
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
let grouped = Object.fromEntries(
	Object.entries(hasLogos)
		.sort((a, b) => b[0].localeCompare(a[0]))
);

const output = {
	newest,
	hasLogos: grouped
};

fs.writeFileSync('docs/alliances_with_logos.json', JSON.stringify(output, null, 2));
console.log('✅ Wrote alliances_with_logos.json');


// Query all logos with metadata
const rows = db.prepare(`
  SELECT id, ticker, logoSince, startDate
  FROM alliances
  WHERE has_custom_logo = 1 AND logoSince IS NOT NULL AND startDate IS NOT NULL
  ORDER BY logoSince DESC, startDate ASC, ticker ASC
`).all();

// Group newest logos (by latest logoSince)
newestDate = rows[0]?.logoSince;
newest = rows.filter(row => row.logoSince === newestDate);

// Group by creation month
grouped = {};
for (const row of rows) {
	const [year, monthNum] = row.startDate.split('-');
	const monthName = new Date(row.startDate).toLocaleString('default', { month: 'long' });
	const key = `${year} ${monthName}`;
	grouped[key] = grouped[key] || [];
	grouped[key].push(row);
}

// Sort grouped months descending
const groupedSorted = Object.entries(grouped).sort((a, b) => {
	return new Date(b[0]) - new Date(a[0]);
});

// Helper: render logo block
const logoBlock = ({ id, ticker }) => `
  <div class="pull-left"
    style="text-align: center; width: 64px; height: 100px !important; max-height: 90px; margin-right: 1em; overflow: hidden; text-overflow: ellipsis;">
    <a target="_blank" href="https://zkillboard.com/alliance/${id}/"><img
      class="eveimage img-rounded"
      src="https://image.eveonline.com/Alliance/${id}_64.png"
      style="width: 64px; height: 64px;" rel="tooltip"
      title="${ticker}"></a><small>&lt;${ticker}&gt;</small>
  </div>`;

// Build sections
const newestHTML = newest.map(logoBlock).join('\n');

const groupedHTML = groupedSorted.map(([month, logos]) => `
  <div class="well pull-left" style="margin-right: 1em; padding-left: 1em;">
    <h4>${month}</h4>
    ${logos.map(logoBlock).join('\n')}
  </div>`).join('\n');

// Write full HTML page
const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta http-equiv="X-UA-Compatible" content="IE=edge,chrome=1">
  <meta name="description" content="Alliance Logos is for showing the newest alliance logos within the MMO Eve Online">
  <meta name="title" content="Alliance Logos">
  <meta name="keywords" content="eve-online, eve, ccp, ccp games, massively, multiplayer, online, role, playing, game, mmorpg">
  <meta name="robots" content="index,follow">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Alliance Logos</title>
  <link href="css/bootstrap-combined.min.2.2.2.css" rel="stylesheet">
  <link href="css/main.css" rel="stylesheet">
  <script src="js/jquery.min.1.8.3.js"></script>
  <script src="js/bootstrap.min.2.2.2.js"></script>
</head>
<body>
  <div class="container">
    <div class="navbar container">
      <div class="navbar-inner">
        <li class="brand" href="/"><img class="eveimage img-rounded" src="https://image.eveonline.com/Alliance/1_32.png"
          style="padding: 0; margin: 0; background-color: #111; height: 25px; width: 25px;">&nbsp;
          Alliance Logos</li>
      </div>
    </div>

    <h5>Latest Alliance Logos <small>(sorted by alliance age)</small></h5>
    <div class="row"><div class="span12">
      <div class="well pull-left" style="margin-right: 1em; padding-left: 1em;">
        ${newestHTML}
      </div>
    </div></div>

    <h5>Alliances with Logos <small>(sorted by alliance creation date)</small></h5>
    <div class="row"><div class="span12">
      ${groupedHTML}
    </div></div>

    <div class="footer">
      <hr>
      <div class="pull-left">Brought to you by a bored <a target="_blank"
        href="http://evewho.com/pilot/Squizz+Caphinator">Squizz Caphinator</a></div>
    </div>
  </div>
</body>
</html>`;

// Save to disk
fs.writeFileSync('docs/index.html', html);
console.log('✅ Wrote index.html');
