Experimental CSS 3D spinner for a secret [Mmuseumm](https://mmuseumm.com) project.

## Capture smooth loops

The capture script pauses every CSS animation at exact frame times, captures
transparent PNG frames through Chrome DevTools Protocol, and encodes the full
delivery set. It excludes the duplicate frame at 10 seconds so every format
can repeat without a hitch.

Requirements: Node.js, Google Chrome or Chromium, and FFmpeg.

```sh
node scripts/capture-animation.mjs
```

This writes:

- `output/book-spinner.gif`: transparent GIF, 24 fps and 1200 pixels tall
- `output/book-spinner.png`: transparent full-alpha animated PNG, 24 fps and
  1200 pixels tall
- `output/book-spinner-red.gif`: 1200×1200 GIF on the site red
- `output/book-spinner-red.png`: 1200×1200 animated PNG on the site red
- `output/book-spinner-red.mp4`: 1200×1200, 60 fps H.264 video on the site red

The red outputs use `#fd2224`. They contain only the spinner; the surrounding
marketing copy, including “MMUSEUMM 2020,” is hidden by the capture page. The
MP4 uses broadly compatible `yuv420p` video and is prepared for fast web
start. Like any MP4, its player controls whether playback repeats; its first
and last frames are sampled so repeating it is seamless.

The loop duration is read from the CSS animation. The script captures at the
highest requested output rate (60 fps by default), derives the GIF and APNG at
24 fps, measures the book throughout the complete rotation, and uses the same
bounds for every output frame. Transparent outputs retain 10% margin on each
side. Square outputs preserve that complete view, center it, and fill the rest
of the 1200×1200 canvas with red.

Useful options include `--fps`, `--video-fps`, `--duration`, `--height`,
`--square-size`, `--background`, `--margin`, `--padding`, and `--keep-frames`.
Use `--no-apng`, `--no-red`, or `--no-mp4` to skip output groups. Run with
`--help` for the complete list.

The source defaults to `index.html`, falling back to `text.html` when the
former is absent. Pass `--source path/to/page.html` to select another page.

The GIF has native GIF transparency (one-bit alpha), with no chroma key. The
transparent APNG uses the same frames but preserves full alpha around
antialiased edges.
