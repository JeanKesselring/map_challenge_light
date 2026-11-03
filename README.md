# Switzerland / Light

A fixed, north-up map of sunlight, moonlight, and terrain shadows across Switzerland. Static TypeScript, Three.js, and Astronomy Engine; no backend, API keys, live map services, or downloaded fonts.

## Run locally

Requires Node 22.18+ (24 recommended) and `uv` with Python 3.12 or 3.13.

```sh
npm ci
uv sync
uv run scripts/prepare_terrain.py --download
npm run dev
```

Terrain must be prepared once before viewing the map. The source archives are saved in ignored `local/data/`; only the resulting small files in `public/terrain/` belong in git. Package installs and `--download` need network access. The preparation script otherwise uses only Python's standard library.

If the archives were downloaded separately, use:

```sh
uv run scripts/prepare_terrain.py --elevation /path/to/data.zip --boundary /path/to/swissboundaries3d_2026-01_2056_5728.shp.zip
```

## Terrain and licensing

Sources: [swisstopo DHM25 / 200 m](https://www.swisstopo.admin.ch/en/height-model-dhm25-200m) and [swissBOUNDARIES3D](https://www.swisstopo.admin.ch/en/landscape-model-swissboundaries3d). Pinned URLs, source editions, grid spacing, and mask resolution are in `terrain.sources.json`. **© swisstopo**; derived data require [source attribution](https://www.swisstopo.admin.ch/en/faq-free-geodata), retained on the map and in metadata.

The script selects the Swiss national-territory polygon, preserves enclaves, and samples the height field at 400 m. The output contains:

- `elevation.bin`: unsigned 16-bit little-endian height in metres LN02, rows north to south.
- `mask.png`: a country silhouette in the same grid extent, with no boundary stroke.
- `fallback.png`: static afternoon relief for browsers without WebGL2.
- `metadata.json`: dimensions, spacing, EPSG:21781 bounds, encoding, editions, source hashes, and coverage limitations.

The LV95 boundary is aligned to the LV03 height grid using their grid-origin shift; metre-scale residuals are below the map's sampling resolution. The assets retain available surrounding elevation, but visible terrain and shadow casting are masked to Switzerland, so hidden foreign relief cannot cast phantom shadows onto the backdrop. Missing elevations become zero. Heights are not exaggerated. Buildings, trees, and clouds are excluded.

[Astronomy Engine by Don Cross](https://github.com/cosinekitty/astronomy) is bundled under its MIT license in `vendor/astronomy-engine/`. The upstream [browser build](https://raw.githubusercontent.com/cosinekitty/astronomy/master/source/js/astronomy.browser.min.js), retrieved 2026-11-03, is accompanied by a small ES-module bridge and declarations for the public API used here. Three.js is MIT licensed. Dependency versions and integrity hashes are locked in `package-lock.json`.

Daylight uses [Bird–Riordan SPECTRL2](https://www.nlr.gov/grid/solar-resource/spectral), following [pvlib's implementation](https://github.com/pvlib/pvlib-python/blob/main/pvlib/spectrum/spectrl2.py) (BSD 3-Clause), and the [CIE 1931 2° colour-matching functions](https://doi.org/10.25039/CIE.DS.xvudnb9b) (CIE 2019, CC BY-SA 4.0). Numeric tables are bundled locally; no Python or browser dependency was added. Attribution, table adaptations and license notices ship in [`public/science-notice.txt`](public/science-notice.txt).

## Behavior

The map opens at the current instant, at 1× speed. **Now** restores both. A scrolling ruler below the map shows approximately twelve hours on desktop and six on mobile. Drag, scroll, or tap to select another time; playback holds during scrubbing and resumes at the selected speed on release (150 ms after wheel input ends). Arrow keys move fifteen minutes, Shift+Arrow one hour, and Page Up/Down twenty-four hours. Home/End select the current Swiss day's boundaries; Escape cancels an active scrub.

The date button opens a Swiss-style custom calendar inside a native accessible dialog, with a Monday-first grid, editable year, month navigation, and separate 24-hour time fields. Arrow keys navigate dates, Page Up/Down changes month (hold Shift for a year), and Home/End moves within a week. Apply starts from the selected instant at the selected speed. Cancel and Escape leave playback running. Swiss time always means `Europe/Zurich`, regardless of the visitor's timezone. Spring DST gaps are rejected; repeated autumn times use the earlier occurrence and repeated ruler hours include their timezone. The supported range is 1900–2100; playback stops at its upper bound.

Lighting is calculated at 46.8° N, 8.2° E. Sun and Moon cast separate terrain shadows. A shared linear-RGB palette makes fully lit, level ground match the page background, so slope and cast shadows define the map.

Daylight colours now come from spectral transmission, absorption and scattering through a representative clear atmosphere. SPECTRL2 computes separate direct-normal sunlight and diffuse-horizontal skylight spectra. Their sum on a horizontal, spectrally neutral surface supplies the lit colour; diffuse skylight supplies the shadow colour. The spectra are interpolated onto the CIE integration grid from 360–830 nm at 5 nm intervals, integrated to XYZ, and converted to sRGB with fixed D65 display white. One shared exposure fits lit and shaded colours into the display range, preserving their in-gamut chromaticities and relative brightness. It does not reproduce absolute outdoor brightness or viewer colour adaptation. At low Sun angles, blue skylight can dominate level ground even while the direct beam becomes orange/red. A bounded 0.1° cache interpolates XYZ values during playback.

`atmosphere.json` sets pressure to 95,461 Pa (approximately 500 m elevation), precipitable water to 1.5 cm, ozone to 0.3 atm-cm, aerosol optical depth at 500 nm to 0.1, and the model's rural-aerosol defaults. These are assumptions, not Swiss weather observations. The model uses mean Earth–Sun distance, whose scalar irradiance variation cancels under display exposure. SPECTRL2 is an approximate clear-sky model; accuracy decreases near the horizon. Below 1° the display holds the 1° spectral endpoint and blends into the existing illustrative twilight/night palette. Terrain reflectance, sky obstruction, clouds, live haze and spectral eclipse changes are not modelled. Slope shading and pigment remain illustrative.

Moonlight keeps its artificial 1.3 strength multiplier, linear lunar-phase weighting, altitude gating and eclipse attenuation. Blue night/moon colours remain configurable in `palette.json`; moonless nights stay `#365d90`, with `#214370` shadows and boosted full-moon light reaching `#89add2`. Solar eclipses use uniform approximate dimming from topocentric disc overlap. Attenuation is applied after the clear-sky display exposure, to both the page and terrain, so illumination normalization cannot erase it. An illustrative residual blue floor (`eclipseAmbientFraction` in `palette.json`) prevents black totality. Eclipse dimming fades over the final degree above the horizon to keep the approximate twilight transition continuous. The 12 August 2026 fixture around 20:18 Swiss time is checked at every playback speed. Lunar eclipses use cached event intervals. Neither is a calibrated irradiance prediction.

After changing the daylight model or atmospheric assumptions, regenerate its shared static fallback colours, then the terrain image using cached archives:

```sh
npm run prepare:daylight
uv run scripts/prepare_terrain.py
```

The build checks that the committed fallback colour reference matches the model.

The ruler and odometer-style HH:mm:ss digits follow the animation frame clock. Reels derive their positions from the current simulated instant and never queue animations; jumps and scrubbing snap directly. Reduced-motion preferences disable digit rolling. The terrain renders at up to 30 fps with interpolated astronomy samples and shadow updates on every rendered frame during accelerated playback. If measured rendering work is slow, pixel and shadow-map resolution drop first. The map has no geographic zoom, pan, or rotation. Helvetica Neue falls back to Helvetica and the browser's sans-serif.

Swiss terrain casts onto a separate flat backdrop at zero elevation, covering the complete map viewport. Its unshadowed colour matches the page. The same national alpha mask clips both visible terrain and Three.js's shadow depth pass, so only Swiss relief casts onto the sheet. Vertical walls close the outer border and enclave edges down to the backdrop, with a matching masked bottom cap. These faces cast shadows without writing visible colour or depth in the main map pass. Wall tops split at height-grid and triangle boundaries to meet the roof exactly; nearest-neighbour mask sampling keeps roof, walls and base on one footprint. They are generated once from the existing mask and elevations, without another download. Sun/Moon shadow cameras fit both the terrain and backdrop, including receiver depth; they refresh after resizing. This cartographic extension continues beyond the elevation grid and ends at the viewport. It is not a prediction of shadows on foreign terrain, and foreign relief no longer casts shadows within Switzerland.

Shadow filtering uses a fixed tent pattern with receiver-plane depth correction, rather than a screen-space noise pattern. Shadow projection centres align to texels, and procedural grain fades before it becomes undersampled. These changes target grazing-angle self-shadow banding; the custom filter follows the pinned Three.js PCF interface and fails explicitly if it changes. The visible country mask discards fragments after derivative calculations; the separate depth pass uses Three.js's standard alpha test.

## Verify and publish

```sh
npm test
uv run --locked -m unittest discover -s tests -p 'test_*.py' -v
npm run build
npm run preview
```

The build rejects missing terrain assets and a compressed static site above 5 MB. Tests cover the clock, scrubbing, DST ruler ticks, calendar navigation, odometer carries, palette matching/contrast, astronomical interpolation and eclipses, grid orientation, and terrain export. Spectral checks cover CIE reference integrals, D65 conversion, the vacuum limit, horizon behaviour, haze/pressure effects, direct/diffuse colours, common exposure and smooth interpolation. To validate an alternate build folder, run `node scripts/check-size.mjs path/to/build`.

Before publication, check desktop/mobile layouts, keyboard-only dialog operation, missing-data retry, WebGL2 fallback, a low-angle ridge shadow, and 1000× playback performance on a mid-range device. Test the production build beneath a URL subpath; Vite's relative base keeps scripts and terrain URLs compatible with repository hosting.

Commit the prepared `public/terrain/` assets, then select **Settings → Pages → Build and deployment → GitHub Actions** in the GitHub repository. The included workflow tests and builds on pushes to `main`, then deploys `dist/`. The source archives are not downloaded during normal deployment. No separate Sites hosting account is needed.

### Current verification limits

The official terrain assets and updated static fallback have been generated and validated at 963 × 601 cells. The 77 offline tests cover the simulation, UI models, spectral daylight, eclipse brightness, palette, terrain and shadow-frustum stability. Backdrop checks cover an actual receiver beyond the DEM, grazing-angle receiver depth, desktop/mobile resizing and the shadow-pass mask. Extrusion checks cover under-shell light leakage, roof seams, enclave walls and north-first RGBA mask orientation. The production bundle is 1.11 MB compressed, below the 5 MB limit, with relative asset URLs. The restricted implementation session prevents cleanup of the existing `dist/` directory and localhost preview; isolated Chromium/WebKit cannot launch and the browser access host is unavailable. The bundle is therefore validated in a fresh output directory. Actual shader output—including the reported 11:00/100× banding and exterior shadow appearance—still requires browser verification, along with desktop/mobile interaction and GPU performance. The spectral port has analytic and reference-data checks, but has not been independently validated against measured Swiss spectra.
