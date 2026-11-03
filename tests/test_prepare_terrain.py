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
    country_rings, dbf_records, download, png, polygon_records,
    fallback, prepare, raster_mask, read_grid,
)


def boundary_fixture(destination: Path) -> None:
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
    dbf += b' CH '
    with ZipFile(destination, 'w') as archive:
        archive.writestr('TLM_LANDESGEBIET.shp', shp)
        archive.writestr('TLM_LANDESGEBIET.dbf', dbf)


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
