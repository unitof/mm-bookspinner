Experimental CSS 3D spinner for a secret [Mmuseumm](https://mmuseumm.com) project.

## Capture a smooth loop

The capture script pauses every CSS animation at exact frame times, captures
transparent PNGs through Chrome DevTools Protocol, and encodes them with a
single global GIF palette. It excludes the duplicate frame at 10 seconds so
the result loops without a hitch.

Requirements: Node.js, Google Chrome or Chromium, and FFmpeg.

```sh
node scripts/capture-animation.mjs \
  --output output/book-spinner.gif \
  --apng output/book-spinner.png
```

The loop duration is read from the CSS animation; capture defaults to 24 fps
in a 1200-pixel viewport. Useful options include `--fps`, `--duration`,
`--viewport`, `--scale`, `--padding`, and `--keep-frames`. Run with `--help`
for the complete list.

The GIF has native GIF transparency (one-bit alpha), with no chroma key. The
optional APNG uses the same frames but preserves full alpha around antialiased
edges.
