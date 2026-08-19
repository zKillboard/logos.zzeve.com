import fs from 'fs';
import { createHash } from 'crypto';
import fetch from 'node-fetch';
import Database from 'better-sqlite3';
import { generateOpenGraphImage } from './generate-opengraph.js';

const db = new Database('alliances.db');
const generateOnly = process.argv.includes('--generate-only');

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

const newLogos = [];

if (!generateOnly) {
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

	console.log('Alliances updated.');

	const concurrency = 10;
	const idsToCheck = allianceIds.filter(id => {
		const row = db.prepare('SELECT has_custom_logo FROM alliances WHERE id = ?').get(id);
		return !row?.has_custom_logo;
	});
	const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

	console.log(`Checking ${idsToCheck.length} alliances for custom logos...`);

	for (let i = 0; i < idsToCheck.length; i += concurrency) {
		const batch = idsToCheck.slice(i, i + concurrency);

		await Promise.all(batch.map(async id => {
			try {
				const res = await fetch(`https://images.evetech.net/Alliance/${id}_128.png`, { method: 'HEAD' });
				const size = parseInt(res.headers.get('content-length'), 10);
				const hasLogo = size !== 9353 ? 1 : 0;
				const logoSince = hasLogo ? new Date().toISOString().split('T')[0] : null;

				if (hasLogo > 0) {
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

		await delay(200);
	}

	console.log('Alliance logos updated.');

	if (newLogos.length > 0 && process.env.DISCORD_WEBHOOK) {
		try {
			const webhookData = {
				embeds: [{
					title: 'New Alliance Logos Detected!',
					description: `Found **${newLogos.length}** new custom alliance logo${newLogos.length > 1 ? 's' : ''}`,
					color: 0x00ff00,
					footer: {
						text: 'Alliance Logos Tracker',
						icon_url: 'https://image.eveonline.com/Alliance/1_32.png'
					},
					timestamp: new Date().toISOString(),
					url: 'https://logos.zzeve.com'
				}]
			};

			const webhookResponse = await fetch(process.env.DISCORD_WEBHOOK, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(webhookData)
			});

			if (webhookResponse.ok) {
				console.log(`Discord notification sent for ${newLogos.length} new logos`);
			} else {
				console.error('Failed to send Discord notification:', webhookResponse.status, webhookResponse.statusText);
			}
		} catch (err) {
			console.error('Discord webhook error:', err.message);
		}
	} else if (newLogos.length > 0) {
		console.log(`Found ${newLogos.length} new logos but no Discord webhook configured`);
	}
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

// Regenerate the social preview only when this run detects new custom logos.
if (newLogos.length > 0) {
	await generateOpenGraphImage(rows);
} else {
	console.log('ℹ️ No new logos; keeping the existing Open Graph image');
}

const ogImageVersion = createHash('sha256')
	.update(fs.readFileSync('docs/opengraph.png'))
	.digest('hex')
	.slice(0, 12);

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

const escapeHTML = value => String(value).replace(/[&<>"']/g, character => ({
	'&': '&amp;',
	'<': '&lt;',
	'>': '&gt;',
	'"': '&quot;',
	"'": '&#39;'
})[character]);

// Each tile remains a useful zKillboard link when JavaScript is unavailable.
const logoBlock = ({ id, ticker }, eager = false) => {
	const safeTicker = escapeHTML(ticker || 'Unknown');
	const loading = eager ? 'eager' : 'lazy';
	return `
      <li class="alliance-logo">
        <a class="logo-link" href="https://zkillboard.com/alliance/${id}/" data-alliance-id="${id}"
          data-ticker="${safeTicker}" aria-haspopup="dialog" aria-label="View ${safeTicker} alliance logo details">
          <img class="eveimage img-rounded" src="https://image.eveonline.com/Alliance/${id}_64.png"
            alt="" width="64" height="64" loading="${loading}" decoding="async">
          <span aria-hidden="true">&lt;${safeTicker}&gt;</span>
        </a>
      </li>`;
};

// Build sections
const newestHTML = newest.map(row => logoBlock(row, true)).join('\n');

const groupedHTML = groupedSorted.map(([month, logos]) => `
      <div class="logo-group well">
        <h3 id="month-${month.toLowerCase().replace(' ', '-')}">${month}</h3>
        <ul class="logo-grid">
          ${logos.map(row => logoBlock(row)).join('\n')}
        </ul>
      </div>`).join('\n');

// Write full HTML page
const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="description" content="Discover the newest custom alliance logos from EVE Online.">
  <meta name="title" content="Alliance Logos">
  <meta name="keywords" content="eve-online, eve, ccp, ccp games, massively, multiplayer, online, role, playing, game, mmorpg">
  <meta name="robots" content="index,follow">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="canonical" href="https://logos.zzeve.com/">
  <meta property="og:type" content="website">
  <meta property="og:site_name" content="Alliance Logos">
  <meta property="og:url" content="https://logos.zzeve.com/">
  <meta property="og:title" content="Alliance Logos">
  <meta property="og:description" content="Discover the newest custom alliance logos from EVE Online.">
  <meta property="og:image" content="https://logos.zzeve.com/opengraph.png?v=${ogImageVersion}">
  <meta property="og:image:secure_url" content="https://logos.zzeve.com/opengraph.png?v=${ogImageVersion}">
  <meta property="og:image:type" content="image/png">
  <meta property="og:image:width" content="1200">
  <meta property="og:image:height" content="630">
  <meta property="og:image:alt" content="A collage of recent EVE Online alliance logos">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="Alliance Logos">
  <meta name="twitter:description" content="Discover the newest custom alliance logos from EVE Online.">
  <meta name="twitter:image" content="https://logos.zzeve.com/opengraph.png?v=${ogImageVersion}">
  <meta name="twitter:image:alt" content="A collage of recent EVE Online alliance logos">
  <title>Alliance Logos</title>
  <link href="css/bootstrap-combined.min.2.2.2.css" rel="stylesheet">
  <link href="css/main.css?4" rel="stylesheet">
  <script src="js/jquery.min.1.8.3.js"></script>
  <script src="js/bootstrap.min.2.2.2.js"></script>
</head>
<body>
  <a class="skip-link" href="#main-content">Skip to main content</a>
  <header class="site-header">
    <div class="navbar container">
      <div class="navbar-inner">
        <h1 class="site-title">
          <a class="brand" href="/">
            <img class="eveimage img-rounded" src="https://image.eveonline.com/Alliance/1_32.png"
              alt="" width="32" height="32">
            <span>Alliance Logos</span>
          </a>
        </h1>
      </div>
    </div>
  </header>

  <main id="main-content" class="container" tabindex="-1">
    <section class="logo-section" aria-labelledby="latest-heading">
      <h2 id="latest-heading">Latest Alliance Logos</h2>
      <p class="section-meta"><time datetime="${rows[0]?.logoSince || ''}">${rows[0]?.logoSince || 'No detection date'}</time>; sorted by alliance age</p>
      <div class="logo-group well">
        <ul class="logo-grid">
          ${newestHTML}
        </ul>
      </div>
    </section>

    <section class="logo-section" aria-labelledby="all-heading">
      <h2 id="all-heading">Alliances with Logos</h2>
      <p class="section-meta">Sorted by alliance creation date</p>
      <div class="month-groups">
      ${groupedHTML}
      </div>
    </section>
  </main>

  <div id="logo-modal" class="modal hide" tabindex="-1" role="dialog" aria-modal="true"
    aria-labelledby="logo-modal-title" aria-describedby="logo-modal-ticker" aria-hidden="true">
    <div class="modal-header">
      <button type="button" class="close" data-dismiss="modal" aria-label="Close logo details">
        <span aria-hidden="true">&times;</span>
      </button>
      <h2 id="logo-modal-title">Alliance Logo</h2>
    </div>
    <div class="modal-body">
      <button id="logo-modal-prev" class="btn modal-nav modal-nav-prev" type="button" aria-label="Previous alliance logo">
        <span aria-hidden="true">&#8249;</span>
      </button>
      <img id="logo-modal-image" class="eveimage img-rounded"
        src="data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=" alt="" width="512" height="512">
      <p id="logo-modal-ticker" class="modal-ticker" aria-live="polite"></p>
      <button id="logo-modal-next" class="btn modal-nav modal-nav-next" type="button" aria-label="Next alliance logo">
        <span aria-hidden="true">&#8250;</span>
      </button>
    </div>
    <div class="modal-footer">
      <a id="logo-modal-zkill" class="btn btn-primary" target="_blank" rel="noopener noreferrer" href="#">
        zKillboard<span class="visually-hidden"> (opens in a new tab)</span>
      </a>
      <a id="logo-modal-evewho" class="btn" target="_blank" rel="noopener noreferrer" href="#">
        EveWho<span class="visually-hidden"> (opens in a new tab)</span>
      </a>
      <button type="button" class="btn" data-dismiss="modal">Close</button>
    </div>
  </div>

  <footer class="footer container">
    <p>
      <a href="https://evewho.com/character/1633218082">Brought to you by Squizz Caphinator</a>
      <span aria-hidden="true"> / </span>
      <a href="https://github.com/zKillboard/logos.zzeve.com" target="_blank" rel="noopener noreferrer">
        GitHub<span class="visually-hidden"> (opens in a new tab)</span>
      </a>
    </p>
    <a class="zz-badge external-link" href="https://zzeve.com" target="_blank" rel="noopener noreferrer">
      <img src="https://img.shields.io/badge/zz-Suite-blueviolet?style=flat-square" alt="Part of zz Suite (opens in a new tab)" width="75" height="20">
    </a>
    <details class="legal">
      <summary>All EVE-related materials are property of CCP Games</summary>
      <p>EVE Online and the EVE logo are registered trademarks of CCP hf. All rights are reserved worldwide. All other trademarks are the property of their respective owners. EVE Online, the EVE logo, EVE, and all associated logos and designs are the intellectual property of CCP hf. All artwork, screenshots, characters, vehicles, storylines, world facts, and other recognizable features of the intellectual property relating to these trademarks are likewise the intellectual property of CCP hf. CCP hf. has granted permission to evewho.com to use EVE Online and all associated logos and designs for promotional and information purposes on its website but does not endorse, and is not affiliated with, evewho.com. CCP is not responsible for the content or functioning of this website and cannot be liable for damage arising from its use.</p>
    </details>
  </footer>
	<script>
		$(function () {
			var $modal = $('#logo-modal');
			var $modalBody = $modal.find('.modal-body');
			var $modalTitle = $('#logo-modal-title');
			var $modalImage = $('#logo-modal-image');
			var $modalTicker = $('#logo-modal-ticker');
			var $modalZkill = $('#logo-modal-zkill');
			var $modalEveWho = $('#logo-modal-evewho');
			var blankImage = 'data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=';
			var preservedScrollTop = 0;
			var lastTrigger = null;

			// Build a deduplicated navigation list from the rendered logo tiles.
			var alliances = [];
			var seenIds = {};
			$('.logo-link').each(function () {
				var $link = $(this);
				var allianceId = $link.attr('data-alliance-id');
				if (!/^[0-9]+$/.test(allianceId)) return;
				if (seenIds[allianceId]) return;
				seenIds[allianceId] = true;
				alliances.push({ id: allianceId, ticker: $link.attr('data-ticker') || allianceId });
			});

			var currentIndex = 0;

			function showAllianceAtIndex(idx) {
				if (!alliances.length) return;
				currentIndex = (idx + alliances.length) % alliances.length;
				var a = alliances[currentIndex];
				$modalTitle.text(a.ticker + ' Alliance Logo');
				$modalImage.attr({
					src: 'https://image.eveonline.com/Alliance/' + a.id + '_512.png',
					alt: a.ticker + ' alliance logo'
				});
				$modalTicker.text('<' + a.ticker + '>');
				$modalZkill.attr('href', 'https://zkillboard.com/alliance/' + a.id + '/');
				$modalEveWho.attr('href', 'https://evewho.com/alliance/' + a.id);
				sizeModalImageToSquare();
			}

			function sizeModalImageToSquare() {
				var modalBodyWidth = $modalBody.innerWidth();
				if (!modalBodyWidth) return;

				var size = Math.max(120, Math.min(512, modalBodyWidth - 112));
				$modalImage.css({
					width: size + 'px',
					height: size + 'px'
				});
			}

			$modal.on('show', function () {
				preservedScrollTop = $(window).scrollTop();
				$modal.attr('aria-hidden', 'false');
			});

			$modal.on('shown', function () {
				sizeModalImageToSquare();
				$(window).scrollTop(preservedScrollTop);
				$modal.find('.close').focus();
			});

			$modal.on('hidden', function () {
				$modal.attr('aria-hidden', 'true');
				$modalImage.attr({ src: blankImage, alt: '' });
				$(window).scrollTop(preservedScrollTop);
				if (lastTrigger) lastTrigger.focus();
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
				if (e.key === 'ArrowLeft') {
					e.preventDefault();
					showAllianceAtIndex(currentIndex - 1);
				} else if (e.key === 'ArrowRight') {
					e.preventDefault();
					showAllianceAtIndex(currentIndex + 1);
				} else if (e.key === 'Escape') {
					e.preventDefault();
					$modal.modal('hide');
				} else if (e.key === 'Tab') {
					var $focusable = $modal.find('a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])').filter(':visible');
					var first = $focusable[0];
					var last = $focusable[$focusable.length - 1];
					if (e.shiftKey && document.activeElement === first) {
						e.preventDefault();
						last.focus();
					} else if (!e.shiftKey && document.activeElement === last) {
						e.preventDefault();
						first.focus();
					}
				}
			});

			$(document).on('click', '.logo-link', function (event) {
				var $anchor = $(this);
				var allianceId = $anchor.attr('data-alliance-id');
				if (!/^[0-9]+$/.test(allianceId)) return;
				event.preventDefault();

				var idx = 0;
				for (var i = 0; i < alliances.length; i++) {
					if (alliances[i].id === allianceId) { idx = i; break; }
				}

				lastTrigger = this;
				showAllianceAtIndex(idx);
				$modal.modal('show');
			});
		});
	</script>
</body>
</html>`;

// Save to disk
fs.writeFileSync('docs/index.html', html.replace(/[ \t]+$/gm, ''));
console.log('✅ Wrote index.html');
