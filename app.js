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
const newLogos = [];

for (let i = 0; i < idsToCheck.length; i += concurrency) {
	const batch = idsToCheck.slice(i, i + concurrency);

	await Promise.all(batch.map(async id => {
		try {
			const res = await fetch(`https://images.evetech.net/Alliance/${id}_128.png`, { method: 'HEAD' });
			const size = parseInt(res.headers.get('content-length'), 10);
			const hasLogo = size !== 9353 ? 1 : 0;
			const logoSince = hasLogo ? new Date().toISOString().split('T')[0] : null;

			if (hasLogo > 0) {
				// Get alliance details for the webhook
				const allianceData = db.prepare('SELECT ticker FROM alliances WHERE id = ?').get(id);
				const ticker = allianceData?.ticker || 'Unknown';
				
				console.log('new logo', `https://images.evetech.net/Alliance/${id}_128.png`);
				newLogos.push({ id, ticker });

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

// Send Discord webhook notification if new logos were found
if (newLogos.length > 0 && process.env.DISCORD_WEBHOOK) {
	try {
		const webhookData = {
			embeds: [{
				title: "🎨 New Alliance Logos Detected!",
				description: `Found **${newLogos.length}** new custom alliance logo${newLogos.length > 1 ? 's' : ''}`,
				color: 0x00ff00, // Green color
				footer: {
					text: "Alliance Logos Tracker",
					icon_url: "https://image.eveonline.com/Alliance/1_32.png"
				},
				timestamp: new Date().toISOString(),
				url: "https://logos.zzeve.com"
			}]
		};

		const webhookResponse = await fetch(process.env.DISCORD_WEBHOOK, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
			},
			body: JSON.stringify(webhookData)
		});

		if (webhookResponse.ok) {
			console.log(`✅ Discord notification sent for ${newLogos.length} new logos`);
		} else {
			console.error('❌ Failed to send Discord notification:', webhookResponse.status, webhookResponse.statusText);
		}
	} catch (err) {
		console.error('❌ Discord webhook error:', err.message);
	}
} else if (newLogos.length > 0) {
	console.log(`ℹ️ Found ${newLogos.length} new logos but no Discord webhook configured`);
}

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
        <ul class="nav pull-right">
          <li><a href="https://github.com/zKillboard/logos.zzeve.com" target="_blank" title="View source code on GitHub">
            <i class="icon-github" style="background-image: url('data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIxNiIgaGVpZ2h0PSIxNiIgZmlsbD0iI2ZmZiIgdmlld0JveD0iMCAwIDI0IDI0Ij48cGF0aCBkPSJNMTIgMEM1LjM3NCAwIDAgNS4zNzMgMCAxMiAwIDUuMzAyIDMuNDM4IDkuOCA4LjIwNyAxMC4zODdjLjU5OS0uMTExIDEuMTI1LS4zNDEgMS41MjUtLjY4NC0xLjk2Ni0xLjEwNi0zLjMzNi0zLjIyOS0zLjMzNi01LjY4NSAwLTEuMjU2LjQ1MS0yLjQxIDEuMTkzLTMuMjUyLS40NzQtLjkzNi0uNDA0LTIuMDA0LjE3Ni0yLjg3MiAxLjM0MSAwIDIuNjU3IDEuMzMgMy4yOTYgMS45ODkuOTMtLjI1NSAxLjkyNS0uMzkzIDIuOTk2LS4zOTMgMS4wNzEgMCAyLjA2Ni4xMzggMi45OTYuMzkzLjYzOS0uNjU5IDEuOTU1LTEuOTg5IDMuMjk3LTEuOTg5LjU4Ljg2OC42NSAxLjkzNi4xNzYgMi44NzIuNzQyLjg0MiAxLjE5MyAxLjk5NiAxLjE5MyAzLjI1MiAwIDIuNDU2LTEuMzcgNC41NzktMy4zMzYgNS42ODUuNC4zNDMuOTI2LjU3MyAxLjUyNS42ODRDMjAuNTYyIDIxLjggMjQgMTcuMzAyIDI0IDEyIDI0IDUuMzczIDE4LjYyNiAwIDEyIDB6bTAtMS4zOTNjNi4wOCAwIDExIDQuOTIgMTEgMTEgMCA0LjkwNi0zLjI3MSA5LjIyOC03Ljc0NyAxMC4xMTktLjU2OS0uMzQ2LS45ODMtLjgzNS0xLjA2My0xLjM5OC0uMDM1LS4yNDYtLjAzNS0uNTA4LS4wMzUtLjc3NyAwLS4yNjkgMC0uNTMxLjAzNS0uNzc3LjA4LS41NjMuNDk0LTEuMDUyIDEuMDYzLTEuMzk4LjMwOC0uMTg3LjY0OS0uMzIzIDEuMDE3LS4zOTIuOTQ5LS4xNzggMS42OTUtLjc5IDIuMDg0LTEuNjQ3LjExMy0uMjQzLjE5NC0uNTA1LjIzOS0uNzc4LjEwMy0uNjI4LS4wMS0xLjMwNS0uMjg5LTEuOTA5LS4wODMtLjE4LS4xODYtLjM0OC0uMzAzLS41MDItLjEzNy0uMTgxLS4yOTItLjMzNy0uNDY2LS40NzctLjQ2Mi0uMzY5LTEuMDI1LS42NTgtMS42ODUtLjgwMi0uMDg3LS4wMTktLjE3Ni0uMDM1LS4yNjYtLjA1LS0uMDkxLS4wMTUtLjE4Mi0uMDMtLjI3NC0uMDQzLS4zNzQtLjA1NS0uNzctLjA5NC0xLjE3OC0uMDk0cy0uODA0LjAzOS0xLjE3OC4wOTRjLS4wOTIuMDEzLS4xODMuMDI4LS4yNzQuMDQzLS4wOS4wMTUtLjE3OS4wMzEtLjI2Ni4wNS0uNjYuMTQ0LTEuMjIzLjQzMy0xLjY4NS44MDItLjE3NC4xNC0uMzI5LjI5Ni0uNDY2LjQ3Ny0uMTE3LjE1NC0uMjIuMzIyLS4zMDMuNTAyLS4yNzkuNjA0LS4zOTIgMS4yODEtLjI4OSAxLjkwOS4wNDUuMjczLjEyNi41MzUuMjM5Ljc3OC4zODkuODU3IDEuMTM1IDEuNDY5IDIuMDg0IDEuNjQ3LjM2OC4wNjkuNzA5LjIwNSAxLjAxNy4zOTIuNTY5LjM0Ni45ODMuODM1IDEuMDYzIDEuMzk4LjAzNS4yNDYuMDM1LjUwOC4wMzUuNzc3IDAgLjI2OSAwIC41MzEtLjAzNS43NzctLjA4LjU2My0uNDk0IDEuMDUyLTEuMDYzIDEuMzk4QzQyNzEgMjEuMjI4IDEgMTYuOTA2IDEgMTJjMC02LjA4IDQuOTItMTEgMTEtMTF6Ii8+PC9zdmc+'); background-repeat: no-repeat; background-position: center; width: 16px; height: 16px; display: inline-block; vertical-align: middle;"></i>
            GitHub
          </a></li>
        </ul>
      </div>
    </div>

    <h5>Latest Alliance Logos <small>${rows[0]?.logoSince} (sorted by alliance age)</small></h5>
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
