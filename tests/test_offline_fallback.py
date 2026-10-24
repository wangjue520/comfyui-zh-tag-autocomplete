import unittest
from unittest import mock

import zh_tags


class OfflineFallbackTests(unittest.TestCase):
    def setUp(self):
        zh_tags._translate_cached.cache_clear()
        zh_tags.reset_online_state()

    def tearDown(self):
        zh_tags._translate_cached.cache_clear()
        zh_tags.reset_online_state()

    def test_timeout_returns_empty_and_enters_local_mode(self):
        with mock.patch.object(zh_tags, "google_translate", side_effect=TimeoutError("Fetch timeout")) as online:
            self.assertEqual(zh_tags.translate("未收录词甲", "谷歌"), "")
            self.assertEqual(zh_tags.translate("未收录词乙", "谷歌"), "")
            self.assertEqual(online.call_count, 1)

    def test_dictionary_still_works_and_unknown_text_is_preserved(self):
        known_tag = zh_tags.get_dict().best_tag("黑丝")
        self.assertIsNotNone(known_tag)
        with mock.patch.object(zh_tags, "google_translate", side_effect=TimeoutError("Fetch timeout")):
            out = zh_tags.translate_prompt("黑丝，一个词典里没有的描述", "谷歌")
        self.assertEqual(out, f"{zh_tags.format_tag(known_tag)}, 一个词典里没有的描述")

    def test_failed_translation_preserves_weight_syntax(self):
        with mock.patch.object(zh_tags, "google_translate", side_effect=TimeoutError("Fetch timeout")):
            out = zh_tags.translate_prompt("(一个词典里没有的描述:1.2)", "谷歌")
        self.assertEqual(out, "(一个词典里没有的描述:1.2)")

    def test_local_only_mode_never_calls_network(self):
        with mock.patch.object(zh_tags, "google_translate") as online:
            self.assertEqual(zh_tags.translate("任何中文", "关闭"), "")
            online.assert_not_called()

    def test_online_translation_can_recover_after_reset(self):
        with mock.patch.object(zh_tags, "google_translate", side_effect=TimeoutError("Fetch timeout")):
            self.assertEqual(zh_tags.translate("未收录词", "谷歌"), "")
        zh_tags.reset_online_state()
        with mock.patch.object(zh_tags, "google_translate", return_value="A Test Phrase。"):
            self.assertEqual(zh_tags.translate("未收录词", "谷歌"), "a test phrase")

    def test_deepseek_and_google_failure_does_not_raise(self):
        with mock.patch.object(zh_tags, "deepseek_translate", side_effect=TimeoutError("DeepSeek timeout")), \
                mock.patch.object(zh_tags, "google_translate", side_effect=OSError("Network unreachable")):
            self.assertEqual(zh_tags.translate("未收录词", "DeepSeek"), "")

    def test_mixed_segment_only_sends_chinese_to_online_translation(self):
        with mock.patch.object(zh_tags, "google_translate", return_value="a translated phrase") as online:
            out = zh_tags.translate_prompt("一个词典里没有的描述1girl", "谷歌")
        self.assertEqual(out, "a translated phrase 1girl")
        online.assert_called_once_with("一个词典里没有的描述")

    def test_mixed_dictionary_translation_preserves_english_and_weight(self):
        known_tag = zh_tags.get_dict().best_tag("黑丝")
        with mock.patch.object(zh_tags, "google_translate") as online:
            out = zh_tags.translate_prompt("(黑丝1girl:1.2)", "谷歌")
        self.assertEqual(out, f"({zh_tags.format_tag(known_tag)} 1girl:1.2)")
        online.assert_not_called()

    def test_mixed_offline_failure_preserves_original_english_tag(self):
        with mock.patch.object(zh_tags, "google_translate", side_effect=TimeoutError("Fetch timeout")) as online:
            out = zh_tags.translate_prompt("1girl一个词典里没有的描述", "谷歌")
        self.assertEqual(out, "1girl一个词典里没有的描述")
        online.assert_called_once_with("一个词典里没有的描述")


if __name__ == "__main__":
    unittest.main()
