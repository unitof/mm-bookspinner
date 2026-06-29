#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.cwd();
const options = parseArguments(process.argv.slice(2));
const chromePath = options.chrome ?? findChrome();
const workDirectory = await mkdtemp(path.join(tmpdir(), 'mm-bookspinner-'));
const frameDirectory = path.join(workDirectory, 'frames');
const profileDirectory = path.join(workDirectory, 'chrome-profile');

let chrome;
let chromeStderr = '';

try {
  console.log('Preparing capture workspace...');
  await mkdir(frameDirectory, { recursive: true });
  await mkdir(profileDirectory, { recursive: true });

  const pageUrl = await createCapturePage(root, workDirectory);

  console.log('Starting Chrome...');
  chrome = spawn(chromePath, [
    '--headless=new',
    '--disable-gpu',
    '--hide-scrollbars',
    '--no-first-run',
    '--no-default-browser-check',
    '--allow-file-access-from-files',
    '--remote-debugging-port=0',
    `--user-data-dir=${profileDirectory}`,
    'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  chrome.stderr.setEncoding('utf8');
  chrome.stderr.on('data', chunk => {
    chromeStderr += chunk;
  });

  let debuggingPort;
  try {
    debuggingPort = await waitForDebuggingPort(profileDirectory, chrome);
  } catch (error) {
    if (chromeStderr.trim()) console.error(chromeStderr.trim());
    throw error;
  }
  const page = await createPage(debuggingPort);
  const cdp = await connectCdp(page.webSocketDebuggerUrl);

  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: options.viewport,
    height: options.viewport,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await cdp.send('Emulation.setDefaultBackgroundColorOverride', {
    color: { r: 0, g: 0, b: 0, a: 0 },
  });

  console.log('Loading the spinner...');
  await cdp.send('Page.navigate', { url: pageUrl });
  await waitForDocument(cdp);
  await evaluate(cdp, `
    document.documentElement.style.background = 'transparent';
    document.body.style.setProperty('background', 'transparent', 'important');

    const captureStyle = document.createElement('style');
    captureStyle.textContent = \`
      #floating-home,
      .takeover > p,
      .book-features,
      .book-spinner figcaption,
      .book-section > .box-link,
      body > .takeover:last-of-type {
        visibility: hidden !important;
      }

      .book-spinner .scene {
        margin: 200px !important;
      }
    \`;
    document.head.append(captureStyle);

    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  `);

  const cssDuration = await evaluate(cdp, `
    const animation = document.querySelector('.book-spinner .case').getAnimations()[0];
    return animation?.effect.getTiming().duration / 1000;
  `);
  const duration = options.duration ?? cssDuration;
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new Error('Could not determine the CSS animation duration; pass --duration explicitly.');
  }
  const frameCount = Math.round(duration * options.fps);

  console.log('Measuring the complete rotation...');
  let bounds;
  for (let frame = 0; frame < frameCount; frame += 1) {
    const time = frame * 1000 / options.fps;
    await setAnimationTime(cdp, time);
    bounds = unionBounds(bounds, await measureBook(cdp));
  }
  const clip = paddedClip(bounds, options.margin, options.padding, options.height);

  for (let frame = 0; frame < frameCount; frame += 1) {
    const time = frame * 1000 / options.fps;
    await setAnimationTime(cdp, time);

    const screenshot = await cdp.send('Page.captureScreenshot', {
      format: 'png',
      fromSurface: true,
      captureBeyondViewport: true,
      clip,
    });
    const filename = `frame-${String(frame).padStart(4, '0')}.png`;
    await writeFile(path.join(frameDirectory, filename), Buffer.from(screenshot.data, 'base64'));

    if ((frame + 1) % options.fps === 0 || frame + 1 === frameCount) {
      process.stdout.write(`Captured ${frame + 1}/${frameCount} frames\r`);
    }
  }
  process.stdout.write('\n');
  cdp.close();

  await encodeGif(frameDirectory, options.output, options.fps);
  console.log(`GIF: ${options.output}`);

  if (options.apng) {
    await encodeApng(frameDirectory, options.apng, options.fps);
    console.log(`APNG: ${options.apng}`);
  }

  if (options.keepFrames) {
    const destination = path.resolve(options.keepFrames);
    await rm(destination, { recursive: true, force: true });
    await mkdir(path.dirname(destination), { recursive: true });
    const { cp } = await import('node:fs/promises');
    await cp(frameDirectory, destination, { recursive: true });
    console.log(`Frames: ${destination}`);
  }
} finally {
  await stopProcess(chrome);
  await rm(workDirectory, { recursive: true, force: true });
}

function parseArguments(args) {
  const values = {
    fps: 24,
    duration: null,
    viewport: 1600,
    height: 1200,
    margin: 0.1,
    padding: 0,
    output: path.resolve('output/book-spinner.gif'),
    apng: null,
    keepFrames: null,
    chrome: null,
  };

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--help' || argument === '-h') {
      console.log(`Usage: node scripts/capture-animation.mjs [options]

Options:
  --output <file>       GIF destination (default: output/book-spinner.gif)
  --apng <file>         Also write a full-alpha APNG
  --fps <number>        Frames per second (default: 24)
  --duration <seconds>  Loop duration override (default: read from CSS)
  --viewport <pixels>   Square layout viewport (default: 1600)
  --height <pixels>     Final animation height (default: 1200)
  --margin <fraction>   Margin per side, relative to book size (default: 0.1)
  --padding <pixels>    Additional pre-scale padding per side (default: 0)
  --keep-frames <dir>   Preserve the transparent PNG frame sequence
  --chrome <path>       Chrome/Chromium executable override
`);
      process.exit(0);
    }

    const value = args[index + 1];
    if (!value) throw new Error(`Missing value for ${argument}`);
    index += 1;

    if (argument === '--output') values.output = path.resolve(value);
    else if (argument === '--apng') values.apng = path.resolve(value);
    else if (argument === '--fps') values.fps = positiveNumber(value, argument);
    else if (argument === '--duration') values.duration = positiveNumber(value, argument);
    else if (argument === '--viewport') values.viewport = positiveNumber(value, argument);
    else if (argument === '--height') values.height = positiveNumber(value, argument);
    else if (argument === '--margin') values.margin = nonnegativeNumber(value, argument);
    else if (argument === '--padding') values.padding = nonnegativeNumber(value, argument);
    else if (argument === '--keep-frames') values.keepFrames = value;
    else if (argument === '--chrome') values.chrome = value;
    else throw new Error(`Unknown option: ${argument}`);
  }

  if (!Number.isInteger(values.fps)) throw new Error('--fps must be an integer');
  if (!Number.isInteger(values.viewport)) throw new Error('--viewport must be an integer');
  if (!Number.isInteger(values.height)) throw new Error('--height must be an integer');
  return values;
}

