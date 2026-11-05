"""Prepare a small, north-first Swiss terrain bundle using only the standard library.

Run with ``uv run scripts/prepare_terrain.py --download``; add ``--region zurich`` for the canton. Downloaded archives
remain in gitignored local/data; no network access occurs without --download.
"""

from __future__ import annotations

import argparse
from array import array
from concurrent.futures import ProcessPoolExecutor, ThreadPoolExecutor
from contextlib import contextmanager
import hashlib
import io
import json
import math
from pathlib import Path
import re
import struct
import sys
import time
from typing import BinaryIO, Iterator, TextIO
from urllib.parse import urlparse
from urllib.request import Request, urlopen
from urllib.error import URLError
from zipfile import ZipFile
import zlib

ROOT = Path(__file__).resolve().parents[1]
MAX_DOWNLOAD = 512 * 1024 * 1024


def download(url: str, destination: Path, is_archive: bool = True) -> None:
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
        if is_archive:
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


def territory_rings(path: Path, layer: str, names: set[str], min_spacing: float) -> list[list[tuple[float, float]]]:
    """Select named records from one boundary layer and align LV95 to the LV03 elevation grid.

    The official LV95/LV03 grid-origin shift differs from a rigorous FINELTRA
    transformation by at most a few metres, below this map's 200/400 m samples.
    """
    with ZipFile(path) as archive:
        names_in_archive = [n for n in archive.namelist()
                            if layer in n.lower() and n.lower().endswith(".shp")]
        if len(names_in_archive) != 1:
            raise ValueError(f"Expected one {layer} shapefile")
        shp = names_in_archive[0]
        dbf = next((n for n in archive.namelist() if n.lower() == (shp[:-4] + ".dbf").lower()), None)
        if dbf is None:
            raise ValueError(f"Missing {layer} DBF")
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
            if not values.intersection(names):
                continue
            for ring in polygons:
                # Remove redundant points while keeping the silhouette below one mask pixel.
                reduced = [ring[0]]
                for point in ring[1:]:
                    if math.dist(point, reduced[-1]) >= min_spacing:
                        reduced.append(point)
                if reduced[-1] != reduced[0]:
                    reduced.append(reduced[0])
                if len(reduced) >= 4:
                    rings.append([(x - 2000000, y - 1000000) for x, y in reduced])
        if not rings:
            raise ValueError(f"{sorted(names)[0]} not found in {layer} records")
        return rings


def country_rings(path: Path) -> list[list[tuple[float, float]]]:
    """Select the national territory of Switzerland."""
    return territory_rings(path, "tlm_landesgebiet", {"CH", "CHE", "Schweiz", "Suisse", "Switzerland"}, 60)


def canton_rings(path: Path, name: str) -> list[list[tuple[float, float]]]:
    """Select one canton, keeping any exclaves; finer vertices suit its larger map scale."""
    return territory_rings(path, "tlm_kantonsgebiet", {name}, 20)


def crop_grid(data: array, metadata: dict, bounds: list[float], margin: float) -> tuple[array, dict]:
    """Cut a north-first grid to the bounds plus a margin, snapped to existing samples."""
    width, spacing = metadata["width"], metadata["spacingMeters"]
    first_col = max(0, math.floor((bounds[0] - margin - metadata["west"]) / spacing))
    last_col = min(width - 1, math.ceil((bounds[2] + margin - metadata["west"]) / spacing))
    first_row = max(0, math.floor((metadata["north"] - bounds[3] - margin) / spacing))
    last_row = min(metadata["height"] - 1, math.ceil((metadata["north"] - bounds[1] + margin) / spacing))
    if last_col <= first_col or last_row <= first_row:
        raise ValueError("The boundary does not overlap the elevation grid")
    cropped = array("H")
    for row in range(first_row, last_row + 1):
        cropped.extend(data[row * width + first_col:row * width + last_col + 1])
    return cropped, {
        **metadata, "width": last_col - first_col + 1, "height": last_row - first_row + 1,
        "west": metadata["west"] + first_col * spacing,
        "north": metadata["north"] - first_row * spacing,
        "missingCells": cropped.count(0),
    }


