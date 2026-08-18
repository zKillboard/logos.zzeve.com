import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';
import { pathToFileURL } from 'url';
import fetch from 'node-fetch';
import sharp from 'sharp';

const WIDTH = 1200;
const HEIGHT = 630;
const TILE_SIZE = 166;
const COLUMN_STEP = 150;
const COLUMNS = 8;
const ROWS = 4;
const LOGO_COUNT = COLUMNS * ROWS;
const CANDIDATE_COUNT = 48;
const DOWNLOAD_BATCH_SIZE = 8;

const allianceLogoUrl = id =>
	`https://images.evetech.net/alliances/${id}/logo?size=256`;

async function fetchLogo(alliance) {
	try {
		const response = await fetch(allianceLogoUrl(alliance.id));
		if (!response.ok) {
			throw new Error(`HTTP ${response.status}`);
		}

		const contentType = response.headers.get('content-type') || '';
		if (!contentType.startsWith('image/')) {
			throw new Error(`unexpected content type ${contentType || 'unknown'}`);
		}

		return {
			...alliance,
			buffer: Buffer.from(await response.arrayBuffer())
		};
	} catch (error) {
		console.warn(`Could not use logo for alliance ${alliance.id}: ${error.message}`);
		return null;
	}
}

function textOverlay() {
	return Buffer.from(`
		<svg width="${WIDTH}" height="${HEIGHT}" xmlns="http://www.w3.org/2000/svg">
			<defs>
				<linearGradient id="shade" x1="0" y1="0" x2="0" y2="1">
					<stop offset="0" stop-color="#05070b" stop-opacity="0.18"/>
					<stop offset="0.5" stop-color="#05070b" stop-opacity="0.38"/>
					<stop offset="1" stop-color="#05070b" stop-opacity="0.62"/>
				</linearGradient>
				<filter id="shadow" x="-20%" y="-20%" width="140%" height="140%">
					<feDropShadow dx="0" dy="8" stdDeviation="8" flood-color="#000" flood-opacity="0.9"/>
				</filter>
			</defs>
			<rect width="${WIDTH}" height="${HEIGHT}" fill="url(#shade)"/>
			<g text-anchor="middle" font-family="DejaVu Sans, Arial, sans-serif" font-weight="800"
				stroke="#07090d" stroke-linejoin="round" paint-order="stroke fill" filter="url(#shadow)">
				<text x="600" y="300" font-size="112" letter-spacing="5" stroke-width="20" fill="#fff">ALLIANCE LOGOS</text>
				<text x="600" y="380" font-size="34" letter-spacing="7" stroke-width="11" fill="#8ed8ff">ALL THE LOGOS FROM EVE ONLINE</text>
			</g>
			<text x="600" y="573" text-anchor="middle" font-family="DejaVu Sans, Arial, sans-serif"
				font-size="28" font-weight="700" letter-spacing="3" fill="#fff" stroke="#07090d"
				stroke-width="9" stroke-linejoin="round" paint-order="stroke fill">LOGOS.ZZEVE.COM</text>
		</svg>
	`);
}

export async function generateOpenGraphImage(alliances, outputPath = 'docs/opengraph.png') {
	const candidates = alliances.slice(0, CANDIDATE_COUNT);
	if (candidates.length === 0) {
		throw new Error('Cannot generate an Open Graph image without alliance logos');
	}

	const fetched = [];
	for (let index = 0; index < candidates.length && fetched.length < LOGO_COUNT; index += DOWNLOAD_BATCH_SIZE) {
		const batch = candidates.slice(index, index + DOWNLOAD_BATCH_SIZE);
		const results = await Promise.all(batch.map(fetchLogo));
		fetched.push(...results.filter(Boolean));
	}
	if (fetched.length === 0) {
		throw new Error('Could not download any alliance logos for the Open Graph image');
	}

	// Reuse successful downloads only when the database has fewer than 32 logos.
	const selected = Array.from({ length: LOGO_COUNT }, (_, index) => fetched[index % fetched.length]);
	const tiles = await Promise.all(selected.map(({ buffer }) =>
		sharp(buffer)
			.resize(TILE_SIZE - 6, TILE_SIZE - 6, { fit: 'cover' })
			.extend({
				top: 3,
				bottom: 3,
				left: 3,
				right: 3,
				background: '#080b10'
			})
			.png()
			.toBuffer()
	));

	const composites = tiles.map((input, index) => ({
		input,
		left: -8 + (index % COLUMNS) * COLUMN_STEP,
		top: -17 + Math.floor(index / COLUMNS) * TILE_SIZE
	}));

	composites.push({ input: textOverlay(), left: 0, top: 0 });

	const image = await sharp({
		create: {
			width: WIDTH,
			height: HEIGHT,
			channels: 3,
			background: '#080b10'
		}
	})
		.composite(composites)
		.png({ compressionLevel: 9, adaptiveFiltering: true })
		.toBuffer();

	fs.mkdirSync(path.dirname(outputPath), { recursive: true });
	fs.writeFileSync(outputPath, image);
	console.log(`✅ Wrote ${outputPath} using ${Math.min(fetched.length, LOGO_COUNT)} recent alliance logos`);
	return createHash('sha256').update(image).digest('hex').slice(0, 12);
}

function rowsFromGeneratedJson(json) {
	const unique = new Map();
	for (const logos of Object.values(json.hasLogos || {})) {
		for (const alliance of logos) {
			unique.set(alliance.id, alliance);
		}
	}

	return [...unique.values()].sort((a, b) =>
		b.logoSince.localeCompare(a.logoSince) ||
		a.startDate.localeCompare(b.startDate) ||
		a.ticker.localeCompare(b.ticker)
	);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
	const json = JSON.parse(fs.readFileSync('docs/alliances_with_logos.json', 'utf8'));
	await generateOpenGraphImage(rowsFromGeneratedJson(json));
}
