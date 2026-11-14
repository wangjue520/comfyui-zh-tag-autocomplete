import asyncio
import importlib.util
import json
from pathlib import Path
import sys
from types import SimpleNamespace
import unittest
from unittest import mock


class Routes:
    def get(self, _path):
        return lambda func: func

    def post(self, _path):
        return lambda func: func


class PromptServer:
    instance = SimpleNamespace(routes=Routes())


def load_plugin():
    # ComfyUI 运行依赖用最小替身代替，测试不需要额外安装软件包。
    server = type(sys)("server")
    server.PromptServer = PromptServer
    sys.modules["server"] = server
    aiohttp = type(sys)("aiohttp")
    aiohttp.web = SimpleNamespace(
        json_response=lambda data, status=200: SimpleNamespace(status=status, text=json.dumps(data)),
        FileResponse=lambda *args, **kwargs: SimpleNamespace(args=args, kwargs=kwargs),
    )
    sys.modules["aiohttp"] = aiohttp
    root = Path(__file__).resolve().parents[1]
    name = "zh_tag_autocomplete_route_test"
    spec = importlib.util.spec_from_file_location(
        name, root / "__init__.py", submodule_search_locations=[str(root)]
    )
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


class TranslateRouteTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.plugin = load_plugin()

    def setUp(self):
        self.plugin.zh_tags.reset_online_state()

    def tearDown(self):
        self.plugin.zh_tags.reset_online_state()

    def test_unexpected_translation_error_still_returns_local_success(self):
        request = SimpleNamespace(query={"q": "未收录中文"})
        with mock.patch.object(self.plugin.zh_tags, "translate", side_effect=TimeoutError("Fetch timeout")):
            response = asyncio.run(self.plugin.zhtac_translate(request))
        self.assertEqual(response.status, 200)
        self.assertEqual(json.loads(response.text), {
            "text": "", "local": True, "offline": True, "retry_after": 60,
        })

    def test_empty_query_stays_local(self):
        request = SimpleNamespace(query={"q": ""})
        response = asyncio.run(self.plugin.zhtac_translate(request))
        self.assertEqual(response.status, 200)
        self.assertEqual(json.loads(response.text), {"text": "", "local": True, "offline": False})

    def test_node_unexpected_error_preserves_prompt_and_returns(self):
        node = self.plugin.ZhPromptTranslate()
        with mock.patch.object(self.plugin.zh_tags, "translate_prompt", side_effect=RuntimeError("broken translator")):
            self.assertEqual(node.run("保留这段中文", "跟随设置"), ("保留这段中文",))


if __name__ == "__main__":
    unittest.main()
