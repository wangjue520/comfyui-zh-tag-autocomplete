# 字典查询与机器翻译（谷歌 / DeepSeek），供前端接口和节点共用
import json
import os
import re
import threading
import urllib.parse
import urllib.request
from functools import lru_cache

NODE_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_FILE = os.path.join(NODE_DIR, "data", "tags.json")
CONFIG_FILE = os.path.join(NODE_DIR, "config.json")

CJK = re.compile(r"[㐀-鿿豈-﫿]")
PINYIN_RESIDUE = re.compile(r"^[a-z']+\s*(?=[㐀-鿿])")
WEIGHT = re.compile(r"^(\s*[(\[{]*)(.*?)((?::[\d.]+)?[)\]}]*\s*)$", re.S)
KEEP_UNDERSCORE = {"0_0", "(o)_(o)", "+_+", "+_-", "._.", "<o>_<o>", "<|>_<|>", "=_=", ">_<", "3_3", "6_9", ">_o",
                   "@_@", "^_^", "o_o", "u_u", "x_x", "|_|", "||_||"}

DEFAULT_CONFIG = {
    "engine": "谷歌",  # 谷歌 / DeepSeek / 关闭
    "proxy": "",
    "deepseek_key": "",
    "deepseek_base": "https://api.deepseek.com",
    "deepseek_model": "deepseek-flash",
    "replace_underscores": True,
    "escape_parentheses": True,
}

_config = dict(DEFAULT_CONFIG)
_config_lock = threading.Lock()


def load_config():
    if os.path.exists(CONFIG_FILE):
        try:
            with open(CONFIG_FILE, encoding="utf-8") as f:
                _config.update({k: v for k, v in json.load(f).items() if k in DEFAULT_CONFIG})
        except Exception as e:  # noqa: BLE001
            print(f"[zh-tag-autocomplete] 读取 config.json 失败: {e}")


def save_config(new):
    """前端设置变化时调用，保存到 config.json，节点执行时也用这份设置"""
    with _config_lock:
        changed = False
        for k, v in new.items():
            if k in DEFAULT_CONFIG and _config.get(k) != v:
                _config[k] = v
                changed = True
        if changed:
            translate.cache_clear()
            with open(CONFIG_FILE, "w", encoding="utf-8") as f:
                json.dump(_config, f, ensure_ascii=False, indent=2)


def cfg(key):
    return _config.get(key, DEFAULT_CONFIG[key])


load_config()


# ---------- 字典 ----------

class Dictionary:
    def __init__(self):
        with open(DATA_FILE, encoding="utf-8") as f:
            rows = json.load(f)
        self.by_tag = {}
        self.by_zh = {}
        self.by_alias = {}
        self.terms = []  # (所有中文词, count, tag)，用于前缀匹配
        for tag, cat, count, zh, syn, alias, _note in rows:
            self.by_tag[tag] = count
            terms = [t for t in [zh] + (syn.split("|") if syn else []) if t]
            for t in terms:
                best = self.by_zh.get(t)
                if not best or count > best[1]:
                    self.by_zh[t] = (tag, count)
            if terms:
                self.terms.append((terms, count, tag))
            for a in (alias.split("|") if alias else []):
                a = a.lower()
                best = self.by_alias.get(a)
                if not best or count > best[1]:
                    self.by_alias[a] = (tag, count)

    def best_tag(self, term):
        """中文词 → 最常用的标签：先完全匹配，再取某个中文词以它开头的标签"""
        hit = self.by_zh.get(term)
        if hit:
            return hit[0]
        best = None
        for terms, count, tag in self.terms:
            if (not best or count > best[1]) and any(t.startswith(term) for t in terms):
                best = (tag, count)
        return best[0] if best else None

    def tag_for_english(self, en):
        """译文恰好是标签/别名时（如 head out of frame）返回标签"""
        t = normalize_tag(en)
        if t in self.by_tag:
            return t
        hit = self.by_alias.get(t)
        return hit[0] if hit else None


_dict = None
_dict_lock = threading.Lock()


def get_dict():
    global _dict
    with _dict_lock:
        if _dict is None:
            _dict = Dictionary()
            print(f"[zh-tag-autocomplete] loaded {len(_dict.by_tag)} tags")
    return _dict


def normalize_tag(text):
    return re.sub(r"\\([()])", r"\1", text.strip()).replace(" ", "_").lower()


def format_tag(tag):
    if cfg("replace_underscores") and tag not in KEEP_UNDERSCORE:
        tag = tag.replace("_", " ")
    if cfg("escape_parentheses"):
        tag = re.sub(r"([()])", r"\\\1", tag)
    return tag


def format_phrase(text):
    return re.sub(r"([()])", r"\\\1", text) if cfg("escape_parentheses") else text


# ---------- 机器翻译 ----------

