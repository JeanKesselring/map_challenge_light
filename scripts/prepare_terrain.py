"""Prepare a small, north-first Swiss terrain bundle using only the standard library.

Run with ``uv run scripts/prepare_terrain.py --download``. Downloaded archives
remain in gitignored local/data; no network access occurs without --download.
"""

from __future__ import annotations

import argparse
from array import array
from contextlib import contextmanager
import hashlib
import io
import json
import math
from pathlib import Path
import struct
import sys
from typing import BinaryIO, Iterator, TextIO
from urllib.parse import urlparse
from urllib.request import Request, urlopen
from urllib.error import URLError
from zipfile import ZipFile
import zlib

ROOT = Path(__file__).resolve().parents[1]
MAX_DOWNLOAD = 512 * 1024 * 1024


def download(url: str, destination: Path) -> None:
    """Stream an approved HTTPS dataset, atomically, with bounded size."""
    parsed = urlparse(url)
    if parsed.scheme != "https" or parsed.hostname != "data.geo.admin.ch":
        raise ValueError("Only HTTPS downloads from data.geo.admin.ch are allowed")
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = destination.with_suffix(".part")
    try:
        request = Request(url, headers={"User-Agent": "SwitzerlandLightMap/1.0"})
        with urlopen(request, timeout=60) as response, temporary.open("wb") as output:
            if urlparse(response.url).hostname != "data.geo.admin.ch":
                raise ValueError("Unexpected download redirect")
            size = 0
            while chunk := response.read(1024 * 1024):
                size += len(chunk)
                if size > MAX_DOWNLOAD:
                    raise ValueError("Dataset exceeds the download size limit")
                output.write(chunk)
        with ZipFile(temporary) as archive:
            if sum(info.file_size for info in archive.infolist()) > 4 * MAX_DOWNLOAD:
                raise ValueError("Expanded archive exceeds the size limit")
        temporary.replace(destination)
    finally:
        temporary.unlink(missing_ok=True)


@contextmanager
def elevation_file(path: Path) -> Iterator[TextIO]:
    """Read an ASCII grid without extracting any untrusted archive paths."""
    if path.suffix.lower() != ".zip":
        with path.open(encoding="ascii") as source:
            yield source
        return
    with ZipFile(path) as archive:
        members = [n for n in archive.namelist() if n.lower().endswith(".asc")]
        if len(members) != 1 or archive.getinfo(members[0]).file_size > MAX_DOWNLOAD:
            raise ValueError("Expected one bounded ASCII elevation grid")
        with archive.open(members[0]) as raw, io.TextIOWrapper(raw, encoding="ascii") as source:
            yield source


def read_grid(source: TextIO, spacing: int) -> tuple[array, dict]:
    """Sample north-first cells; ASCII whitespace need not follow grid rows."""
    header = {}
    for _ in range(6):
        name, value = source.readline().split()
        header[name.lower()] = float(value)
    cell = header["cellsize"]
    stride = round(spacing / cell)
    if stride < 1 or not math.isclose(stride * cell, spacing):
        raise ValueError("Output spacing must be a multiple of source spacing")
    ncols, nrows = int(header["ncols"]), int(header["nrows"])
    if not 2 <= ncols <= 10000 or not 2 <= nrows <= 10000:
        raise ValueError("Invalid elevation dimensions")
    west = header.get("xllcenter", header.get("xllcorner", 0) + cell / 2)
    south = header.get("yllcenter", header.get("yllcorner", 0) + cell / 2)
    north = south + (nrows - 1) * cell
    data = array("H")
    missing = 0
    values = (token for line in source for token in line.split())
    for row in range(nrows):
        for col in range(ncols):
            try:
                height = float(next(values))
            except StopIteration as error:
                raise ValueError(f"Incomplete elevation row {row}, column {col}") from error
            is_missing = height == header.get("nodata_value", -9999)
            if is_missing:
                height = 0
            if not math.isfinite(height) or height < 0 or height > 6000:
                raise ValueError("Unexpected Swiss elevation")
            if row % stride == 0 and col % stride == 0:
                missing += is_missing
                data.append(round(height))
    if next(values, None) is not None:
        raise ValueError("Extra elevation values beyond the declared grid dimensions")
    width, height = math.ceil(ncols / stride), math.ceil(nrows / stride)
    return data, {
        "width": width, "height": height, "spacingMeters": spacing,
        "west": west, "north": north, "crs": "EPSG:21781",
        "rowOrder": "north-to-south", "heightEncoding": "uint16-le-metres-LN02",
        "missingCells": missing,
    }


