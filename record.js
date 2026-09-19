#!/usr/bin/env node
import { chromium } from 'playwright';
import { parseArgs } from 'node:util';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// Headless Chromium repaints at most 60 times per second, so more frames would only be duplicates.
const MAX_FPS = 60;

// Used with --gpu. Software rendering (the default, so any machine gets the same result)
// misses repaints on heavy pages (blur, video, big gradients) at 1080p, and every miss is a
// visible stutter; GPU rendering keeps up. Without a usable GPU, Chromium falls back to software.
const GPU_ARGS = process.platform === 'linux'
	? ['--use-angle=vulkan', '--enable-features=Vulkan']
	: ['--enable-gpu'];

const DEFAULTS = {
	width: 1920,
	height: 1080,
	speed: 200,        // Pixels scrolled per second
	fps: MAX_FPS,      // Output frame rate
	startDelay: 1500,  // Pause at the top before scrolling begins (ms)
	endDelay: 1500     // Pause after reaching the bottom before stopping (ms)
};

const HELP = `Usage: scroll-record <url> [options]

Records a smooth top-to-bottom scroll of a web page as a video.

<url> can be a full URL, a bare domain (example.com), a local dev server
(localhost:5173), or a path to an HTML file.

Options:
  -o, --output <file>     .mp4 or .webm file to write
                          (default: <site>-scroll.mp4 in the current directory)
  -s, --speed <px/s>      Scroll speed in pixels per second (default: ${DEFAULTS.speed})
      --fps <n>           Frames per second, up to ${MAX_FPS} (default: ${DEFAULTS.fps})
      --width <px>        Viewport width (default: ${DEFAULTS.width})
      --height <px>       Viewport height (default: ${DEFAULTS.height})
      --start-delay <ms>  Pause at the top before scrolling (default: ${DEFAULTS.startDelay})
      --end-delay <ms>    Pause at the bottom before stopping (default: ${DEFAULTS.endDelay})
      --keep-loading      Start the video when the page first paints instead of once it
                          has fully loaded, keeping any loading or intro animation
      --gpu               Render on the GPU. Smoother on heavy pages (blur, video, large
                          gradients); falls back to software if no GPU is available
      --headed            Show the browser window while recording
  -h, --help              Show this help
  -v, --version           Show the version

Requires ffmpeg on your PATH.

Examples:
  scroll-record example.com
  scroll-record localhost:5173 -o demo.mp4 --speed 300
  scroll-record localhost:5173 --keep-loading
  scroll-record https://example.com/pricing --width 390 --height 844 -o mobile.webm`;

function fail(message) {
	console.error(`scroll-record: ${message}`);
	process.exit(1);
}

function parseNumber(name, value, fallback, { allowZero = false } = {}) {
	if (value === undefined) return fallback;
	const n = Number(value);
	if (!Number.isFinite(n) || n < 0 || (n === 0 && !allowZero)) {
		fail(`--${name} must be a ${allowZero ? 'non-negative' : 'positive'} number, got "${value}"`);
	}
	return n;
}

// Accepts full URLs, local file paths, "localhost:5173" and bare domains.
function resolveTarget(input) {
	if (/^[a-z][a-z0-9+.-]*:\/\//i.test(input)) return input;
	if (fs.existsSync(input)) return pathToFileURL(path.resolve(input)).href;
	if (/^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(:\d+)?(\/|$)/i.test(input)) return `http://${input}`;
	return `https://${input}`;
}

// "https://example.com/pricing" -> "example.com-pricing-scroll.mp4"
function defaultOutputName(url) {
	const name = url.protocol === 'file:'
		? path.basename(url.pathname, path.extname(url.pathname))
		: `${url.host}${url.pathname}`;
	const slug = name.replace(/[^a-z0-9.]+/gi, '-').replace(/^-+|-+$/g, '');
	return `${slug || 'page'}-scroll.mp4`;
}

function hasFfmpeg() {
	return !spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).error;
}

// Streams every repaint of the page to `file` as JPEGs via CDP screencasting. Chromium only
// sends a frame when something on screen changed, stamped with the wall-clock time it was drawn.
async function startCapture(page, { width, height }, file) {
	const cdp = await page.context().newCDPSession(page);
	const out = fs.createWriteStream(file);
	const frames = []; // { time: ms since epoch, offset, length } into `file`
	let offset = 0;
	let stopped = false;

	cdp.on('Page.screencastFrame', ({ data, metadata, sessionId }) => {
		cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => {});
		if (stopped) return;
		const jpeg = Buffer.from(data, 'base64');
		frames.push({ time: (metadata.timestamp ?? Date.now() / 1000) * 1000, offset, length: jpeg.length });
		offset += jpeg.length;
		out.write(jpeg);
	});
	await cdp.send('Page.startScreencast', {
		format: 'jpeg',
		quality: 90,
		maxWidth: width,
		maxHeight: height,
		everyNthFrame: 1
	});

	return {
		frames,
		async stop() {
			stopped = true;
			await cdp.send('Page.stopScreencast').catch(() => {});
			out.end();
			await once(out, 'close');
		}
	};
}