def lzw_decode(data: bytes) -> bytes:
    """Decode TIFF LZW: most significant bit first, 9-12 bit codes, early width change."""
    output = bytearray()
    table: list[bytes] = []
    previous = b""
    width = 9
    buffer = bits = 0
    position = 0
    while True:
        while bits < width:
            if position >= len(data):
                return bytes(output)
            buffer = (buffer << 8) | data[position]
            position += 1
            bits += 8
        bits -= width
        code = (buffer >> bits) & ((1 << width) - 1)
        buffer &= (1 << bits) - 1
        if code == 257:
            return bytes(output)
        if code == 256:
            table = [bytes((i,)) for i in range(256)] + [b"", b""]
            previous = b""
            width = 9
            continue
        if not table:
            raise ValueError("LZW stream does not start with a clear code")
        if not previous:
            entry = table[code]
        else:
            if code < len(table):
                entry = table[code]
            elif code == len(table):
                entry = previous + previous[:1]
            else:
                raise ValueError("Invalid LZW code")
            table.append(previous + entry[:1])
        output += entry
        previous = entry
        if len(table) >= 2047:
            width = 12
        elif len(table) >= 1023:
            width = 11
        elif len(table) >= 511:
            width = 10


def read_float_tiff(raw: bytes) -> tuple[array, int, int]:
    """Read the full-resolution image of a tiled, single-band, 32-bit float TIFF."""
    if raw[:4] not in (b"II*\0", b"MM\0*"):
        raise ValueError("Expected a classic TIFF")
    order = "<" if raw[:2] == b"II" else ">"
    sizes = {1: 1, 3: 2, 4: 4}
    offset = struct.unpack_from(order + "I", raw, 4)[0]
    tags = {}
    for index in range(struct.unpack_from(order + "H", raw, offset)[0]):
        tag, kind, count = struct.unpack_from(order + "HHI", raw, offset + 2 + index * 12)
        if kind in sizes:
            at = offset + 10 + index * 12
            if sizes[kind] * count > 4:
                at = struct.unpack_from(order + "I", raw, at)[0]
            tags[tag] = struct.unpack_from(f"{order}{count}{'BHI'[sizes[kind] // 2]}", raw, at)
    width, height = tags[256][0], tags[257][0]
    tile_width, tile_height = tags[322][0], tags[323][0]
    if (tags[258][0], tags[339][0], tags[277][0], tags.get(317, (1,))[0]) != (32, 3, 1, 1):
        raise ValueError("Expected single-band 32-bit floats without a predictor")
    if tags[259][0] not in (1, 5) or not 1 <= width <= 4096 or not 1 <= height <= 4096:
        raise ValueError("Unsupported TIFF layout")
    pixels = array("f", bytes(width * height * 4))
    across = math.ceil(width / tile_width)
    for index, (start, length) in enumerate(zip(tags[324], tags[325], strict=True)):
        block = raw[start:start + length]
        if tags[259][0] == 5:
            block = lzw_decode(block)
        if len(block) != tile_width * tile_height * 4:
            raise ValueError("Truncated TIFF tile")
        values = array("f", block)
        if (order == "<") != (sys.byteorder == "little"):
            values.byteswap()
        left, top = (index % across) * tile_width, (index // across) * tile_height
        columns = min(tile_width, width - left)
        for row in range(min(tile_height, height - top)):
            pixels[(top + row) * width + left:(top + row) * width + left + columns] = \
                values[row * tile_width:row * tile_width + columns]
    return pixels, width, height


def tile_bins(pixels: array, size: int, pixel_size: int, spacing: int) -> list[tuple[int, int, float, int]]:
    """Average one north-first tile into grid samples centred on multiples of spacing.

    Returns (row, column, sum, count), counted from the tile's north-west corner.
    A sample may lie on the tile's edge, so neighbouring tiles share it.
    """
    spans: dict[int, tuple[int, int]] = {}
    for index in range(size):
        sample = int(((index + 0.5) * pixel_size + spacing / 2) // spacing)
        spans[sample] = (spans.get(sample, (index,))[0], index)
    result = []
    for row, (top, bottom) in spans.items():
        for column, (left, right) in spans.items():
            total = 0.0
            count = 0
            for line in range(top, bottom + 1):
                values = pixels[line * size + left:line * size + right + 1]
                if min(values) < -1000:
                    values = [value for value in values if value >= -1000]
                total += sum(values)
                count += len(values)
            if count:
                result.append((row, column, total, count))
    return result


def read_tile_bins(job: tuple[str, str, int]) -> tuple[str, list[tuple[int, int, float, int]]]:
    """Worker: decode and average one cached tile."""
    name, path, spacing = job
    pixels, width, height = read_float_tiff(Path(path).read_bytes())
    if width != height or width * 2 != 1000:
        raise ValueError(f"Expected a 1 km tile at 2 m: {name}")
    lowest = min(pixels)
    if (lowest < -1000 and lowest != -9999) or max(pixels) > 6000:
        raise ValueError(f"Unexpected elevation in {name}")
    return name, tile_bins(pixels, width, 2, spacing)


def list_alti_tiles(config: dict, manifest: Path) -> dict[str, list]:
    """List each tile's newest edition from the swisstopo catalogue, once."""
    if manifest.is_file():
        return json.loads(manifest.read_text())
    url = config["catalogue"]
    tiles: dict[str, list] = {}
    while url:
        for attempt in range(8):
            try:
                with urlopen(Request(url, headers={"User-Agent": "SwitzerlandLightMap/1.0"}), timeout=120) as response:
                    page = json.load(response)
                break
            except (URLError, TimeoutError):
                if attempt == 7:
                    raise
                time.sleep(5 * (attempt + 1))
        for feature in page["features"]:
            _, year, tile = feature["id"].split("_")
            links = [a["href"] for key, a in feature["assets"].items() if key.endswith("_2_2056_5728.tif")]
            if links and (tile not in tiles or int(year) > tiles[tile][0]):
                tiles[tile] = [int(year), links[0]]
        url = next((link["href"] for link in page["links"] if link["rel"] == "next"), None)
    manifest.parent.mkdir(parents=True, exist_ok=True)
    manifest.write_text(json.dumps(tiles, indent=0, sort_keys=True))
    return tiles


def tiles_for_mask(mask: bytes, mask_width: int, mask_height: int, metadata: dict, reach: float) -> set[str]:
    """Name every 1 km LV95 tile within reach of the mask, so slopes at its edge are real."""
    span_x = (metadata["width"] - 1) * metadata["spacingMeters"]
    span_y = (metadata["height"] - 1) * metadata["spacingMeters"]
    tiles = set()
    for row in range(0, mask_height, 4):
        y = metadata["north"] - (row + 0.5) / mask_height * span_y + 1000000
        for col in range(0, mask_width, 4):
            if mask[row * mask_width + col]:
                x = metadata["west"] + (col + 0.5) / mask_width * span_x + 2000000
                for east in (x - reach, x + reach):
                    for north in (y - reach, y + reach):
                        tiles.add(f"{int(east // 1000)}-{int(north // 1000)}")
    return tiles


def fine_elevations(coarse: array, metadata: dict, factor: int, tiles: dict[str, Path]) -> tuple[array, dict, int]:
    """Subdivide the coarse grid, averaging fine tiles into it, in decimetres.

    Sharing the coarse grid's outer samples keeps the mask and preview aligned.
    Samples without fine data, always outside the mask's reach, interpolate the coarse grid.
    """
    width = (metadata["width"] - 1) * factor + 1
    height = (metadata["height"] - 1) * factor + 1
    spacing = metadata["spacingMeters"] // factor
    west, north = int(metadata["west"]) + 2000000, int(metadata["north"]) + 1000000
    totals = array("d", bytes(width * height * 8))
    counts = array("I", bytes(width * height * 4))
    jobs = [(name, str(path), spacing) for name, path in tiles.items()]
    with ProcessPoolExecutor() as pool:
        for name, bins in pool.map(read_tile_bins, jobs, chunksize=16):
            east, south = (int(part) * 1000 for part in name.split("-"))
            left, top = (east - west) // spacing, (north - south - 1000) // spacing
            for row, column, total, count in bins:
                r, c = top + row, left + column
                if 0 <= r < height and 0 <= c < width:
                    totals[r * width + c] += total
                    counts[r * width + c] += count
    result = array("H", bytes(width * height * 2))
    filled = 0
    for row in range(height):
        coarse_row = min(metadata["height"] - 2, row // factor)
        v = row / factor - coarse_row
        for col in range(width):
            index = row * width + col
            if counts[index]:
                result[index] = round(totals[index] / counts[index] * 10)
                continue
            filled += 1
            coarse_col = min(metadata["width"] - 2, col // factor)
            u = col / factor - coarse_col
            at = coarse_row * metadata["width"] + coarse_col
            result[index] = round(10 * ((coarse[at] * (1 - u) + coarse[at + 1] * u) * (1 - v)
                                        + (coarse[at + metadata["width"]] * (1 - u)
                                           + coarse[at + metadata["width"] + 1] * u) * v))
    return result, {**metadata, "width": width, "height": height, "spacingMeters": spacing,
                    "heightEncoding": "uint16-le-decimetres-LN02", "missingCells": filled}, filled


def fetch_alti_tiles(config: dict, mask: bytes, mask_width: int, mask_height: int, metadata: dict,
                     directory: Path, allow_download: bool) -> tuple[dict[str, Path], dict]:
    """Resolve the canton's tiles to cached files, downloading only when allowed."""
    manifest = directory / "manifest.json"
    if not allow_download and not manifest.is_file():
        raise ValueError(f"Missing {manifest}. Use --download to fetch swissALTI3D tiles.")
    listed = list_alti_tiles(config, manifest)
    wanted = sorted(tiles_for_mask(mask, mask_width, mask_height, metadata, config["reachMeters"]) & listed.keys())
    paths = {}
    jobs = []
    for name in wanted:
        if not re.fullmatch(r"\d{4}-\d{4}", name):
            raise ValueError("Unexpected tile name")
        paths[name] = directory / f"{name}.tif"
        if not paths[name].is_file():
            jobs.append((listed[name][1], paths[name]))
    if jobs:
        if not allow_download:
            raise ValueError(f"{len(jobs)} tiles are missing. Use --download to fetch them.")
        def fetch(job: tuple[str, Path]) -> None:
            for attempt in range(6):
                try:
                    download(job[0], job[1], is_archive=False)
                    return
                except (URLError, TimeoutError, OSError):
                    if attempt == 5:
                        raise
                    time.sleep(5 * (attempt + 1))
        print(f"Downloading {len(jobs)} of {len(wanted)} swissALTI3D tiles…", flush=True)
        with ThreadPoolExecutor(8) as pool:
            list(pool.map(fetch, jobs))
    years = [listed[name][0] for name in wanted]
    return paths, {"edition": config["edition"], "crs": "EPSG:2056", "url": config["catalogue"],
                   "tiles": len(wanted), "tileYears": [min(years), max(years)],
                   "sha256": hashlib.sha256(json.dumps({n: listed[n] for n in wanted}, sort_keys=True).encode()).hexdigest()}


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


def prepare(elevation: Path, boundary: Path, destination: Path, config: dict,
            tile_directory: Path | None = None, allow_download: bool = False) -> None:
    """Write validated little-endian terrain, mask, fallback and provenance."""
    with elevation_file(elevation) as source:
        data, metadata = read_grid(source, config["spacingMeters"])
    rings = canton_rings(boundary, config["canton"]) if "canton" in config else country_rings(boundary)
    points = [p for ring in rings for p in ring]
    bounds = [min(x for x, _ in points), min(y for _, y in points),
              max(x for x, _ in points), max(y for _, y in points)]
    if "canton" in config:
        data, metadata = crop_grid(data, metadata, bounds, config["marginMeters"])
    mask, mask_height = raster_mask(rings, metadata, config["maskWidth"])
    if not any(mask):
        raise ValueError("The boundary does not overlap the elevation grid")
    metadata["countryBounds"] = bounds
    metadata["schemaVersion"] = 1
    metadata["sources"] = {
        name: {**config[name], "sha256": hashlib.sha256(path.read_bytes()).hexdigest()}
        for name, path in (("elevation", elevation), ("boundary", boundary))
    }
    metadata["boundaryAlignment"] = "LV95 to LV03 grid-origin shift (-2000000, -1000000 m); metre-scale residuals"
    metadata["edgeLimitation"] = "Terrain retained within source coverage; missing elevations are zero. Foreign terrain beyond coverage cannot cast shadows."
    metadata["observer"] = config["observer"]
    metadata["maskWidth"], metadata["maskHeight"] = config["maskWidth"], mask_height
    # The preview image stays on the coarse grid; only the live model is refined.
    heights = data
    if "fineElevation" in config:
        fine = config["fineElevation"]
        paths, metadata["sources"]["fineElevation"] = fetch_alti_tiles(
            fine, mask, config["maskWidth"], mask_height, metadata,
            tile_directory or ROOT / "local/data/swissalti3d", allow_download)
        coarse_metadata = metadata
        heights, metadata, filled = fine_elevations(
            data, coarse_metadata, config["spacingMeters"] // fine["spacingMeters"], paths)
        print(f"Averaged {len(paths)} tiles; {filled} samples outside them use the coarse grid", flush=True)
    else:
        coarse_metadata = metadata
    destination.mkdir(parents=True, exist_ok=True)
    if sys.byteorder != "little":
        heights.byteswap()
    (destination / "elevation.bin").write_bytes(heights.tobytes())
    if sys.byteorder != "little":
        heights.byteswap()
    png(destination / "mask.png", config["maskWidth"], mask_height, mask, 1)
    png(destination / "fallback.png", coarse_metadata["width"], coarse_metadata["height"],
        fallback(data, coarse_metadata, mask, config["maskWidth"], mask_height), 4)
    (destination / "metadata.json").write_text(json.dumps(metadata, indent=2) + "\n")
    print(f"Prepared {metadata['width']} × {metadata['height']} terrain in {destination}")


def main() -> None:
    """Accept cached archives or explicitly download the pinned official releases."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--download", action="store_true")
    parser.add_argument("--elevation", type=Path, default=ROOT / "local/data/elevation.zip")
    parser.add_argument("--boundary", type=Path, default=ROOT / "local/data/boundary.zip")
    parser.add_argument("--region", default="switzerland", help="switzerland, or a key of 'regions' in terrain.sources.json")
    parser.add_argument("--output", type=Path, help="defaults to public/terrain, or public/terrain/<region>")
    args = parser.parse_args()
    config = json.loads((ROOT / "terrain.sources.json").read_text())
    if args.region != "switzerland":
        if args.region not in config["regions"]:
            parser.error(f"Unknown region {args.region}")
        config = {**config, **config["regions"][args.region]}
    output = args.output or ROOT / ("public/terrain" if args.region == "switzerland" else f"public/terrain/{args.region}")
    for name, path in (("elevation", args.elevation), ("boundary", args.boundary)):
        if not path.is_file():
            if not args.download:
                parser.error(f"Missing {path}. Supply the archive or use --download.")
            print(f"Downloading {name} from swisstopo…", flush=True)
            try:
                download(config[name]["url"], path)
            except (URLError, TimeoutError):
                parser.exit(1, f"Could not download {name} from swisstopo. Check network access, or supply a local archive.\n")
    prepare(args.elevation, args.boundary, output, config, allow_download=args.download)


if __name__ == "__main__":
    main()