def dbf_records(raw: bytes) -> list[dict[str, str]]:
    """Read only DBF character fields needed to select the national territory."""
    count, offset, length = struct.unpack_from("<IHH", raw, 4)
    if count > 100000 or offset + count * length > len(raw):
        raise ValueError("Invalid DBF dimensions")
    columns = []
    position = 32
    while position + 32 <= offset and raw[position] != 13:
        name = raw[position:position + 11].split(b"\0")[0].decode("ascii")
        columns.append((name.upper(), raw[position + 16]))
        position += 32
    result = []
    for index in range(count):
        start = offset + index * length
        fields = {}
        cursor = start + 1
        for name, size in columns:
            fields[name] = raw[cursor:cursor + size].decode("utf-8", errors="replace").strip()
            cursor += size
        result.append(fields if raw[start] != 42 else {})
    return result


def polygon_records(source: BinaryIO) -> Iterator[list[list[tuple[float, float]]]]:
    """Read XY rings from Polygon/PolygonZ/PolygonM, ignoring optional Z/M tails."""
    header = source.read(100)
    if len(header) != 100 or struct.unpack_from(">i", header)[0] != 9994:
        raise ValueError("Invalid shapefile header")
    while record := source.read(8):
        if len(record) != 8:
            raise ValueError("Truncated shapefile record")
        _, words = struct.unpack(">ii", record)
        if words < 2 or words * 2 > MAX_DOWNLOAD:
            raise ValueError("Invalid shapefile record length")
        raw = source.read(words * 2)
        if len(raw) != words * 2:
            raise ValueError("Truncated shapefile geometry")
        kind = struct.unpack_from("<i", raw)[0]
        if kind == 0:
            yield []
            continue
        if kind not in (5, 15, 25) or len(raw) < 44:
            raise ValueError("Expected national-territory polygon geometry")
        parts, points = struct.unpack_from("<ii", raw, 36)
        if not 0 < parts <= points <= 1000000 or 44 + 4 * parts + 16 * points > len(raw):
            raise ValueError("Invalid polygon dimensions")
        starts = list(struct.unpack_from(f"<{parts}i", raw, 44)) + [points]
        coords = list(struct.iter_unpack("<dd", raw[44 + parts * 4:44 + parts * 4 + points * 16]))
        yield [coords[starts[i]:starts[i + 1]] for i in range(parts)]


