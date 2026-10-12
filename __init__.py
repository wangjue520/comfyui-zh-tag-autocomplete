import asyncio

from aiohttp import web
from server import PromptServer

from . import zh_tags

WEB_DIRECTORY = "./web"

ENGINES = ["跟随设置", "谷歌", "DeepSeek", "仅字典"]
ENGINE_MAP = {"跟随设置": None, "谷歌": "谷歌", "DeepSeek": "DeepSeek", "仅字典": "关闭"}


# ---------- 前端接口 ----------

routes = PromptServer.instance.routes


@routes.get("/zh_tag_autocomplete/tags.json")
async def zhtac_tags(_request):
    return web.FileResponse(zh_tags.DATA_FILE, headers={"Content-Type": "application/json"})


@routes.get("/zh_tag_autocomplete/translate")
async def zhtac_translate(request):
    q = request.query.get("q", "").strip()[:500]
    if not q:
        return web.json_response({"text": ""})
    try:
        text = await asyncio.get_running_loop().run_in_executor(None, zh_tags.translate, q)
        return web.json_response({"text": text})
    except Exception as e:  # noqa: BLE001
        print(f"[zh-tag-autocomplete] {e}")
        return web.json_response({"text": "", "error": str(e)}, status=502)


@routes.post("/zh_tag_autocomplete/config")
async def zhtac_config(request):
    zh_tags.save_config(await request.json())
    return web.json_response({"ok": True})


# ---------- 节点 ----------

class ZhPromptTranslate:
    DESCRIPTION = "把提示词中的中文翻译为 Danbooru 标签；字典里没有的中文（包括整句描述）用谷歌或 DeepSeek 翻译。"
    CATEGORY = "conditioning/中文标签"
    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("英文提示词",)
    FUNCTION = "run"

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {
            "text": ("STRING", {"multiline": True, "dynamicPrompts": True}),
            "engine": (ENGINES, {"default": "跟随设置", "tooltip": "字典查不到的中文用哪个翻译；跟随设置 = 设置面板里选的引擎"}),
        }}

    def run(self, text, engine):
        out = zh_tags.translate_prompt(text, ENGINE_MAP[engine])
        print(f"[zh-tag-autocomplete] {out}")
        return (out,)


class ZhCLIPTextEncode(ZhPromptTranslate):
    DESCRIPTION = "先把中文翻译为英文标签，再用 CLIP 编码。"
    RETURN_TYPES = ("CONDITIONING", "STRING")
    RETURN_NAMES = ("条件", "英文提示词")
    FUNCTION = "encode"

    @classmethod
    def INPUT_TYPES(cls):
        req = super().INPUT_TYPES()["required"]
        return {"required": {"clip": ("CLIP",), **req}}

    def encode(self, clip, text, engine):
        out = self.run(text, engine)[0]
        tokens = clip.tokenize(out)
        return (clip.encode_from_tokens_scheduled(tokens), out)


NODE_CLASS_MAPPINGS = {
    "ZhPromptTranslate": ZhPromptTranslate,
    "ZhCLIPTextEncode": ZhCLIPTextEncode,
}
NODE_DISPLAY_NAME_MAPPINGS = {
    "ZhPromptTranslate": "中文提示词翻译",
    "ZhCLIPTextEncode": "CLIP 文本编码（中文）",
}
