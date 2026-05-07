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
const idListRes = await fetch('https://esi.evetech.net/alliances');
const allianceIds = await idListRes.json();

// Step 2: Fetch metadata ONLY for missing alliances
const existingIds = new Set(
	db.prepare('SELECT id FROM alliances').all().map(row => row.id)
);

for (const id of allianceIds) {
	if (existingIds.has(id)) continue;

	try {
		const res = await fetch(`https://esi.evetech.net/alliances/${id}`);
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
  <link href="css/main.css?1" rel="stylesheet">
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

		<div id="logo-modal" class="modal hide" tabindex="-1" role="dialog" aria-labelledby="logo-modal-title"
			aria-hidden="true">
			<div class="modal-header">
				<button type="button" class="close" data-dismiss="modal" aria-hidden="true">&times;</button>
				<h3 id="logo-modal-title">Alliance Logo</h3>
			</div>
			<div class="modal-body" style="text-align: center; max-height: none; overflow: visible; position: relative;">
				<button id="logo-modal-prev" class="btn" aria-label="Previous logo" style="position: absolute; left: 0; top: 50%; transform: translateY(-50%); z-index: 10; font-size: 1.4em; padding: 0.2em 0.5em;">&#8249;</button>
				<img id="logo-modal-image" class="eveimage img-rounded" src="" alt="Alliance logo preview"
					style="width: 512px; height: 512px;">
				<div><small id="logo-modal-ticker"></small></div>
				<button id="logo-modal-next" class="btn" aria-label="Next logo" style="position: absolute; right: 0; top: 50%; transform: translateY(-50%); z-index: 10; font-size: 1.4em; padding: 0.2em 0.5em;">&#8250;</button>
			</div>
			<div class="modal-footer">
				<a id="logo-modal-zkill" class="btn btn-primary" target="_blank" href="#">zKillboard</a>
				<a id="logo-modal-evewho" class="btn" target="_blank" href="#">EveWho</a>
				<button type="button" class="btn" data-dismiss="modal">Close</button>
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

  	<hr/>
	<footer class="footer"><small>
		<center><a href="https://evewho.com/character/1633218082">Brought to you by Squizz Caphinator</a> /  / <a href="https://github.com/zKillboard/logos.zzeve.com" target="_blank" title="View source code on GitHub">GitHub </a><br><a
				class="zz-badge external-link ms-2" href="https://zzeve.com" target="_blank"><img
					src="https://img.shields.io/badge/zz-Suite-blueviolet?style=flat-square" alt="Part of zz Suite"
					style="vertical-align: middle;" class="eveimage"></a></center>
		<center data-toggle="tooltip" style="cursor: pointer; text-decoration: underline" title=""
			data-original-title="EVE Online and the EVE logo are the registered trademarks of CCP hf. All rights are reserved worldwide. All other trademarks are the property of their respective owners. EVE Online, the EVE logo, EVE and all associated logos and designs are the intellectual property of CCP hf. All artwork, screenshots, characters, vehicles, storylines, world facts or other recognizable features of the intellectual property relating to these trademarks are likewise the intellectual property of CCP hf. CCP hf. has granted permission to evewho.com to use EVE Online and all associated logos and designs for promotional and information purposes on its website but does not endorse, and is not in any way affiliated with, evewho.com. CCP is in no way responsible for the content on or functioning of this website, nor can it be liable for any damage arising from the use of this website.">
			All Eve Related Materials are Property of CCP Games</center>
	</small></footer>
	<script>
		$(function () {
			var $modal = $('#logo-modal');
			var $modalBody = $modal.find('.modal-body');
			var $modalTitle = $('#logo-modal-title');
			var $modalImage = $('#logo-modal-image');
			var $modalTicker = $('#logo-modal-ticker');
			var $modalZkill = $('#logo-modal-zkill');
			var $modalEveWho = $('#logo-modal-evewho');
			var preservedScrollTop = 0;

			// Build deduplicated ordered list of alliances from all logo links on the page
			var alliances = [];
			var seenIds = {};
			$('a[href^="https://zkillboard.com/alliance/"]').each(function () {
				var $img = $(this).find('img.eveimage');
				if (!$img.length) return;
				var href = $(this).attr('href') || '';
				var hrefParts = href.split('/').filter(Boolean);
				var allianceId = hrefParts[hrefParts.length - 1];
				if (!/^[0-9]+$/.test(allianceId)) return;
				if (seenIds[allianceId]) return;
				seenIds[allianceId] = true;
				alliances.push({ id: allianceId, ticker: $img.attr('title') || allianceId });
			});

			var currentIndex = 0;

			function showAllianceAtIndex(idx) {
				if (!alliances.length) return;
				currentIndex = (idx + alliances.length) % alliances.length;
				var a = alliances[currentIndex];
				$modalTitle.text(a.ticker + ' Alliance Logo');
				$modalImage.attr('src', '');
				$modalImage.attr('src', 'https://image.eveonline.com/Alliance/' + a.id + '_512.png');
				$modalImage.attr('alt', a.ticker + ' logo');
				$modalTicker.text('<' + a.ticker + '>');
				$modalZkill.attr('href', 'https://zkillboard.com/alliance/' + a.id + '/');
				$modalEveWho.attr('href', 'https://evewho.com/alliance/' + a.id);
				sizeModalImageToSquare();
			}

			function sizeModalImageToSquare() {
				var modalBodyWidth = $modalBody.innerWidth();
				if (!modalBodyWidth) return;

				var size = Math.min(512, modalBodyWidth - 80);
				$modalImage.css({
					width: size + 'px',
					height: size + 'px'
				});
			}

			$modal.on('show', function () {
				preservedScrollTop = $(window).scrollTop();
			});

			$modal.on('shown', function () {
				sizeModalImageToSquare();
				$(window).scrollTop(preservedScrollTop);
			});

			$modal.on('hidden', function () {
				$(window).scrollTop(preservedScrollTop);
			});

			$(window).on('resize', function () {
				if ($modal.is(':visible')) {
					sizeModalImageToSquare();
				}
			});

			$('#logo-modal-prev').on('click', function () {
				showAllianceAtIndex(currentIndex - 1);
			});

			$('#logo-modal-next').on('click', function () {
				showAllianceAtIndex(currentIndex + 1);
			});

			$(document).on('keydown', function (e) {
				if (!$modal.is(':visible')) return;
				if (e.key === 'ArrowLeft') showAllianceAtIndex(currentIndex - 1);
				else if (e.key === 'ArrowRight') showAllianceAtIndex(currentIndex + 1);
			});

			$(document).on('click', 'a[href^="https://zkillboard.com/alliance/"]', function (event) {
				var $anchor = $(this);
				var $img = $anchor.find('img.eveimage');
				if (!$img.length) return;

				event.preventDefault();

				var href = $anchor.attr('href') || '';
				var hrefParts = href.split('/').filter(Boolean);
				var allianceId = hrefParts[hrefParts.length - 1];
				if (!/^[0-9]+$/.test(allianceId)) return;

				var idx = 0;
				for (var i = 0; i < alliances.length; i++) {
					if (alliances[i].id === allianceId) { idx = i; break; }
				}

				preservedScrollTop = $(window).scrollTop();
				$modal.css('top', (preservedScrollTop + 20) + 'px');
				showAllianceAtIndex(idx);
				$modal.modal('show');
			});
		});
	</script>
</body>
</html>`;

// Save to disk
fs.writeFileSync('docs/index.html', html);
console.log('✅ Wrote index.html');