def country_rings(path: Path) -> list[list[tuple[float, float]]]:
    """Select CH and align LV95 to the LV03 elevation grid.

    The official LV95/LV03 grid-origin shift differs from a rigorous FINELTRA
    transformation by at most a few metres, below this map's 200/400 m samples.
    """
    with ZipFile(path) as archive:
        names = [n for n in archive.namelist()
                 if "tlm_landesgebiet" in n.lower() and n.lower().endswith(".shp")]
        if len(names) != 1:
            raise ValueError("Expected one TLM_LANDESGEBIET shapefile")
        shp = names[0]
        dbf = next((n for n in archive.namelist() if n.lower() == (shp[:-4] + ".dbf").lower()), None)
        if dbf is None:
            raise ValueError("Missing national-territory DBF")
        if max(archive.getinfo(n).file_size for n in (shp, dbf)) > MAX_DOWNLOAD:
            raise ValueError("Boundary archive members are too large")
        records = dbf_records(archive.read(dbf))
        rings = []
        with archive.open(shp) as source:
            shapes = list(polygon_records(source))
        if len(records) != len(shapes):
            raise ValueError("Boundary attributes do not match geometries")
        for record, polygons in zip(records, shapes, strict=True):
            values = set(record.values())
            if not values.intersection({"CH", "CHE", "Schweiz", "Suisse", "Switzerland"}):
                continue
            for ring in polygons:
                # Remove redundant points while keeping the silhouette below one mask pixel.
                reduced = [ring[0]]
                for point in ring[1:]:
                    if math.dist(point, reduced[-1]) >= 60:
                        reduced.append(point)
                if reduced[-1] != reduced[0]:
                    reduced.append(reduced[0])
                if len(reduced) >= 4:
                    rings.append([(x - 2000000, y - 1000000) for x, y in reduced])
        if not rings:
            raise ValueError("Switzerland not found in national-territory records")
        return rings


def raster_mask(rings: list[list[tuple[float, float]]], metadata: dict, width: int) -> tuple[bytearray, int]:
    """Rasterise all rings with even/odd filling, preserving foreign enclaves."""
    span_x = (metadata["width"] - 1) * metadata["spacingMeters"]
    span_y = (metadata["height"] - 1) * metadata["spacingMeters"]
    height = round(width * span_y / span_x)
    if not 2 <= width <= 4096 or height < 2:
        raise ValueError("Invalid country mask dimensions")
    pixels = bytearray(width * height)
    for row in range(height):
        y = metadata["north"] - (row + 0.5) / height * span_y
        crossings = []
        for ring in rings:
            for (x1, y1), (x2, y2) in zip(ring, ring[1:]):
                if (y1 > y) != (y2 > y):
                    crossings.append(x1 + (y - y1) * (x2 - x1) / (y2 - y1))
        crossings.sort()
        for start, end in zip(crossings[::2], crossings[1::2]):
            left = max(0, math.ceil((start - metadata["west"]) / span_x * width - 0.5))
            right = min(width, math.ceil((end - metadata["west"]) / span_x * width - 0.5))
            if right > left:
                pixels[row * width + left:row * width + right] = b"\xff" * (right - left)
    return pixels, height


def png(path: Path, width: int, height: int, pixels: bytes, channels: int) -> None:
    """Encode a deterministic lossless PNG without an imaging dependency."""
    if len(pixels) != width * height * channels or channels not in (1, 4):
        raise ValueError("Invalid PNG pixels")
    def chunk(kind: bytes, data: bytes) -> bytes:
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data))
    scanlines = b"".join(b"\0" + pixels[y * width * channels:(y + 1) * width * channels]
                         for y in range(height))
    raw = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 0 if channels == 1 else 6, 0, 0, 0))
    raw += chunk(b"IDAT", zlib.compress(scanlines, 9)) + chunk(b"IEND", b"")
    path.write_bytes(raw)


def fallback(data: array, metadata: dict, mask: bytearray, mask_width: int, mask_height: int) -> bytes:
    """Static afternoon relief for browsers without WebGL2; intentionally not a live simulation."""
    width, height = metadata["width"], metadata["height"]
    spacing = metadata["spacingMeters"]
    palette = json.loads((ROOT / "src/data/daylight-fallback.json").read_text())
    def linear_color(hex_color: str) -> list[float]:
        values = [int(hex_color[i:i + 2], 16) / 255 for i in (1, 3, 5)]
        return [v / 12.92 if v <= 0.04045 else ((v + 0.055) / 1.055) ** 2.4 for v in values]
    shade, sun = linear_color(palette["shadow"]), linear_color(palette["background"])
    altitude = math.sqrt(0.5)
    result = bytearray(width * height * 4)
    for row in range(height):
        for col in range(width):
            i = row * width + col
            dx = (data[row * width + min(width - 1, col + 1)] - data[row * width + max(0, col - 1)]) / (2 * spacing)
            dz = (data[min(height - 1, row + 1) * width + col] - data[max(0, row - 1) * width + col]) / (2 * spacing)
            light = max(0, min(1, (-dx * -0.5 + altitude - dz * -0.5)
                               / (math.sqrt(1 + dx * dx + dz * dz) * altitude)))
            channels = [a + (b - a) * light for a, b in zip(shade, sun)]
            rgb = [round(255 * (v * 12.92 if v <= 0.0031308 else 1.055 * v ** (1 / 2.4) - 0.055))
                   for v in channels]
            alpha = mask[min(mask_height - 1, round(row / (height - 1) * (mask_height - 1))) * mask_width
                         + min(mask_width - 1, round(col / (width - 1) * (mask_width - 1)))]
            result[i * 4:i * 4 + 4] = bytes([*rgb, alpha])
    return result


