"""Room-name and speaker regressions without a running app or archive service."""

import os
import unittest
from unittest.mock import patch

from transcript_speech import clean_room_name, house_room_names, user_speech


class RoomNamesTest(unittest.TestCase):
    def test_list_skips_invalid_entries_and_keeps_single_names(self):
        self.assertEqual(house_room_names({
            'EMBERVY_ROOM_NAME': ' Studio! ',
            'ROOM_NAME': ' Gallery ',
            'EMBERVY_ROOMS': '[null,{},[],3,{"name":false},{"name":""},{"name":"  "},{"name":"Café_二"},{"name":"Studio"}]',
        }), {'Studio', 'Gallery', 'Café_二', 'Room'})

    def test_bad_json_and_non_lists_preserve_single_names(self):
        for value in ('[broken', 'null', '{}', '3', '"Studio"'):
            with self.subTest(value=value):
                self.assertEqual(house_room_names({'ROOM_NAME': 'Gallery', 'EMBERVY_ROOMS': value}), {'Gallery'})

    def test_cleaning_uses_app_filter_and_utf16_limit(self):
        self.assertEqual(clean_room_name(' Cafe\u0301 / North! '), 'Cafe  North')
        self.assertEqual(clean_room_name('!?'), 'Room')
        self.assertEqual(clean_room_name('𐐀' * 25), '𐐀' * 20)
        self.assertEqual(clean_room_name('x' + '𐐀' * 25), 'x' + '𐐀' * 19 + '\ud801')
        for value in (None, False, 12, '', ' \t\ufeff'):
            self.assertIsNone(clean_room_name(value))

    def test_default_name_uses_only_the_internal_presence_bit(self):
        for bit, expected in (('1', {'Room'}), ('', set()), ('true', set()), (None, set())):
            with self.subTest(bit=bit):
                env = {'_TRANSCRIPT_ROOM_URL_PRESENT': bit}
                self.assertEqual(house_room_names(env), expected)
                self.assertEqual(house_room_names(dict(env, EMBERVY_ROOM_NAME='  ')), expected)
                self.assertEqual(house_room_names(dict(env, EMBERVY_ROOM_NAME='Studio')), {'Studio'})
        # Python does not inspect a URL or token, even if a caller supplies one.
        self.assertEqual(house_room_names({'EMBERVY_ROOM_URL': 'not inspected', 'EMBERVY_ROOM_TOKEN': 'not inspected'}), set())
        self.assertEqual(house_room_names({'_TRANSCRIPT_ROOM_URL_PRESENT': '1', 'ROOM_NAME': 'Legacy'}), {'Room', 'Legacy'})

    def test_environment_is_read_at_call_time_without_mutation(self):
        with patch.dict(os.environ, {}, clear=True):
            self.assertEqual(house_room_names(), set())
            os.environ['EMBERVY_ROOMS'] = '[{"name":"Studio"},{"name":"Gallery"}]'
            before = dict(os.environ)
            for text, expected in (
                ('[Studio/Robin] hi', 'Robin'),
                ('[Gallery/Alex] hi', 'Alex'),
                ('[Direct/Robin] hi', 'Robin'),
                ('[Draft/2] x', 'Owner'),
                ('[Room/Robin] hi', 'Owner'),
            ):
                entry = {'type': 'user', 'message': {'role': 'user', 'content': text}}
                self.assertEqual(user_speech(entry, 'Owner'), [(expected, text)])
            self.assertEqual(dict(os.environ), before)


if __name__ == '__main__':
    unittest.main()