// Resamples the captured frames onto a constant `fps` grid spanning clipStart..clipEnd
// (ms since epoch) and pipes them through ffmpeg. Each grid slot shows the latest frame drawn
// by then, so still stretches of the page (where Chromium sends nothing) are held correctly.
async function encode(frames, framesFile, output, { clipStart, clipEnd, fps }) {
	if (frames.length === 0) throw new Error('no frames were captured');
	frames.sort((a, b) => a.time - b.time);

	const interval = 1000 / fps;
	// Shift the grid by under one frame so its slots land on actual repaints. A slot sitting
	// halfway between two repaints would flip between them with timing jitter, duplicating
	// some frames and skipping others.
	const reference = frames.find((f) => f.time >= clipStart) ?? frames.at(-1);
	const gridStart = clipStart + (((reference.time - clipStart) % interval) + interval) % interval;
	const slots = Math.max(1, Math.round((clipEnd - gridStart) / interval));

	const codecArgs = path.extname(output).toLowerCase() === '.mp4'
		? ['-c:v', 'libx264', '-preset', 'slow', '-crf', '18', '-pix_fmt', 'yuv420p', '-movflags', '+faststart']
		: ['-c:v', 'libvpx-vp9', '-crf', '30', '-b:v', '0', '-deadline', 'good', '-cpu-used', '4', '-row-mt', '1'];
	const ffmpeg = spawn('ffmpeg', [
		'-y', '-v', 'error',
		'-f', 'image2pipe', '-c:v', 'mjpeg', '-framerate', String(fps), '-i', 'pipe:0',
		'-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2', // x264 needs even dimensions
		'-an', ...codecArgs,
		output
	], { stdio: ['pipe', 'inherit', 'inherit'] });
	const exited = new Promise((resolve, reject) => {
		ffmpeg.on('error', reject);
		ffmpeg.on('close', resolve);
	});
	exited.catch(() => {}); // Awaited below; this just avoids an unhandled rejection meanwhile.
	ffmpeg.stdin.on('error', () => {}); // An early exit is reported through the exit code.

	const fd = fs.openSync(framesFile, 'r');
	try {
		let current = 0;
		let loaded = -1;
		let jpeg;
		for (let slot = 0; slot < slots; slot++) {
			// Half a frame of tolerance absorbs jitter in when repaints are timestamped.
			const time = gridStart + slot * interval + interval / 2;
			while (current + 1 < frames.length && frames[current + 1].time <= time) current++;
			if (current !== loaded) {
				jpeg = Buffer.alloc(frames[current].length);
				fs.readSync(fd, jpeg, 0, jpeg.length, frames[current].offset);
				loaded = current;
			}
			if (!ffmpeg.stdin.write(jpeg)) await Promise.race([once(ffmpeg.stdin, 'drain'), exited]);
		}
	} finally {
		fs.closeSync(fd);
		ffmpeg.stdin.end();
	}
	const code = await exited;
	if (code !== 0) throw new Error(`ffmpeg failed with exit code ${code}`);
}

// Wall-clock time of the page's first paint, or null if Chromium didn't report one.
async function firstPaintTime(page) {
	return page.evaluate(() => {
		const entry = performance.getEntriesByName('first-paint')[0];
		return entry ? performance.timeOrigin + entry.startTime : null;
	});
}

// Runs inside the page. Position is derived from elapsed time rather than a fixed step
// per tick, so the speed stays constant even when frames are dropped.
function scrollToBottom(speed) {
	return new Promise((resolve) => {
		const startY = window.scrollY;
		let startTime;
		const step = (now) => {
			startTime ??= now;
			// Re-read every frame: lazy-loaded content can make the page taller mid-scroll.
			const maxY = document.documentElement.scrollHeight - window.innerHeight;
			const y = Math.min(startY + (speed * (now - startTime)) / 1000, maxY);
			// 'instant' overrides any `scroll-behavior: smooth` on the page, which would lag behind.
			window.scrollTo({ top: y, behavior: 'instant' });
			if (y >= maxY) resolve();
			else requestAnimationFrame(step);
		};
		requestAnimationFrame(step);
	});
}