def prepare(elevation: Path, boundary: Path, destination: Path, config: dict) -> None:
    """Write validated little-endian terrain, mask, fallback and provenance."""
    with elevation_file(elevation) as source:
        data, metadata = read_grid(source, config["spacingMeters"])
    rings = country_rings(boundary)
    mask, mask_height = raster_mask(rings, metadata, config["maskWidth"])
    if not any(mask):
        raise ValueError("The boundary does not overlap the elevation grid")
    points = [p for ring in rings for p in ring]
    metadata["countryBounds"] = [min(x for x, _ in points), min(y for _, y in points),
                                 max(x for x, _ in points), max(y for _, y in points)]
    metadata["schemaVersion"] = 1
    metadata["sources"] = {
        name: {**config[name], "sha256": hashlib.sha256(path.read_bytes()).hexdigest()}
        for name, path in (("elevation", elevation), ("boundary", boundary))
    }
    metadata["boundaryAlignment"] = "LV95 to LV03 grid-origin shift (-2000000, -1000000 m); metre-scale residuals"
    metadata["edgeLimitation"] = "Terrain retained within source coverage; missing elevations are zero. Foreign terrain beyond coverage cannot cast shadows."
    metadata["observer"] = config["observer"]
    metadata["maskWidth"], metadata["maskHeight"] = config["maskWidth"], mask_height
    destination.mkdir(parents=True, exist_ok=True)
    if sys.byteorder != "little":
        data.byteswap()
    (destination / "elevation.bin").write_bytes(data.tobytes())
    if sys.byteorder != "little":
        data.byteswap()
    png(destination / "mask.png", config["maskWidth"], mask_height, mask, 1)
    png(destination / "fallback.png", metadata["width"], metadata["height"],
        fallback(data, metadata, mask, config["maskWidth"], mask_height), 4)
    (destination / "metadata.json").write_text(json.dumps(metadata, indent=2) + "\n")
    print(f"Prepared {metadata['width']} × {metadata['height']} terrain in {destination}")


def main() -> None:
    """Accept cached archives or explicitly download the pinned official releases."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--download", action="store_true")
    parser.add_argument("--elevation", type=Path, default=ROOT / "local/data/elevation.zip")
    parser.add_argument("--boundary", type=Path, default=ROOT / "local/data/boundary.zip")
    parser.add_argument("--output", type=Path, default=ROOT / "public/terrain")
    args = parser.parse_args()
    config = json.loads((ROOT / "terrain.sources.json").read_text())
    for name, path in (("elevation", args.elevation), ("boundary", args.boundary)):
        if not path.is_file():
            if not args.download:
                parser.error(f"Missing {path}. Supply the archive or use --download.")
            print(f"Downloading {name} from swisstopo…", flush=True)
            try:
                download(config[name]["url"], path)
            except (URLError, TimeoutError):
                parser.exit(1, f"Could not download {name} from swisstopo. Check network access, or supply a local archive.\n")
    prepare(args.elevation, args.boundary, args.output, config)


if __name__ == "__main__":
    main()
