"""Offline fixtures exercise alignment, holes, byte order and archive selection."""

import io
import json
from pathlib import Path
import struct
from tempfile import TemporaryDirectory
import unittest
from zipfile import ZipFile
import zlib

from scripts.prepare_terrain import (
    canton_rings, country_rings, crop_grid, dbf_records, download, fine_elevations,
    lzw_decode, png, polygon_records, read_float_tiff, tile_bins, tiles_for_mask,
    fallback, prepare, raster_mask, read_grid,
)


def boundary_fixture(destination: Path, layer: str = 'TLM_LANDESGEBIET', value: bytes = b' CH ') -> None:
    """Minimal valid national-territory archive in LV95 around the small LV03 grid."""
    coords = [(2600000, 1199600), (2600400, 1199600), (2600400, 1200000),
              (2600000, 1200000), (2600000, 1199600)]
    body = struct.pack('<i4d2ii', 5, 2600000, 1199600, 2600400, 1200000, 1, len(coords), 0)
    body += b''.join(struct.pack('<dd', *point) for point in coords)
    header = bytearray(100)
    struct.pack_into('>i', header, 0, 9994)
    struct.pack_into('>i', header, 24, (108 + len(body)) // 2)
    struct.pack_into('<ii', header, 28, 1000, 5)
    shp = bytes(header) + struct.pack('>ii', 1, len(body) // 2) + body
    dbf = bytearray(65)
    dbf[0] = 3
    struct.pack_into('<IHH', dbf, 4, 1, 65, 4)
    dbf[32:35] = b'ICC'
    dbf[43] = ord('C')
    dbf[48] = 3
    dbf[64] = 13
    dbf += value
    with ZipFile(destination, 'w') as archive:
        archive.writestr(f'{layer}.shp', shp)
        archive.writestr(f'{layer}.dbf', dbf)


def lzw_literals(data: bytes) -> bytes:
    """Valid TIFF LZW without matches, clearing before the code width would grow."""
    codes = []
    for start in range(0, len(data), 200):
        codes.append(256)
        codes.extend(data[start:start + 200])
    codes.append(257)
    bits = ''.join(f'{code:09b}' for code in codes)
    bits += '0' * (-len(bits) % 8)
    return int(bits, 2).to_bytes(len(bits) // 8, 'big')


def float_tiff(path: Path, size: int, values: list[float]) -> None:
    """A one-tile, LZW-compressed, single-band float TIFF."""
    block = lzw_literals(struct.pack(f'<{len(values)}f', *values))
    tags = [(256, 3, size), (257, 3, size), (258, 3, 32), (259, 3, 5), (277, 3, 1), (317, 3, 1),
            (322, 3, size), (323, 3, size), (324, 4, 200), (325, 4, len(block)), (339, 3, 3)]
    directory = struct.pack('<H', len(tags)) + b''.join(
        struct.pack('<HHI', tag, kind, 1) + struct.pack('<I', value) for tag, kind, value in tags)
    path.write_bytes(b'II*\0' + struct.pack('<I', 8) + directory.ljust(192, b'\0') + block)


GRID = ('ncols 3\nnrows 3\nxllcorner 599900\nyllcorner 199500\n'
        'cellsize 200\nNODATA_value -9999\n100 200 300\n400 500 600\n700 800 900\n')


class TerrainPreparationTest(unittest.TestCase):
    def test_fallback_lit_ground_matches_shared_daylight_palette(self):
        from array import array
        palette = json.loads((Path(__file__).resolve().parents[1] / 'src/data/daylight-fallback.json').read_text())
        pixels = fallback(array('H', [100] * 4), {'width': 2, 'height': 2, 'spacingMeters': 400},
                          bytearray([255] * 4), 2, 2)
        self.assertEqual(pixels[:4], bytes.fromhex(palette['background'][1:]) + b'\xff')

    def test_grid_preserves_north_first_cell_centres_and_sampling(self):
        data, metadata = read_grid(io.StringIO(GRID), 400)
        self.assertEqual(list(data), [100, 300, 700, 900])
        self.assertEqual((metadata['west'], metadata['north']), (600000, 200000))
        self.assertEqual((metadata['width'], metadata['height']), (2, 2))

    def test_grid_values_can_wrap_independently_of_logical_rows(self):
        header, body = GRID.rsplit('100 200 300', 1)
        values = ('100 200 300' + body).split()
        expected, expected_metadata = read_grid(io.StringIO(GRID), 400)
        # DHM200.asc wraps after 20 values rather than at its 1926-column row boundary.
        for line_width in (1, 2, 5, 20):
            with self.subTest(line_width=line_width):
                wrapped = '\n\n'.join(' \t'.join(values[i:i + line_width])
                                       for i in range(0, len(values), line_width))
                data, metadata = read_grid(io.StringIO(header + wrapped), 400)
                self.assertEqual(data, expected)
                self.assertEqual(metadata, expected_metadata)

    def test_grid_rejects_extra_values_and_invalid_unsampled_cells(self):
        with self.assertRaises(ValueError):
            read_grid(io.StringIO(GRID + '1000\n'), 400)
        with self.assertRaises(ValueError):
            read_grid(io.StringIO(GRID.replace('400 500 600', '400 nan 600')), 400)

    def test_grid_rejects_incomplete_and_nonfinite_data(self):
        with self.assertRaises(ValueError):
            read_grid(io.StringIO(GRID.replace('700 800 900', '700 800')), 400)
        with self.assertRaises(ValueError):
            read_grid(io.StringIO(GRID.replace('100 200 300', 'nan 200 300')), 400)

    def test_even_odd_mask_keeps_enclaves_transparent(self):
        rings = [[(0,0),(10,0),(10,10),(0,10),(0,0)],
                 [(4,4),(6,4),(6,6),(4,6),(4,4)]]
        metadata = {'width': 11, 'height': 11, 'spacingMeters': 1, 'west': 0, 'north': 10}
        pixels, height = raster_mask(rings, metadata, 10)
        self.assertEqual(height, 10)
        self.assertEqual(pixels[0], 255)
        self.assertEqual(pixels[5 * 10 + 5], 0)
        self.assertEqual(pixels[2 * 10 + 5], 255)

    def test_shapefile_selection_and_lv95_alignment(self):
        with TemporaryDirectory() as temporary:
            archive = Path(temporary) / 'boundary.zip'
            boundary_fixture(archive)
            rings = country_rings(archive)
            self.assertEqual(rings[0][0], (600000, 199600))
            self.assertEqual(rings[0][-1], rings[0][0])

    def test_canton_selection_matches_only_the_named_record(self):
        with TemporaryDirectory() as temporary:
            archive = Path(temporary) / 'boundary.zip'
            boundary_fixture(archive, layer='TLM_KANTONSGEBIET', value=b' ZH ')
            self.assertEqual(canton_rings(archive, 'ZH')[0][0], (600000, 199600))
            with self.assertRaises(ValueError):
                canton_rings(archive, 'BE')

    def test_crop_keeps_north_first_samples_and_margin(self):
        from array import array
        data = array('H', range(25))
        metadata = {'width': 5, 'height': 5, 'spacingMeters': 100, 'west': 1000, 'north': 2000}
        cropped, result = crop_grid(data, metadata, [1110, 1710, 1190, 1790], 10)
        self.assertEqual(list(cropped), [11, 12, 16, 17])
        self.assertEqual((result['width'], result['height']), (2, 2))
        self.assertEqual((result['west'], result['north']), (1100, 1800))
        self.assertEqual(result['missingCells'], 0)

    def test_lzw_decodes_a_repeating_stream_with_growing_codes(self):
        # 256 clear, A, 258 (AA), 259 (AAA), 257 end: exercises the code defined by its own use.
        bits = ''.join(f'{code:09b}' for code in (256, 65, 258, 259, 257))
        bits += '0' * (-len(bits) % 8)
        self.assertEqual(lzw_decode(int(bits, 2).to_bytes(len(bits) // 8, 'big')), b'A' * 6)
        self.assertEqual(lzw_decode(lzw_literals(bytes(range(256)) * 3)), bytes(range(256)) * 3)

    def test_float_tiff_round_trip(self):
        with TemporaryDirectory() as temporary:
            path = Path(temporary) / 'tile.tif'
            float_tiff(path, 2, [1.5, 2.5, 3.5, 408.25])
            pixels, width, height = read_float_tiff(path.read_bytes())
            self.assertEqual((list(pixels), width, height), ([1.5, 2.5, 3.5, 408.25], 2, 2))

    def test_tile_bins_average_and_skip_missing_pixels(self):
        from array import array
        # Four 2 m pixels binned at 4 m: samples sit on multiples of 4 m.
        pixels = array('f', [10, 20, 30, 40, 50, 60, -9999, 80, 90, 100, 110, 120, 130, 140, 150, 160])
        bins = {(row, column): (total, count) for row, column, total, count in tile_bins(pixels, 4, 2, 4)}
        self.assertEqual(bins[(0, 0)], (10, 1))
        self.assertEqual(bins[(1, 1)], (60 + 100 + 110, 3), 'the missing pixel is excluded')
        self.assertEqual(sum(count for _, count in bins.values()), 15)

    def test_fine_grid_shares_coarse_outer_samples_and_fills_gaps(self):
        from array import array
        with TemporaryDirectory() as temporary:
            tile = Path(temporary) / '2600-1199.tif'
            float_tiff(tile, 500, [500.25] * 250000)
            metadata = {'width': 2, 'height': 2, 'spacingMeters': 2000, 'west': 600000.0, 'north': 200000.0}
            heights, fine, filled = fine_elevations(array('H', [100] * 4), metadata, 4, {'2600-1199': tile})
            self.assertEqual((fine['width'], fine['height'], fine['spacingMeters']), (5, 5, 500))
            self.assertEqual(fine['heightEncoding'], 'uint16-le-decimetres-LN02')
            self.assertEqual(heights[0], 5002, 'averaged tile value, in decimetres')
            self.assertEqual(heights[-1], 1000, 'no tile here: coarse grid, in decimetres')
            self.assertGreater(filled, 0)

    def test_tiles_for_mask_reach_across_tile_edges(self):
        # One mask pixel centred at LV95 (2600900, 1199500): 300 m reaches the next tile east only.
        metadata = {'width': 2, 'height': 2, 'spacingMeters': 1000, 'west': 600400.0, 'north': 200000.0}
        self.assertEqual(tiles_for_mask(bytes([255]), 1, 1, metadata, 300), {'2600-1199', '2601-1199'})

    def test_invalid_geometry_is_rejected(self):
        with self.assertRaises(ValueError):
            list(polygon_records(io.BytesIO(b'bad geometry')))
        with self.assertRaises(struct.error):
            dbf_records(b'')

    def test_png_has_correct_lossless_pixels(self):
        with TemporaryDirectory() as temporary:
            path = Path(temporary) / 'mask.png'
            png(path, 2, 2, bytes([0, 255, 128, 64]), 1)
            raw = path.read_bytes()
            self.assertTrue(raw.startswith(b'\x89PNG\r\n\x1a\n'))
            self.assertIn(zlib.compress(bytes([0,0,255,0,128,64]), 9), raw)

    def test_complete_bundle_records_sources_and_dimensions(self):
        with TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / 'elevation.asc').write_text(GRID)
            boundary_fixture(root / 'boundary.zip')
            config = {'spacingMeters': 400, 'maskWidth': 16,
                      'elevation': {'edition': 'test'}, 'boundary': {'edition': 'test'},
                      'observer': {'latitude': 46.8, 'longitude': 8.2, 'heightMeters': 500}}
            prepare(root / 'elevation.asc', root / 'boundary.zip', root / 'output', config)
            metadata = json.loads((root / 'output/metadata.json').read_text())
            self.assertEqual(metadata['countryBounds'], [600000, 199600, 600400, 200000])
            self.assertEqual(len((root / 'output/elevation.bin').read_bytes()), 8)
            self.assertEqual(struct.unpack('<4H', (root / 'output/elevation.bin').read_bytes()), (100, 300, 700, 900))
            self.assertEqual(len(metadata['sources']['elevation']['sha256']), 64)

    def test_download_rejects_unapproved_destinations_before_network(self):
        for url in ['http://data.geo.admin.ch/test.zip', 'https://example.com/test.zip']:
            with self.assertRaises(ValueError):
                download(url, Path('unused.zip'))


if __name__ == '__main__':
    unittest.main()