GOOGLE_URLS = [
    ("https://clients5.google.com/translate_a/t?client=dict-chrome-ex&sl=zh-CN&tl=en&q={q}", "dict"),
    ("https://translate.googleapis.com/translate_a/single?client=gtx&sl=zh-CN&tl=en&dt=t&q={q}", "gtx"),
]

DEEPSEEK_PROMPT = (
    "把下面这段 Stable Diffusion 提示词里的中文翻译成英文。"
    "如果它对应某个 Danbooru 标签，直接输出该标签（下划线换成空格，如 head out of frame）；"
    "否则输出简洁自然的英文短语。全部小写，只输出译文，不要解释、引号或句号。\n\n"
)


def _opener():
    proxy = (cfg("proxy") or "").strip()
    if proxy:
        return urllib.request.build_opener(urllib.request.ProxyHandler({"http": proxy, "https": proxy}))
    return urllib.request.build_opener()  # 未设置时沿用系统环境变量 HTTP(S)_PROXY


def google_translate(text):
    q = urllib.parse.quote(text)
    last = None
    for url, kind in GOOGLE_URLS:
        try:
            req = urllib.request.Request(url.format(q=q), headers={"User-Agent": "Mozilla/5.0"})
            with _opener().open(req, timeout=8) as r:
                data = json.loads(r.read().decode("utf-8"))
            if kind == "dict":
                first = data[0]  # ["译文"] 或 [["译文", "zh-CN"]]
                out = first[0] if isinstance(first, list) else first
            else:
                out = "".join(part[0] for part in data[0] if part and part[0])
            if out:
                return out
        except Exception as e:  # noqa: BLE001
            last = e
    raise RuntimeError(f"google translate failed: {last}")


def deepseek_translate(text):
    key = (cfg("deepseek_key") or "").strip() or os.environ.get("DEEPSEEK_API_KEY", "")
    if not key:
        raise RuntimeError("未设置 DeepSeek API Key")
    base = (cfg("deepseek_base") or "https://api.deepseek.com").strip().rstrip("/")
    model = (cfg("deepseek_model") or "deepseek-flash").strip()
    req = urllib.request.Request(
        f"{base}/chat/completions",
        data=json.dumps({
            "model": model,
            "messages": [{"role": "user", "content": DEEPSEEK_PROMPT + text}],
            "temperature": 0,
            "max_tokens": 300,
            "thinking": {"type": "disabled"},  # 不开思考：快且省，否则思考会占满 max_tokens 导致译文为空
        }).encode("utf-8"),
        headers={"Content-Type": "application/json", "Authorization": f"Bearer {key}"},
    )
    with urllib.request.urlopen(req, timeout=20) as r:
        out = json.loads(r.read().decode("utf-8"))["choices"][0]["message"]["content"]
    out = out.strip().strip("\"'“”").strip()
    if not out:
        raise RuntimeError("DeepSeek 返回为空")
    return out


@lru_cache(maxsize=4096)
def translate(text, engine=None):
    """返回小写译文；engine 为 None 时用设置里的引擎"""
    engine = engine or cfg("engine")
    if engine == "关闭":
        return ""
    out = None
    if engine == "DeepSeek":
        try:
            out = deepseek_translate(text)
        except Exception as e:  # noqa: BLE001
            print(f"[zh-tag-autocomplete] DeepSeek 翻译失败，改用谷歌: {e}")
    if out is None:
        out = google_translate(text)
    return re.sub(r"[.。]+$", "", out.strip()).lower()


# ---------- 整段翻译 ----------

def split_weight(seg):
    m = WEIGHT.match(seg)
    return (m.group(1), m.group(2), m.group(3)) if m else ("", seg, "")


def translate_prompt(text, engine=None):
    """字典优先；查不到的中文片段（包括整句描述）交给机器翻译，失败则原样保留"""
    d = get_dict()

    def seg_out(seg):
        if not CJK.search(seg) or re.search(r"<[^>]*>", seg):
            return seg.strip()
        pre, core, post = split_weight(seg)
        term = PINYIN_RESIDUE.sub("", core.strip())
        tag = d.best_tag(term)
        if tag:
            return (pre + format_tag(tag) + post).strip()
        try:
            en = translate(term, engine)
        except Exception as e:  # noqa: BLE001
            print(f"[zh-tag-autocomplete] {e}")
            en = ""
        if not en:
            return seg.strip()
        tag = d.tag_for_english(en)
        return (pre + (format_tag(tag) if tag else format_phrase(en)) + post).strip()

    lines = []
    for line in text.split("\n"):
        if not CJK.search(line):
            lines.append(line)
            continue
        segs = [seg_out(s) for s in re.split(r"[,，、]", line)]
        lines.append(", ".join(s for i, s in enumerate(segs) if s or i < len(segs) - 1))
    return "\n".join(lines)
