import './style.css';
import { SimulationClock } from './clock.ts';
import type { Speed } from './clock.ts';
import { CalendarPopup } from './calendar.ts';
import { FALLBACK_PALETTE, paletteFor } from './palette.ts';
import type { LightingPalette } from './palette.ts';
import { RollingClock } from './rolling-clock.ts';
import { SkySampler } from './sky-sampler.ts';
import { Timeline } from './timeline.ts';
import type { TerrainRenderer } from './renderer.ts';

function element<T extends HTMLElement>(id: string): T {
  const result = document.getElementById(id);
  if (!result) throw new Error(`Missing interface element: ${id}`);
  return result as T;
}

const map = element('map');
const status = element('status');
const statusText = element('status-text');
const retry = element<HTMLButtonElement>('retry');
const fallback = element<HTMLImageElement>('fallback');
const editTime = element<HTMLButtonElement>('edit-time');
const nowButton = element<HTMLButtonElement>('now');
const speedButtons = [...document.querySelectorAll<HTMLButtonElement>('[data-speed]')];
const clock = new SimulationClock();
const sky = new SkySampler();
const rolling = new RollingClock(element<HTMLTimeElement>('timestamp'), editTime, element('timezone'));
const timeline = new Timeline(element('timeline'), clock, refresh);
const calendar = new CalendarPopup(element<HTMLDialogElement>('time-dialog'), editTime, epoch => {
  timeline.finish(); clock.setTime(epoch); refresh();
});
let terrain: TerrainRenderer | undefined;
let lastDraw = -Infinity;
let lastShadow = -Infinity;
let animation = 0;
let loading = false;
let lastBackground = '';
let lastInk = '';
let lastAccent = '';

function applyPalette(palette: LightingPalette): void {
  const style = document.documentElement.style;
  if (palette.background !== lastBackground) {
    style.setProperty('--page', palette.background);
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', palette.background);
    lastBackground = palette.background;
  }
  if (palette.ink !== lastInk) {
    style.setProperty('--ink', palette.ink);
    lastInk = palette.ink;
  }
  if (palette.accent !== lastAccent) {
    style.setProperty('--accent', palette.accent);
    lastAccent = palette.accent;
  }
}

function refresh(): void {
  sky.invalidate();
  rolling.snap();
  lastDraw = -Infinity;
  lastShadow = -Infinity;
  for (const button of speedButtons) button.setAttribute('aria-pressed', String(+button.dataset.speed! === clock.speed));
}

nowButton.addEventListener('click', () => { timeline.finish(); clock.reset(); refresh(); });
for (const button of speedButtons) button.addEventListener('click', () => {
  timeline.finish(); clock.setSpeed(+button.dataset.speed! as Speed); refresh();
});
editTime.addEventListener('click', () => { timeline.finish(); calendar.open(clock.now()); });

function showStatic(message: string): void {
  terrain?.dispose(); terrain = undefined;
  for (const button of [...speedButtons, editTime, nowButton]) button.disabled = true;
  timeline.setDisabled(true);
  applyPalette(FALLBACK_PALETTE);
  const reveal = () => { fallback.hidden = false; status.classList.add('compatibility'); };
  fallback.onload = reveal;
  fallback.onerror = () => {
    fallback.hidden = true; status.classList.remove('compatibility');
    statusText.textContent = 'The static map could not be loaded. Please reload to retry.';
    map.setAttribute('aria-label', 'Map unavailable');
  };
  if (fallback.complete && fallback.naturalWidth > 0) reveal();
  else if (fallback.complete || !fallback.getAttribute('src')) fallback.src = `${import.meta.env.BASE_URL}terrain/fallback.png`;
  status.hidden = false; statusText.textContent = message;
  map.setAttribute('aria-label', 'Static afternoon terrain relief of Switzerland');
}

async function load(): Promise<void> {
  if (loading) return;
  loading = true; status.hidden = false; statusText.textContent = 'Loading terrain…'; retry.hidden = true;
  status.classList.remove('compatibility');
  fallback.hidden = false;
  applyPalette(FALLBACK_PALETTE);
  let preparing = false;
  let candidate: TerrainRenderer | undefined;
  try {
    if (typeof WebGL2RenderingContext === 'undefined') {
      showStatic('Live light needs WebGL2. Showing a static afternoon map.'); return;
    }
    // Keep the preview/UI independent of downloading the large GPU module.
    // WebGLRenderer creates the only context; a throwaway probe doubled setup.
    const { TerrainRenderer } = await import('./renderer.ts');
    candidate = await TerrainRenderer.load(map, () => {
      preparing = true; statusText.textContent = 'Preparing live lighting…';
    });
    candidate.update(sky.at(clock.now(), clock.speed));
    await candidate.prepare();
    // Use the current instant after compilation; normal frames only start once ready.
    const light = sky.at(clock.now(), clock.speed);
    candidate.update(light);
    performance.mark('terrain-first-frame-start');
    candidate.draw();
    performance.measure('terrain-first-frame', 'terrain-first-frame-start');
    terrain = candidate; candidate = undefined;
    applyPalette(paletteFor(light));
    fallback.onload = fallback.onerror = null;
    status.hidden = true; fallback.hidden = true;
    for (const button of [...speedButtons, editTime, nowButton]) button.disabled = false;
    timeline.setDisabled(false);
    map.dataset.ready = 'true';
    map.setAttribute('aria-label', 'North-up map of sunlight and moonlight on the mountains of Switzerland');
    refresh();
  } catch {
    candidate?.dispose();
    terrain?.dispose(); terrain = undefined;
    showStatic(preparing
      ? 'Live lighting could not start. Showing a static afternoon map.'
      : 'The live map could not be loaded. Showing a static afternoon map.');
    retry.hidden = false; map.dataset.ready = 'error';
  } finally { loading = false; }
}
retry.addEventListener('click', () => { void load(); });
map.addEventListener('render-failure', () => {
  showStatic('Live rendering was interrupted. Showing a static afternoon map. Reload to retry.');
});

function frame(now: number): void {
  if (document.hidden) return;
  const epoch = clock.now(now);
  rolling.render(epoch, clock.speed, clock.paused);
  timeline.render(epoch);
  if (terrain && now - lastDraw >= 1000 / 30) {
    try {
      const start = performance.now();
      const light = sky.at(epoch, clock.speed);
      const shadows = clock.speed > 1 || clock.paused || now - lastShadow > 500;
      terrain.update(light, shadows);
      applyPalette(paletteFor(light));
      terrain.draw();
      if (shadows) lastShadow = now;
      terrain.measure(performance.now() - start);
      lastDraw = Number.isFinite(lastDraw) ? now - ((now - lastDraw) % (1000 / 30)) : now;
    } catch {
      showStatic('Live rendering was interrupted. Showing a static afternoon map.');
    }
  }
  animation = requestAnimationFrame(frame);
}
document.addEventListener('visibilitychange', () => {
  cancelAnimationFrame(animation);
  if (document.hidden) timeline.finish();
  if (!document.hidden) { refresh(); animation = requestAnimationFrame(frame); }
});
window.addEventListener('pagehide', event => {
  cancelAnimationFrame(animation);
  if (!event.persisted) { timeline.dispose(); terrain?.dispose(); }
});
window.addEventListener('pageshow', event => {
  if (event.persisted) { cancelAnimationFrame(animation); refresh(); animation = requestAnimationFrame(frame); }
});
applyPalette(FALLBACK_PALETTE);
void load();
animation = requestAnimationFrame(frame);
