import { test } from 'node:test';
import assert from 'node:assert/strict';
import atmosphere from '../atmosphere.json' with { type: 'json' };
import bird from '../src/data/bird-spectrum.json' with { type: 'json' };
import fallback from '../src/data/daylight-fallback.json' with { type: 'json' };
import {
  daylightColors, daylightSpectrum, linearRGBToHex, modelDaylight, relativeAirMass,
  spectrumToXYZ, xyzToLinearRGB,
} from '../src/daylight.ts';
import { FALLBACK_PALETTE, rgb } from '../src/palette.ts';

test('CIE integration agrees with equal-energy white and D65 maps to neutral sRGB', () => {
  // Official 1 nm table sums from CIE dataset metadata; allow 5 nm quadrature error.
  const equalEnergy = spectrumToXYZ(bird.wavelength.map(() => 1));
  const reference = [106.865469489595, 106.8569171011719, 106.892251278636];
  equalEnergy.forEach((channel, i) => assert.ok(Math.abs(channel - reference[i]) < 0.001));
  const d65 = xyzToLinearRGB([0.9504559270516716, 1, 1.0890577507598784]);
  for (const channel of d65) assert.ok(Math.abs(channel - 1) < 1e-12);
  assert.equal(linearRGBToHex([1, 1, 1]), '#ffffff');
  assert.equal(linearRGBToHex([0.5, 0.5, 0.5]), '#bcbcbc');
});

test('a vacuum transmits the extraterrestrial spectrum with no diffuse light', () => {
  const vacuum = { ...atmosphere, pressurePa: 0, precipitableWaterCm: 0,
    ozoneAtmCm: 0, aerosolOpticalDepth500: 0, groundAlbedo: 0 };
  const spectrum = daylightSpectrum(45, vacuum);
  assert.deepEqual(spectrum.direct, bird.extraterrestrial);
  assert.ok(spectrum.diffuse.every(value => value === 0));
});

test('airmass and all spectral components stay finite near the horizon', () => {
  assert.ok(Math.abs(relativeAirMass(90) - 1) < 0.001);
  assert.ok(relativeAirMass(0) > 37 && relativeAirMass(0) < 39);
  for (const altitude of [1e-8, 0.1, 1, 5, 20, 45, 90]) {
    const spectrum = daylightSpectrum(altitude);
    spectrum.direct.forEach((value, i) => assert.ok(value >= 0 && value <= bird.extraterrestrial[i]));
    assert.ok(spectrum.diffuse.every(value => Number.isFinite(value) && value >= 0));
  }
  for (const altitude of [-90, -12, -0.01, 0]) {
    assert.deepEqual(modelDaylight(altitude), { direct: [0, 0, 0], diffuse: [0, 0, 0], global: [0, 0, 0] });
  }
  for (const altitude of [NaN, Infinity, -91, 91]) assert.throws(() => modelDaylight(altitude), RangeError);
});

test('longer atmospheric paths redden direct sunlight and lower its illuminance', () => {
  const low = modelDaylight(5), high = modelDaylight(60);
  const lowRGB = xyzToLinearRGB(low.direct), highRGB = xyzToLinearRGB(high.direct);
  assert.ok(lowRGB[2] / lowRGB[0] < highRGB[2] / highRGB[0]);
  assert.ok(low.direct[1] < high.direct[1] && low.global[1] < high.global[1]);
  // Photopic daylight on level ground should be in the outdoor daylight range.
  const lux = modelDaylight(45).global[1] * 683;
  assert.ok(lux > 60_000 && lux < 120_000);
});

test('rural haze reddens the direct beam while reduced pressure transmits more blue', () => {
  const base = xyzToLinearRGB(modelDaylight(15).direct);
  const haze = xyzToLinearRGB(modelDaylight(15, { ...atmosphere, aerosolOpticalDepth500: 0.3 }).direct);
  const mountain = xyzToLinearRGB(modelDaylight(15, { ...atmosphere, pressurePa: 70_000 }).direct);
  assert.ok(haze[2] / haze[0] < base[2] / base[0]);
  assert.ok(mountain[2] / mountain[0] > base[2] / base[0]);
});

test('direct sunlight is warm and clear-sky diffuse illumination is blue', () => {
  const model = modelDaylight(45);
  const beam = xyzToLinearRGB(model.direct), sky = xyzToLinearRGB(model.diffuse);
  assert.ok(beam[0] > beam[1] && beam[1] > beam[2]);
  assert.ok(sky[2] > sky[1] && sky[1] > sky[0]);
  const shadow = rgb(daylightColors(45).shadow);
  assert.ok(shadow[2] > shadow[1] && shadow[1] > shadow[0]);
});

test('lit and shadow colours use one exposure, preserving the direct/diffuse ratio', () => {
  const decode = (hex: string) => rgb(hex).map(v => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  for (const altitude of [1, 5, 15, 45, 90]) {
    const model = modelDaylight(altitude), colors = daylightColors(altitude);
    const lit = xyzToLinearRGB(model.global), shade = xyzToLinearRGB(model.diffuse);
    const displayedLit = decode(colors.background), displayedShade = decode(colors.shadow);
    for (let i = 0; i < 3; i++) {
      assert.ok(Math.abs(displayedShade[i] / displayedLit[i] - shade[i] / lit[i]) < 0.02);
    }
  }
});

test('cached colour interpolation is smooth and static fallback uses the same model', () => {
  for (let angle = 1; angle < 90; angle += 0.1) {
    const before = daylightColors(angle), after = daylightColors(angle + 0.001);
    for (const key of ['background', 'shadow'] as const) {
      const a = rgb(before[key]), b = rgb(after[key]);
      assert.ok(a.every((value, i) => Math.abs(value - b[i]) <= 1.01 / 255));
    }
  }
  assert.equal(fallback.background, FALLBACK_PALETTE.background);
  assert.equal(fallback.shadow, FALLBACK_PALETTE.shadow);
  assert.deepEqual(daylightColors(-12), daylightColors(1));
});