function positiveNumber(value, option) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) throw new Error(`${option} must be greater than zero`);
  return number;
}

function nonnegativeNumber(value, option) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) throw new Error(`${option} cannot be negative`);
  return number;
}

function findChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ].filter(Boolean);
  const found = candidates.find(existsSync);
  if (!found) {
    throw new Error('Chrome or Chromium was not found. Set CHROME_PATH or pass --chrome.');
  }
  return found;
}

async function createCapturePage(directory, temporaryDirectory) {
  const source = await readFile(path.join(directory, 'index.html'), 'utf8');
  const imageBase = `${pathToFileURL(path.join(directory, 'img')).href}/`;
  const captureSource = source.replaceAll('url(/img/', `url(${imageBase}`);
  const filename = path.join(temporaryDirectory, 'capture.html');
  await writeFile(filename, captureSource);
  return pathToFileURL(filename).href;
}

async function waitForDebuggingPort(directory, processHandle) {
  const filename = path.join(directory, 'DevToolsActivePort');
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (processHandle.exitCode !== null) throw new Error('Chrome exited before opening a debugging port');
    try {
      const [port] = (await readFile(filename, 'utf8')).split('\n');
      if (port) return Number(port);
    } catch {
      // Chrome has not written the port file yet.
    }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('Timed out waiting for Chrome');
}

async function createPage(port) {
  const response = await fetch(`http://127.0.0.1:${port}/json/new?about%3Ablank`, {
    method: 'PUT',
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw new Error(`Chrome could not create a page: ${response.status}`);
  return response.json();
}

async function waitForDocument(cdp) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const ready = await evaluate(cdp, `
        return document.readyState !== 'loading' && Boolean(document.querySelector('.book-spinner .scene'));
      `);
      if (ready) {
        await new Promise(resolve => setTimeout(resolve, 250));
        return;
      }
    } catch {
      // The navigation may still be replacing the previous execution context.
    }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('Timed out waiting for the spinner document');
}

