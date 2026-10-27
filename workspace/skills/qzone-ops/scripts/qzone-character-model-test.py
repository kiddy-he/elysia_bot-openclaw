import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('draft', Path(__file__).with_name('qzone-draft.py'))
draft = importlib.util.module_from_spec(spec)
spec.loader.exec_module(draft)


class CharacterDraftTest(unittest.TestCase):
    def test_solo_and_interaction(self):
        draft.validate_character_draft('今天整理花束', '爱莉希雅俯身整理花束', {'mode': 'solo', 'characters': [{'name': '爱莉希雅'}]})
        draft.validate_character_draft('与伊甸一起品茶', '爱莉希雅沏茶，伊甸递上茶点', {'mode': 'interaction', 'characters': [{'name': '爱莉希雅'}, {'name': '伊甸'}]})

    def test_missing_or_changed_cast_is_rejected(self):
        plan = {'mode': 'interaction', 'characters': [{'name': '爱莉希雅'}, {'name': '伊甸'}]}
        for caption, scene, data in [('今天独自品茶', '爱莉希雅品茶', plan), ('与芽衣品茶', '爱莉希雅与芽衣品茶', plan), ('今天品茶', '爱莉希雅和伊甸品茶', plan), ('品茶', '爱莉希雅品茶', None), ('品茶', '爱莉希雅品茶', {'mode': 'solo', 'characters': []})]:
            with self.assertRaises(ValueError):
                draft.validate_character_draft(caption, scene, data)


if __name__ == '__main__':
    unittest.main()