async function record({ target, output, width, height, speed, fps, startDelay, endDelay, keepLoading, gpu, headed }) {
	const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scroll-record-'));
	const framesFile = path.join(tempDir, 'frames.mjpeg');
	try {
		const browser = await chromium.launch({
			// The full Chromium build, in both modes: the default headless shell stays uneven even
			// with GPU flags.
			channel: 'chromium',
			headless: !headed,
			args: gpu ? GPU_ARGS : []
		});
		let capture, clipStart, clipEnd;
		try {
			const page = await browser.newPage({ viewport: { width, height } });
			const captureStart = Date.now();
			capture = await startCapture(page, { width, height }, framesFile);

			console.log(`Loading ${target}`);
			await page.goto(target, { waitUntil: 'networkidle' });
			await page.addStyleTag({
				content: '::-webkit-scrollbar { display: none; } html { scrollbar-width: none; }'
			});
			await page.evaluate(async () => { await document.fonts.ready; });

			// Everything drawn before clipStart is the page loading, and gets left out.
			clipStart = keepLoading ? (await firstPaintTime(page)) ?? captureStart : Date.now();
			await page.waitForTimeout(startDelay);

			console.log(`Scrolling at ${speed}px/s`);
			await page.evaluate(scrollToBottom, speed);
			await page.waitForTimeout(endDelay);
			clipEnd = Date.now();
			await capture.stop();
		} finally {
			// Closed before encoding so Chromium isn't competing with ffmpeg for CPU.
			await browser.close();
		}

		console.log(`Encoding ${fps} fps video`);
		await encode(capture.frames, framesFile, output, { clipStart, clipEnd, fps });
	} finally {
		fs.rmSync(tempDir, { recursive: true, force: true });
	}
}

let args;
try {
	args = parseArgs({
		allowPositionals: true,
		options: {
			output: { type: 'string', short: 'o' },
			speed: { type: 'string', short: 's' },
			fps: { type: 'string' },
			width: { type: 'string' },
			height: { type: 'string' },
			'start-delay': { type: 'string' },
			'end-delay': { type: 'string' },
			'keep-loading': { type: 'boolean' },
			gpu: { type: 'boolean' },
			headed: { type: 'boolean' },
			help: { type: 'boolean', short: 'h' },
			version: { type: 'boolean', short: 'v' }
		}
	});
} catch (err) {
	fail(`${err.message}\nRun "scroll-record --help" for usage.`);
}

const { values: opts, positionals } = args;

if (opts.help) {
	console.log(HELP);
	process.exit(0);
}
if (opts.version) {
	const pkg = JSON.parse(fs.readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
	console.log(pkg.version);
	process.exit(0);
}
if (positionals.length !== 1) {
	fail(`expected exactly one URL, got ${positionals.length}\nRun "scroll-record --help" for usage.`);
}

const target = resolveTarget(positionals[0]);
let targetUrl;
try {
	targetUrl = new URL(target);
} catch {
	fail(`not a valid URL: "${positionals[0]}"`);
}

const output = path.resolve(opts.output ?? defaultOutputName(targetUrl));
const ext = path.extname(output).toLowerCase();
if (ext !== '.mp4' && ext !== '.webm') {
	fail(`output must end in .mp4 or .webm, got "${path.basename(output)}"`);
}

const settings = {
	target,
	output,
	width: Math.round(parseNumber('width', opts.width, DEFAULTS.width)),
	height: Math.round(parseNumber('height', opts.height, DEFAULTS.height)),
	speed: parseNumber('speed', opts.speed, DEFAULTS.speed),
	fps: parseNumber('fps', opts.fps, DEFAULTS.fps),
	startDelay: parseNumber('start-delay', opts['start-delay'], DEFAULTS.startDelay, { allowZero: true }),
	endDelay: parseNumber('end-delay', opts['end-delay'], DEFAULTS.endDelay, { allowZero: true }),
	keepLoading: Boolean(opts['keep-loading']),
	gpu: Boolean(opts.gpu),
	headed: Boolean(opts.headed)
};
if (settings.fps > MAX_FPS) {
	fail(`--fps can be at most ${MAX_FPS}: Chromium doesn't repaint faster than that`);
}
if (!hasFfmpeg()) {
	fail('ffmpeg is required but was not found on your PATH.');
}

fs.mkdirSync(path.dirname(output), { recursive: true });

try {
	await record(settings);
	console.log(`Saved ${output}`);
} catch (err) {
	// Playwright appends a multi-line call log; the first line is the useful part.
	fail(err.message.split('\n')[0]);
}
