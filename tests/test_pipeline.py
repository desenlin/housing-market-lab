import unittest

from pipeline.update_data import compact_json, parse_value


class PipelineHelpersTest(unittest.TestCase):
    def test_parse_value_handles_missing_and_rounding(self):
        self.assertIsNone(parse_value("", 0))
        self.assertIsNone(parse_value("NA", 2))
        self.assertEqual(parse_value("123.7", 0), 124)
        self.assertEqual(parse_value("0.123456", 5), 0.12346)

    def test_compact_json_is_deterministic_and_compact(self):
        self.assertEqual(compact_json({"a": [1, 2]}), b'{"a":[1,2]}')


if __name__ == "__main__":
    unittest.main()
