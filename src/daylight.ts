/*! Bird–Riordan SPECTRL2, adapted from pvlib (BSD-3-Clause).
 * CIE 1931 2° data: CIE 2019, CC BY-SA 4.0. See science-notice.txt. */
import atmosphere from '../atmosphere.json' with { type: 'json' };
import bird from './data/bird-spectrum.json' with { type: 'json' };
import cie from './data/cie-1931.json' with { type: 'json' };

export type Triple = [number, number, number];
export type Atmosphere = Omit<typeof atmosphere, 'displayWhiteLevel'>;
export interface Daylight {
  /** CIE XYZ integrals of W m⁻² nm⁻¹; Y × 683 gives photopic illuminance. */
  direct: Triple;
  diffuse: Triple;
  global: Triple;
}
const RAD = Math.PI / 180;
const zero = (): Triple => [0, 0, 0];

/** Kasten–Young 1989, using apparent altitude, as in NREL's SPECTRL2 code. */
export function relativeAirMass(altitude: number): number {
  return 1 / (Math.sin(altitude * RAD) + 0.50572 * (altitude + 6.07995) ** -1.6364);
}

/** Horizontal clear-sky spectra at mean Earth–Sun distance; no twilight model. */
export function daylightSpectrum(altitude: number, air: Atmosphere = atmosphere) {
  if (!Number.isFinite(altitude) || altitude < -90 || altitude > 90) throw new RangeError('Invalid solar altitude');
  const direct = bird.wavelength.map(() => 0), diffuse = [...direct];
  if (altitude <= 0) return { direct, diffuse };
  const cosZ = Math.sin(altitude * RAD), mass = relativeAirMass(altitude);
  const ozoneMass = (1 + 22 / 6370) / Math.sqrt(cosZ * cosZ + 44 / 6370);
  const alg = Math.log(1 - air.aerosolAsymmetry);
  const bfs = alg * (0.0783 + alg * (-0.3824 - alg * 0.5874));
  const afs = alg * (1.459 + alg * (0.1595 + alg * 0.4129));
  const forward = 1 - 0.5 * Math.exp((afs + bfs * cosZ) * cosZ);
  const forwardPrime = 1 - 0.5 * Math.exp((afs + bfs / 1.8) / 1.8);
  for (let i = 0; i < bird.wavelength.length; i++) {
    const nm = bird.wavelength[i], um = nm / 1000;
    const opticalDepth = air.aerosolOpticalDepth500 * (nm / 500) ** -air.angstromExponent;
    const singleAlbedo = air.singleScatteringAlbedo400
      * Math.exp(-air.albedoWavelengthVariation * Math.log(nm / 400) ** 2);
    const transmittance = (relativeMass: number) => {
      const m = relativeMass * air.pressurePa / 101300;
      const waterMass = bird.water[i] * air.precipitableWaterCm * relativeMass;
      const gasMass = bird.mixedGas[i] * m;
      return {
        rayleigh: Math.exp(-m / (um ** 4 * (115.6406 - 1.3366 / (um * um)))),
        aerosol: Math.exp(-opticalDepth * relativeMass),
        water: Math.exp(-0.2385 * waterMass / (1 + 20.07 * waterMass) ** 0.45),
        gas: Math.exp(-1.41 * gasMass / (1 + 118.3 * gasMass) ** 0.45),
        scattering: Math.exp(-singleAlbedo * opticalDepth * relativeMass),
        absorption: Math.exp(-(1 - singleAlbedo) * opticalDepth * relativeMass),
      };
    };
    const t = transmittance(mass), p = transmittance(1.8);
    const ozone = Math.exp(-bird.ozone[i] * air.ozoneAtmCm * ozoneMass);
    const extra = bird.extraterrestrial[i];
    direct[i] = extra * t.rayleigh * t.aerosol * t.water * ozone * t.gas;
    // Follow the corrected NREL C implementation (Tu′, not To′, and one Cs).
    const skyReflectivity = p.gas * p.water * p.absorption
      * (0.5 * (1 - p.rayleigh) + (1 - forwardPrime) * p.rayleigh * (1 - p.scattering));
    const common = extra * cosZ * ozone * t.gas * t.water * t.absorption;
    const rayleigh = common * (1 - t.rayleigh ** 0.95) * 0.5;
    const aerosol = common * t.rayleigh ** 1.5 * (1 - t.scattering) * forward;
    const reflected = (direct[i] * cosZ + rayleigh + aerosol) * skyReflectivity * air.groundAlbedo
      / (1 - skyReflectivity * air.groundAlbedo);
    const correction = nm <= 450 ? ((nm + 550) / 1000) ** 1.8 : 1;
    diffuse[i] = (rayleigh + aerosol + reflected) * correction;
  }
  return { direct, diffuse };
}