async function connectCdp(webSocketUrl) {
  const socket = new WebSocket(webSocketUrl);
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Timed out connecting to Chrome')), 5000);
    socket.addEventListener('open', () => {
      clearTimeout(timeout);
      resolve();
    }, { once: true });
    socket.addEventListener('error', error => {
      clearTimeout(timeout);
      reject(error);
    }, { once: true });
  });

  let messageId = 0;
  const pending = new Map();

  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    if (message.id) {
      const promise = pending.get(message.id);
      pending.delete(message.id);
      if (!promise) return;
      clearTimeout(promise.timeout);
      if (message.error) promise.reject(new Error(message.error.message));
      else promise.resolve(message.result);
    }
  });

  return {
    send(method, params = {}) {
      const id = ++messageId;
      socket.send(JSON.stringify({ id, method, params }));
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`Timed out waiting for ${method}`));
        }, 10000);
        pending.set(id, { resolve, reject, timeout });
      });
    },
    close() {
      socket.close();
    },
  };
}

async function evaluate(cdp, expression) {
  const result = await cdp.send('Runtime.evaluate', {
    expression: `(async () => { ${expression} })()`,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
  return result.result.value;
}

async function setAnimationTime(cdp, time) {
  await evaluate(cdp, `
    document.getAnimations().forEach(animation => {
      animation.pause();
      animation.currentTime = ${time};
    });
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  `);
}

async function measureBook(cdp) {
  return evaluate(cdp, `
    const rectangles = Array.from(document.querySelectorAll('.book-spinner .surface'))
      .map(surface => surface.getBoundingClientRect())
      .filter(rectangle => rectangle.width > 0 && rectangle.height > 0);
    return {
      left: Math.min(...rectangles.map(rectangle => rectangle.left)),
      top: Math.min(...rectangles.map(rectangle => rectangle.top)),
      right: Math.max(...rectangles.map(rectangle => rectangle.right)),
      bottom: Math.max(...rectangles.map(rectangle => rectangle.bottom)),
    };
  `);
}

function unionBounds(a, b) {
  if (!a) return b;
  return {
    left: Math.min(a.left, b.left),
    top: Math.min(a.top, b.top),
    right: Math.max(a.right, b.right),
    bottom: Math.max(a.bottom, b.bottom),
  };
}

function paddedClip(bounds, margin, padding, outputHeight) {
  const width = bounds.right - bounds.left;
  const height = bounds.bottom - bounds.top;
  const horizontalPadding = width * margin + padding;
  const verticalPadding = height * margin + padding;
  const clipHeight = height + verticalPadding * 2;

  return {
    x: bounds.left - horizontalPadding,
    y: bounds.top - verticalPadding,
    width: width + horizontalPadding * 2,
    height: clipHeight,
    scale: outputHeight / clipHeight,
  };
}

async function encodeGif(frames, output, fps) {
  await mkdir(path.dirname(output), { recursive: true });
  await run('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-framerate', String(fps),
    '-i', path.join(frames, 'frame-%04d.png'),
    '-filter_complex',
    'split[frames][palette_input];[palette_input]palettegen=reserve_transparent=1:transparency_color=ffffff[palette];[frames][palette]paletteuse=dither=sierra2_4a:alpha_threshold=128',
    '-loop', '0',
    output,
  ]);
}

async function encodeApng(frames, output, fps) {
  await mkdir(path.dirname(output), { recursive: true });
  await run('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-framerate', String(fps),
    '-i', path.join(frames, 'frame-%04d.png'),
    '-plays', '0',
    '-f', 'apng',
    output,
  ]);
}

async function run(command, args) {
  const child = spawn(command, args, { stdio: 'inherit' });
  const exitCode = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', resolve);
  });
  if (exitCode !== 0) throw new Error(`${command} exited with code ${exitCode}`);
}

async function stopProcess(processHandle) {
  if (!processHandle || processHandle.exitCode !== null) return;
  processHandle.kill('SIGTERM');
  await Promise.race([
    new Promise(resolve => processHandle.once('exit', resolve)),
    new Promise(resolve => setTimeout(resolve, 2000)),
  ]);
}
