# comfyui-zh-tag-autocomplete

ComfyUI 中文标签补全：在节点的文本框里**直接打中文**，弹出对应的 Danbooru 英文标签供选择；也可以把整段中文提示词**一键翻译**成标签。字典里没有的中文（包括整句描述）用谷歌或 DeepSeek 翻译，适合 Anima 这类能理解自然语言的模型。

SD WebUI / Forge 版本见 [sd-webui-zh-tag-autocomplete](https://github.com/wangjue520/sd-webui-zh-tag-autocomplete)。

- 收录 Danbooru 图数 ≥50 的 **125,778** 个标签，每个标签带中文名与多个中文同义词
- 通用标签收录口语化说法，例如 `head_out_of_frame` ← 头部出画框 / 头部在画面外 / 没拍到头…；说法不完全一致时也会模糊匹配
- 角色、作品支持译名、简称和社区昵称，例如 `saber_(fate)` ← 吾王 / 呆毛王 / 骑士王

---

## 安装

**ComfyUI-Manager**：「Install via Git URL」填入 `https://github.com/wangjue520/comfyui-zh-tag-autocomplete`

**git**：

```bash
cd ComfyUI/custom_nodes
git clone https://github.com/wangjue520/comfyui-zh-tag-autocomplete
```

**压缩包**：下载 ZIP 解压到 `ComfyUI/custom_nodes/`，确保结构为 `custom_nodes/comfyui-zh-tag-autocomplete/__init__.py`。

装好后重启 ComfyUI。不需要安装任何 Python 依赖。

---

## 使用

### 1. 中文补全

在任意节点的多行文本框（CLIP 文本编码等）里输入中文，输入法上屏后弹出候选：

| 按键 | 作用 |
| --- | --- |
| ↑ / ↓ | 上下选择 |
| PageUp / PageDown | 翻 5 项 |
| Enter / Tab | 插入选中的标签 |
| Esc | 关闭候选 |
| 鼠标点击 | 插入该标签 |

- 候选按「完全匹配 → 开头匹配 → 包含 → 模糊匹配」排序，同级按 Danbooru 图数从多到少排列
- 分类颜色：蓝 = 通用，绿 = 角色，紫 = 作品，橙 = 元标签，红 = 画师，青 = 机器翻译
- 字典匹配不到或不够准时，会自动请求机器翻译，出现一条「翻译」候选（如 `头部在画面外` → `head out of frame`）；译文正好是某个标签时，该标签会被置顶
- 支持新旧两种节点界面（画布节点 / Vue 节点）

### 2. 实时翻译

打完一段中文再打逗号（`,` `，` `、`）或换行，前一段中文会**原地换成英文**，之后可以直接手改：

```
黑丝，            → black thighhighs, 
一个女孩坐在窗边看书， → a girl sitting by the window reading a book, 
```

字典能查到的用标签，查不到的（包括整句描述）用机器翻译；翻译失败时保留中文。不想要时在设置里关掉「实时翻译」。

### 3. 一键中译英

框里已有的中文，三种方式一次转换：

- 在文本框里按 **Alt+T**
- 节点右键菜单 →「中文 → 英文标签」（翻译该节点所有文本）
- 使用下面的节点，在运行时翻译

```
黑丝，头部在画面外、(一个女孩坐在窗边看书:1.2), <lora:xxx:0.8>
→ black thighhighs, head out of frame, (a girl sitting by the window reading a book:1.2), <lora:xxx:0.8>
```

权重 `(xx:1.2)`、`[xx]`、`{xx}` 和 `<lora:…>` 保持不变。

### 4. 节点

在「conditioning / 中文标签」下：

| 节点 | 输入 | 输出 |
| --- | --- | --- |
| 中文提示词翻译 | 文本、翻译引擎 | 英文提示词（STRING） |
| CLIP 文本编码（中文） | CLIP、文本、翻译引擎 | 条件、英文提示词 |

文本框里保留中文，运行时才翻译，方便以后修改。翻译引擎可选「跟随设置 / 谷歌 / DeepSeek / 仅字典」。

---

## 设置

「设置」→「中文标签补全」：

| 选项 | 默认 | 说明 |
| --- | --- | --- |
| 启用中文标签补全 | 开 | 总开关 |
| 候选数量上限 | 12 | 5–50 |
| 下划线替换为空格 | 开 | `long_hair` → `long hair` |
| 转义括号 | 开 | `saber_(fate)` → `saber \(fate\)` |
| 插入后自动追加逗号 | 开 | |
| 输入英文时也弹出补全 | 自动 | 自动：已启用 pysssss 自动补全时英文交给它，避免两个弹窗抢按键 |
| 候选中包含画师标签 | 开 | |
| 实时翻译 | 开 | 打下逗号/换行时把前一段中文原地换成英文 |
| 一键翻译快捷键 | Alt+T | |
| 翻译引擎 | 谷歌 | 谷歌：免费免 key 的网页接口（非官方，可能被限流）；DeepSeek：国内直连，懂提示词，倾向于直接给出标签写法，按量计费但单次花费极低；关闭：只用字典。DeepSeek 失败时自动改用谷歌 |
| 谷歌翻译使用的代理 | 空 | 国内网络需填代理，如 `http://127.0.0.1:7890` |
| DeepSeek API Key | 空 | 留空则读环境变量 `DEEPSEEK_API_KEY` |
| DeepSeek 接口地址 / 模型名 | `https://api.deepseek.com` / `deepseek-flash` | 也可填其他 OpenAI 兼容接口 |

翻译相关设置会同步保存到插件目录的 `config.json`，节点运行时也使用这份设置。

---

## 数据与许可

- 代码：MIT License
- 字典数据与制作脚本见 [danbooru-zh-dict](https://github.com/wangjue520/danbooru-zh-dict)；标签与别名来自 Danbooru，中文底稿来自 [amenorira/danbooru-tags-data-zh](https://github.com/amenorira/danbooru-tags-data-zh)（MIT），同义词扩展由大模型生成
- 字典包含成人内容标签的翻译
