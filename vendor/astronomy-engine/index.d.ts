// The application uses this subset of Astronomy Engine's public interface.
export enum Body { Sun = 'Sun', Moon = 'Moon' }
export class Observer { constructor(latitude: number, longitude: number, height: number); }
export class AstroTime { date: Date; ut: number; tt: number; AddDays(days: number): AstroTime; }
export interface EquatorialCoordinates { ra: number; dec: number; dist: number; }
export interface HorizontalCoordinates { azimuth: number; altitude: number; }
export interface IlluminationInfo { phase_fraction: number; }
export interface LunarEclipseInfo {
  kind: string;
  peak: AstroTime;
  obscuration: number;
  sd_penum: number;
  sd_partial: number;
  sd_total: number;
}
export function Equator(body: Body, date: Date, observer: Observer, ofdate: boolean, aberration: boolean): EquatorialCoordinates;
export function Horizon(date: Date, observer: Observer, ra: number, dec: number, refraction?: string): HorizontalCoordinates;
export function Illumination(body: Body, date: Date): IlluminationInfo;
export function SearchLunarEclipse(date: Date): LunarEclipseInfo;
export function NextLunarEclipse(date: AstroTime): LunarEclipseInfo;
