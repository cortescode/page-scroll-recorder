# page-scroll-recorder

`scroll-record` is a command-line tool that opens a web page in a headless browser and records a smooth, steady scroll from the top of the page to the bottom as a 60 fps `.mp4` or `.webm` video. It's handy for portfolio clips, product demos and README previews.

By default, the page-loading frames are trimmed off, so the video starts on the fully rendered page. To keep a loading or intro animation, use `--keep-loading`.

## Requirements

| Dependency | Why | Install |
| --- | --- | --- |
| **Node.js 20+** | Runs the tool | [nodejs.org](https://nodejs.org) or `nvm install 20` |
| **Playwright** + its Chromium build | Loads and records the page | Installed by `npm install` (see below) |
| **ffmpeg** | Encodes the video | `sudo pacman -S ffmpeg` · `sudo apt install ffmpeg` · `brew install ffmpeg` |

You don't need a graphics card. Pages are rendered in software by default. The optional `--gpu` flag uses one if it's there (see [Smoothness](#smoothness)).

## Installation

From this folder:

```sh
npm install
npx playwright install chromium   # one-time browser download
npm link                          # makes `scroll-record` available everywhere
```

On Debian/Ubuntu, if Chromium fails to launch because of missing system libraries, run `npx playwright install --with-deps chromium` instead.

`npm link` points the global command at this folder, so edits to `record.js` take effect immediately. To remove the global command, run `npm unlink -g page-scroll-recorder`. You can also skip linking and run `node record.js <url> [options]` from this folder.

## Usage

```sh
scroll-record <url> [options]
```

`<url>` can be:

- a full URL: `https://example.com/pricing`
- a bare domain: `example.com` (https is added for you)
- a local dev server: `localhost:5173` (http is added for you)
- a path to an HTML file: `./dist/index.html`

### Options

| Option | Default | Description |
| --- | --- | --- |
| `-o, --output <file>` | `<site>-scroll.mp4` | Output file. The extension picks the format: `.mp4` (H.264) or `.webm` (VP9). Missing folders are created. |
| `-s, --speed <px/s>` | `200` | Scroll speed in pixels per second. |
| `--fps <n>` | `60` | Frames per second, up to 60. |
| `--width <px>` | `1920` | Viewport width. The video has the same size. |
| `--height <px>` | `1080` | Viewport height. The video has the same size. |
| `--start-delay <ms>` | `1500` | How long to hold on the top of the page before scrolling. |
| `--end-delay <ms>` | `1500` | How long to hold on the bottom of the page after scrolling. |
| `--keep-loading` | off | Start the video when the page first paints instead of once it has fully loaded, keeping any loading or intro animation. |
| `--gpu` | off | Render on the GPU. Smoother on heavy pages; falls back to software if no GPU is available. |
| `--headed` | off | Show the browser window while recording. |
| `-h, --help` | | Show help. |
| `-v, --version` | | Show the version. |

### Examples

```sh
# Record a live site → example-com-scroll.mp4
scroll-record example.com

# Record your dev server, faster, to a chosen file
scroll-record localhost:5173 -o demo.mp4 --speed 300

# Mobile-sized recording of a specific page
scroll-record https://example.com/pricing --width 390 --height 844 -o mobile.webm

# Keep the site's intro animation at the start
scroll-record localhost:5173 --keep-loading

# A heavy page (background video, blur effects), rendered on the GPU
scroll-record example.com --gpu

# A built static site, no pauses at the top or bottom
scroll-record ./dist/index.html --start-delay 0 --end-delay 0

# Watch what the browser is doing
scroll-record localhost:3000 --headed
```

## Output

If you don't pass `-o`, the file is written to the current folder with a name based on the URL:

| Input | Output file |
| --- | --- |
| `example.com` | `example-com-scroll.mp4` |
| `https://example.com/pricing` | `example-com-pricing-scroll.mp4` |
| `localhost:5173` | `localhost-5173-scroll.mp4` |
| `./dist/index.html` | `index-scroll.mp4` |

An existing file with the same name is overwritten without asking.

The video length is:

```
start-delay + (page height − viewport height) / speed + end-delay
```

For example, a 5,000 px page in a 1080 px viewport at the default speed gives 1.5 s + 19.6 s + 1.5 s ≈ 22.6 s. To get a shorter video, raise `--speed`.

### Smoothness

Each video frame is a real repaint of the page, and Chromium repaints at most 60 times per second, so 60 fps is the maximum.

If Chromium takes longer than 1/60 s to draw a frame, it skips that repaint. The video shows the previous frame again, and the next frame jumps two steps: a small hitch. Simple pages don't hit this. On heavy pages (background videos, blur effects, large gradients) at 1080p, software rendering can miss around one repaint in ten. There are two ways to fix it:

- `--gpu` renders on the graphics card: dedicated or integrated, as long as it has working drivers (Vulkan on Linux). On a page that missed about 11% of repaints in software, `--gpu` missed 0–1 per recording. Without a usable GPU it quietly falls back to software.
- A smaller viewport (`--width`/`--height`) means less to draw per frame.

### Keeping the loading animation

`--keep-loading` starts the video at the page's first paint. It skips only the blank white frames from before the page drew anything, and keeps everything after that: loaders, fade-ins, entrance animations. The start delay still counts from when the page has fully loaded, so a slow page gives a longer intro.

The recording browser starts with an empty cache on every run, so it sees the page the way a first-time visitor does. That includes any web-font swap. If your fonts use `font-display: swap` and arrive after the first paint, the text first appears in the fallback font and then switches. Without `--keep-loading` this never shows, because the video starts after fonts have loaded.

## How it works

1. Opens the page in headless Chromium and starts capturing every repaint, each stamped with the time it was drawn.
2. Waits until the network is idle and the web fonts have loaded, then hides the scrollbar so it doesn't show up in the video.
3. Holds on the top of the page, then scrolls at a constant speed until it reaches the bottom. If more content loads during the scroll (lazy loading), the scroll keeps going until the real end of the page.
4. Holds on the bottom of the page and closes the browser.
5. Lays the captured repaints on an exact 60 fps (or `--fps`) timeline running from the fully loaded page (or its first paint, with `--keep-loading`) to the end of the final hold, and encodes it with ffmpeg.

## Limitations

- **Infinite-scroll pages** never reach the bottom, so the recording never stops. Press Ctrl+C to cancel.
- **Pages that scroll an inner element** (for example `body { overflow: hidden }` with a scrolling `<div>`) won't move, because the tool scrolls the window.
- **Pages that never go network-idle** (constant polling or streaming requests) fail with a timeout after 30 seconds.