/** Integrate linearly interpolated SPECTRL2 samples against 5 nm CIE 1931 CMFs. */
export function spectrumToXYZ(spectrum: readonly number[]): Triple {
  const xyz = zero();
  let left = 0;
  for (let i = 0; i < cie.xyz.length; i++) {
    const wavelength = cie.startNm + i * cie.stepNm;
    while (bird.wavelength[left + 1] < wavelength) left++;
    const fraction = (wavelength - bird.wavelength[left]) / (bird.wavelength[left + 1] - bird.wavelength[left]);
    const irradiance = spectrum[left] * (1 - fraction) + spectrum[left + 1] * fraction;
    const weight = cie.stepNm * (i === 0 || i === cie.xyz.length - 1 ? 0.5 : 1);
    for (let channel = 0; channel < 3; channel++) xyz[channel] += irradiance * cie.xyz[i][channel] * weight;
  }
  return xyz;
}

export function modelDaylight(altitude: number, air: Atmosphere = atmosphere): Daylight {
  const spectrum = daylightSpectrum(altitude, air);
  const direct = spectrumToXYZ(spectrum.direct), diffuse = spectrumToXYZ(spectrum.diffuse);
  const cosZ = Math.max(0, Math.sin(altitude * RAD));
  return { direct, diffuse, global: direct.map((value, i) => value * cosZ + diffuse[i]) as Triple };
}

/** W3C's D65 XYZ → linear sRGB matrix; no white balance to erase solar warmth. */
export function xyzToLinearRGB([x, y, z]: readonly number[]): Triple {
  return [
    3.2409699419045226 * x - 1.537383177570094 * y - 0.4986107602930034 * z,
    -0.9692436362808796 * x + 1.8759675015077202 * y + 0.04155505740717559 * z,
    0.05563007969699366 * x - 0.20397695888897652 * y + 1.0569715142428786 * z,
  ];
}

export function linearRGBToHex(rgb: readonly number[]): string {
  return '#' + rgb.map(channel => {
    const value = Math.max(0, Math.min(1, channel));
    const encoded = value <= 0.0031308 ? 12.92 * value : 1.055 * value ** (1 / 2.4) - 0.055;
    return Math.round(encoded * 255).toString(16).padStart(2, '0');
  }).join('');
}

// A bounded 0.1° cache, interpolated in XYZ, avoids repeated spectral work and
// retains smooth colour at accelerated playback rates. Atmosphere is fixed.
const samples = new Map<number, Daylight>();
function sample(index: number): Daylight {
  let value = samples.get(index);
  if (!value) { value = modelDaylight(index / 10); samples.set(index, value); }
  return value;
}

/** Shared display exposure for illuminated ground and its diffuse-only shadow. */
export function daylightColors(altitude: number): { background: string; shadow: string } {
  // SPECTRL2 has no below-horizon solution. Twilight uses the 1° endpoint,
  // blended with the separate night palette; it is explicitly illustrative.
  const angle = Math.max(1, Math.min(90, altitude)) * 10;
  const index = Math.floor(angle), t = angle - index;
  const a = sample(index), b = sample(Math.min(900, index + 1));
  const blend = (key: 'global' | 'diffuse') => a[key].map((value, i) => value * (1 - t) + b[key][i] * t);
  const lit = xyzToLinearRGB(blend('global')), shade = xyzToLinearRGB(blend('diffuse'));
  // Fit a neutral Lambertian surface into sRGB with one common gain. This
  // preserves in-gamut chromaticity and the Sun/sky ratio, not absolute lux.
  const exposure = atmosphere.displayWhiteLevel / Math.max(...lit);
  return {
    background: linearRGBToHex(lit.map(value => value * exposure)),
    shadow: linearRGBToHex(shade.map(value => value * exposure)),
  };
}
