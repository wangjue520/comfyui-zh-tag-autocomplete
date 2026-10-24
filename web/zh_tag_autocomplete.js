// 中文标签补全（ComfyUI 版）：在节点的多行文本框里输入中文/英文弹出 Danbooru 标签候选，选择后插入英文标签；
// 字典里没有的中文用谷歌 / DeepSeek 翻译；Alt+T 或节点右键菜单一键把中文翻译为标签。
import { app } from "../../scripts/app.js";

const DATA_URL = "/zh_tag_autocomplete/tags.json";
const CAT_NAME = { 0: "通用", 1: "画师", 3: "作品", 4: "角色", 5: "元" };
const CJK = /[㐀-鿿豈-﫿]/;
const SEP = /[,，、\n]/;
// 输入法拼写中途失焦会把拼音残留上屏（如 "chu初音"）
const PINYIN_RESIDUE = /^[a-z']+\s*(?=[㐀-鿿])/;
// 这些颜文字类标签保留下划线
const KEEP_UNDERSCORE = new Set(["0_0", "(o)_(o)", "+_+", "+_-", "._.", "<o>_<o>", "<|>_<|>", "=_=", ">_<", "3_3", "6_9", ">_o", "@_@", "^_^", "o_o", "u_u", "x_x", "|_|", "||_||"]);

// ---------- 设置 ----------

const CATEGORY = "中文标签补全";
const SETTINGS = [
    { id: "ZhTag.Enabled", name: "启用中文标签补全", type: "boolean", defaultValue: true, section: "补全" },
    { id: "ZhTag.MaxResults", name: "候选数量上限", type: "slider", attrs: { min: 5, max: 50, step: 1 }, defaultValue: 12, section: "补全" },
    { id: "ZhTag.ReplaceUnderscores", name: "插入时把下划线替换为空格（如 long_hair → long hair）", type: "boolean", defaultValue: true, section: "补全", backend: "replace_underscores" },
    { id: "ZhTag.EscapeParentheses", name: "插入时转义括号（如 saber_(fate) → saber \\(fate\\)）", type: "boolean", defaultValue: true, section: "补全", backend: "escape_parentheses" },
    { id: "ZhTag.AppendComma", name: "插入后自动追加逗号", type: "boolean", defaultValue: true, section: "补全" },
    { id: "ZhTag.EnglishSearch", name: "输入英文时也弹出补全（自动：已启用 pysssss 自动补全时交给它）", type: "combo", options: ["自动", "开启", "关闭"], defaultValue: "自动", section: "补全" },
    { id: "ZhTag.IncludeArtists", name: "候选中包含画师标签", type: "boolean", defaultValue: true, section: "补全" },
    { id: "ZhTag.AutoTranslateV2", name: "实时翻译：打下逗号/换行时，把前一段中文原地换成英文（之后可手动修改）", type: "boolean", defaultValue: true, section: "补全" },
    { id: "ZhTag.Hotkey", name: "一键把中文翻译为标签的快捷键", type: "text", defaultValue: "Alt+T", section: "补全" },
    { id: "ZhTag.Engine", name: "字典里没有的中文用哪个翻译（DeepSeek 失败时自动改用谷歌）", type: "combo", options: ["谷歌", "DeepSeek", "关闭"], defaultValue: "谷歌", section: "翻译", backend: "engine" },
    { id: "ZhTag.Proxy", name: "谷歌翻译使用的代理（如 http://127.0.0.1:7890，留空则用系统环境变量）", type: "text", defaultValue: "", section: "翻译", backend: "proxy" },
    { id: "ZhTag.DeepSeekKey", name: "DeepSeek API Key（留空则读环境变量 DEEPSEEK_API_KEY）", type: "text", defaultValue: "", section: "翻译", backend: "deepseek_key" },
    { id: "ZhTag.DeepSeekBase", name: "DeepSeek 接口地址（也可填其他 OpenAI 兼容接口）", type: "text", defaultValue: "https://api.deepseek.com", section: "翻译", backend: "deepseek_base" },
    { id: "ZhTag.DeepSeekModel", name: "DeepSeek 模型名", type: "text", defaultValue: "deepseek-flash", section: "翻译", backend: "deepseek_model" },
];
const DEFAULTS = Object.fromEntries(SETTINGS.map((s) => [s.id, s.defaultValue]));

function opt(id) {
    let v;
    try {
        v = app.extensionManager?.setting?.get ? app.extensionManager.setting.get(id) : app.ui.settings.getSettingValue(id);
    } catch { /* 设置尚未加载 */ }
    return v === undefined || v === null ? DEFAULTS[id] : v;
}

// 翻译相关设置同步到后端（config.json），节点执行时也用这份
let pushTimer = null;
function pushConfig() {
    clearTimeout(pushTimer);
    pushTimer = setTimeout(() => {
        const body = {};
        for (const s of SETTINGS) if (s.backend) body[s.backend] = opt(s.id);
        fetch("/zh_tag_autocomplete/config", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
            .catch(() => {});
        gtCache.clear();
        gtDone.clear();
    }, 300);
}

// ---------- 数据加载与索引 ----------

// 数据：每条为 {tag, cat, count, zh, syn[], alias[], note, zhAll, tagL}
let entries = null;
const byTag = new Map();
const byZh = new Map();
let loading = null;

function loadData() {
    if (loading) return loading;
    loading = fetch(DATA_URL)
        .then((r) => r.json())
        .then((rows) => {
            entries = rows.map(([tag, cat, count, zh, syn, alias, note]) => {
                const synArr = syn ? syn.split("|") : [];
                const aliasArr = alias ? alias.split("|") : [];
                const e = {
                    tag, cat, count, zh, note,
                    syn: synArr,
                    alias: aliasArr,
                    zhAll: [zh, ...synArr].join("|"),
                    tagL: tag.toLowerCase(),
                    aliasL: aliasArr.join("|").toLowerCase(),
                };
                byTag.set(tag, e);
                for (const term of [zh, ...synArr]) {
                    if (!term) continue;
                    const list = byZh.get(term);
                    if (list) list.push(e);
                    else byZh.set(term, [e]);
                }
                return e;
            });
            console.log(`[zh-tag-autocomplete] loaded ${entries.length} tags`);
        })
        .catch((err) => {
            console.error("[zh-tag-autocomplete] failed to load tags", err);
            loading = null;
        });
    return loading;
}

// ---------- 搜索 ----------

// 返回 [{e, score, hit}]，score 越小越靠前；hit 为命中的中文词（用于显示）
function search(query, limit) {
    if (!entries || !query) return [];
    const includeArtists = opt("ZhTag.IncludeArtists");
    const out = [];
    if (CJK.test(query)) {
        for (const e of entries) {
            if (e.zhAll.indexOf(query) === -1) continue;
            if (e.cat === 1 && !includeArtists) continue;
            let score = 9, hit = "";
            const terms = [e.zh, ...e.syn];
            for (let i = 0; i < terms.length; i++) {
                const t = terms[i];
                if (!t) continue;
                const s = t === query ? (i === 0 ? 0 : 1) : t.startsWith(query) ? 2 : t.includes(query) ? 3 : 9;
                if (s < score) { score = s; hit = t; }
            }
            out.push({ e, score, hit });
        }
        if (out.length < limit) out.push(...fuzzySearch(query, new Set(out.map((r) => r.e)), includeArtists));
    } else {
        if (!englishSearchEnabled()) return [];
        out.push(...searchEnglish(query, includeArtists));
    }
    out.sort((a, b) => a.score - b.score || b.e.count - a.e.count);
    return out.slice(0, limit);
}

// 模糊匹配：子串找不到时（如“头部在画面外” vs “头部出画框”），按字与相邻两字的重合度打分
function fuzzySearch(query, exclude, includeArtists) {
    const q = query.trim();
    if (q.length < 3) return [];
    const grams = [...new Set(Array.from({ length: q.length - 1 }, (_, i) => q.slice(i, i + 2)))];
    const chars = [...new Set(q)];
    const out = [];
    for (const e of entries) {
        if (exclude.has(e) || !e.zhAll || (e.cat === 1 && !includeArtists)) continue;
        if (!grams.some((g) => e.zhAll.includes(g))) continue; // 快速排除
        let best = 0, hit = "";
        for (const t of [e.zh, ...e.syn]) {
            if (!t) continue;
            const gc = grams.filter((g) => t.includes(g)).length / grams.length;
            const cc = chars.filter((c) => t.includes(c)).length / chars.length;
            // 词本身也要大部分被查询覆盖，避免长词因包含常见字而入选
            const back = [...new Set(t)].filter((c) => q.includes(c)).length / new Set(t).size;
            const s = (gc + cc + back) / 3;
            if (s > best) { best = s; hit = t; }
        }
        if (best >= 0.5) out.push({ e, score: 5 - best, hit });
    }
    return out;
}

function searchEnglish(query, includeArtists) {
    const out = [];
    const q = query.toLowerCase().trim().replace(/\s+/g, "_").replace(/\\([()])/g, "$1");
    if (!q) return out;
    for (const e of entries) {
        if (e.cat === 1 && !includeArtists) continue;
        let score = 9, hit = "";
        if (e.tagL === q) score = 0;
        else if (e.tagL.startsWith(q)) score = 1;
        else if (e.aliasL && ("|" + e.aliasL + "|").includes("|" + q + "|")) { score = 1; hit = q; }
        else if (e.tagL.includes("_" + q) || e.tagL.includes("(" + q)) score = 2;
        else if (e.aliasL && e.aliasL.includes(q)) {
            const a = e.alias.find((x) => x.toLowerCase().includes(q));
            const al = a ? a.toLowerCase() : "";
            score = al === q ? 1 : al.startsWith(q) ? 2 : 3;
            hit = a || "";
        } else if (q.length >= 3 && e.tagL.includes(q)) score = 3;
        if (score < 9) out.push({ e, score, hit });
    }
    return out;
}

// 已启用 pysssss 自动补全时英文补全交给它，避免两个弹窗抢 Enter/Tab
function englishSearchEnabled() {
    const mode = opt("ZhTag.EnglishSearch");
    if (mode === "开启") return true;
    if (mode === "关闭") return false;
    const pysssss = (app.extensions || []).some((e) => e.name === "pysssss.AutoCompleter");
    let on = false;
    try { on = pysssss && opt("pysssss.AutoCompleter") !== false; } catch { /* 无此设置 */ }
    return !on;
}

// 中文词 → 最佳标签（用于一键翻译）
function bestTagFor(term) {
    const exact = byZh.get(term);
    if (exact) return exact.reduce((a, b) => (b.count > a.count ? b : a));
    const r = search(term, 1)[0];
    return r && r.score <= 2 ? r.e : null;
}

// ---------- 机器翻译（经后端转发） ----------

const gtCache = new Map(); // 中文 → Promise<译文|null>
const gtDone = new Map(); // 中文 → 译文（已完成的，供同步读取）

function machineTranslate(text) {
    text = text.trim();
    if (!text || opt("ZhTag.Engine") === "关闭") return Promise.resolve(null);
    if (gtCache.has(text)) return gtCache.get(text);
    const p = fetch(`/zh_tag_autocomplete/translate?q=${encodeURIComponent(text)}`)
        .then((r) => (r.ok ? r.json() : null))
        .then((j) => {
            const t = j && j.text ? j.text.trim().replace(/[.。]+$/, "").toLowerCase() : null;
            if (t) gtDone.set(text, t);
            else gtCache.delete(text); // 失败不缓存，下次重试
            return t;
        })
        .catch(() => { gtCache.delete(text); return null; });
    gtCache.set(text, p);
    return p;
}

// 译文 → 标签：译文恰好是标签/别名时（如 "head out of frame"）直接用标签
function tagForEnglish(en) {
    const e = byTag.get(normalizeTag(en));
    if (e) return e;
    const r = searchEnglish(en, true).filter((x) => x.score === 0 || (x.score === 1 && x.hit))
        .sort((a, b) => a.score - b.score || b.e.count - a.e.count)[0];
    return r ? r.e : null;
}

// ---------- 标签格式化 ----------

function formatTag(tag) {
    let t = tag;
    if (opt("ZhTag.ReplaceUnderscores") && !KEEP_UNDERSCORE.has(t)) t = t.replace(/_/g, " ");
    if (opt("ZhTag.EscapeParentheses")) t = t.replace(/([()])/g, "\\$1");
    return t;
}

function formatPhrase(text) {
    return opt("ZhTag.EscapeParentheses") ? text.replace(/([()])/g, "\\$1") : text;
}

function normalizeTag(text) {
    return text.trim().replace(/\\([()])/g, "$1").replace(/ /g, "_").toLowerCase();
}

// 拆出权重语法：(xxx:1.2) / [xxx] / {xxx}
function splitWeight(seg) {
    const m = seg.match(/^(\s*[(\[{]*)(.*?)((?::[\d.]+)?[)\]}]*\s*)$/s);
    return m ? [m[1], m[2], m[3]] : ["", seg, ""];
}

function formatCount(n) {
    if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
    if (n >= 1e3) return (n / 1e3).toFixed(1) + "k";
    return String(n);
}

// ---------- 当前输入词 ----------

function currentToken(textarea) {
    const pos = textarea.selectionStart;
    if (pos !== textarea.selectionEnd) return null;
    const text = textarea.value;
    let start = pos;
    while (start > 0 && !SEP.test(text[start - 1])) start--;
    let raw = text.slice(start, pos);
    // 跳过前导空格与权重括号
    const lead = raw.match(/^[\s(\[{]*/)[0];
    start += lead.length;
    raw = raw.slice(lead.length);
    if (!raw || /[:<>]/.test(raw)) return null; // 权重/LoRA 语法中不补全
    // 有拼音残留时只用中文部分搜索，替换范围仍从残留开头算起，选中后一并替换掉
    const m = raw.match(PINYIN_RESIDUE);
    return { start, end: pos, text: m ? raw.slice(m[0].length) : raw };
}

// 光标所在的整段（上一个分隔符之后到 pos，含前导空格）
function segmentAt(ta, pos) {
    const v = ta.value;
    let start = pos;
    while (start > 0 && !SEP.test(v[start - 1])) start--;
    return { start, text: v.slice(start, pos) };
}

// 这一段改过（多打/删了字）就不再算被拒绝
function isDismissed(ta, start, text) {
    const d = state.dismissed;
    return !!d && d.ta === ta && d.start === start && d.text === text;
}

// ---------- 弹窗 ----------

let popup = null;
// dismissed：按 Esc 拒绝的那一段 {ta, start, text}，这段不再弹候选、打逗号时也不实时翻译
const state = { textarea: null, results: [], index: 0, tokenStart: 0, tokenEnd: 0, dismissed: null };
let suppressInput = false;
let searchTimer = null;

function ensurePopup() {
    if (popup) return popup;
    popup = document.createElement("div");
    popup.id = "zhtac-popup";
    popup.addEventListener("mousedown", (ev) => {
        ev.preventDefault(); // 不让 textarea 失焦
        ev.stopPropagation();
        const item = ev.target.closest(".zhtac-item");
        if (item) choose(Number(item.dataset.i));
    });
    popup.addEventListener("wheel", (ev) => ev.stopPropagation(), { passive: true }); // 滚动候选时不缩放画布
    document.body.appendChild(popup);
    return popup;
}

function hidePopup() {
    if (popup) popup.style.display = "none";
    state.results = [];
}

function escapeHtml(s) {
    return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

function renderPopup() {
    const p = ensurePopup();
    if (!state.results.length) return hidePopup();
    p.innerHTML = state.results
        .map(({ e, hit, gt, src }, i) => {
            const cls = `zhtac-item${i === state.index ? " zhtac-active" : ""}`;
            if (gt) {
                return `<div class="${cls}" data-i="${i}" title="机器翻译，插入译文原文">
                    <span class="zhtac-cat zhtac-cat-gt">翻译</span>
                    <span class="zhtac-tag">${escapeHtml(gt)}</span>
                    <span class="zhtac-zh">${escapeHtml(src)}</span>
                </div>`;
            }
            const extra = hit && hit !== e.zh ? `<span class="zhtac-hit">≈${escapeHtml(hit)}</span>` : "";
            const title = e.note ? ` title="${escapeHtml(e.note)}"` : "";
            return `<div class="${cls}" data-i="${i}"${title}>
                <span class="zhtac-cat zhtac-cat-${e.cat}">${CAT_NAME[e.cat] || ""}</span>
                <span class="zhtac-tag">${escapeHtml(e.tag)}</span>
                <span class="zhtac-zh">${escapeHtml(e.zh)}</span>${extra}
                <span class="zhtac-count">${formatCount(e.count)}</span>
            </div>`;
        })
        .join("");
    p.style.display = "block";
    positionPopup();
    const active = p.querySelector(".zhtac-active");
    if (active) active.scrollIntoView({ block: "nearest" });
}

// 用镜像 div 计算光标在视口中的坐标；画布缩放时文本框带 CSS transform，需要按比例换算
function caretCoords(textarea, pos) {
    const style = getComputedStyle(textarea);
    const div = document.createElement("div");
    for (const prop of ["boxSizing", "width", "fontFamily", "fontSize", "fontWeight", "lineHeight", "letterSpacing",
        "paddingTop", "paddingRight", "paddingBottom", "paddingLeft", "borderTopWidth", "borderLeftWidth",
        "borderRightWidth", "borderBottomWidth", "textTransform", "wordSpacing", "tabSize"]) {
        div.style[prop] = style[prop];
    }
    div.style.position = "absolute";
    div.style.visibility = "hidden";
    div.style.whiteSpace = "pre-wrap";
    div.style.wordWrap = "break-word";
    div.style.overflow = "hidden";
    div.textContent = textarea.value.slice(0, pos);
    const span = document.createElement("span");
    span.textContent = "​";
    div.appendChild(span);
    document.body.appendChild(div);
    const rect = textarea.getBoundingClientRect();
    const scale = textarea.offsetWidth ? rect.width / textarea.offsetWidth : 1;
    const lineH = parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.3 || 16;
    const top = rect.top + (span.offsetTop - textarea.scrollTop + lineH) * scale;
    const left = rect.left + (span.offsetLeft - textarea.scrollLeft) * scale;
    document.body.removeChild(div);
    return { top, left };
}

function positionPopup() {
    const { top, left } = caretCoords(state.textarea, state.tokenStart);
    const maxLeft = window.innerWidth - popup.offsetWidth - 8;
    const below = top + 4;
    // 下方放不下时显示在光标上方
    const y = below + popup.offsetHeight > window.innerHeight - 8 ? Math.max(4, top - popup.offsetHeight - 28) : below;
    popup.style.top = `${y}px`;
    popup.style.left = `${Math.max(4, Math.min(left, maxLeft))}px`;
}

// ---------- 插入 ----------

function setValue(textarea, value, caret) {
    suppressInput = true;
    textarea.value = value;
    textarea.selectionStart = textarea.selectionEnd = caret;
    textarea.dispatchEvent(new Event("input", { bubbles: true })); // 通知 ComfyUI 更新部件值
    textarea.dispatchEvent(new Event("change", { bubbles: true }));
    suppressInput = false;
}

function choose(i) {
    const r = state.results[i];
    const ta = state.textarea;
    if (!r || !ta) return;
    const text = ta.value;
    let insert = r.gt ? formatPhrase(r.gt) : formatTag(r.e.tag);
    const token = text.slice(state.tokenStart, state.tokenEnd);
    // 候选替换只作用于中文；连写在后面、已经输完的英文 tag 不属于替换范围。
    const suffix = CJK.test(token) ? (token.match(/[A-Za-z0-9_][A-Za-z0-9_()\\ \-]*$/)?.[0] || "") : "";
    let after = text.slice(state.tokenEnd);
    const englishAfter = !suffix && CJK.test(token) && /^\s*[A-Za-z0-9_]/.test(after);
    // 吃掉光标后同一词的剩余部分，但后面是英文 tag 时必须保留。
    const rest = englishAfter ? "" : after.match(/^[^,，、\n()\[\]{}:<>]*/)[0];
    after = after.slice(rest.length);
    if (suffix) insert += (/[A-Za-z0-9_]$/.test(insert) ? " " : "") + suffix;
    if (englishAfter && /[A-Za-z0-9_]$/.test(insert) && /^[A-Za-z0-9_]/.test(after)) insert += " ";
    if (!suffix && !englishAfter && opt("ZhTag.AppendComma") && !/^\s*[,，)\]}:]/.test(after)) insert += ", ";
    const before = text.slice(0, state.tokenStart);
    setValue(ta, before + insert + after, before.length + insert.length);
    hidePopup();
    ta.focus();
}

// ---------- 一键翻译 ----------

// 混合片段只处理其中的中文部分，英文 tag、数字和其他语法原样保留。
const CJK_PARTS = /([㐀-鿿豈-﫿]+)/;

function joinMixed(parts) {
    let out = "";
    for (const part of parts) {
        if (!part) continue;
        // 中文与英文原本连写时，翻译后的两个英文词之间需要补一个空格。
        if (/[A-Za-z0-9_]$/.test(out) && /^[A-Za-z0-9_]/.test(part)) out += " ";
        out += part;
    }
    return out;
}

function translateMixedTerm(term) {
    const direct = bestTagFor(term);
    if (direct) return formatTag(direct.tag);
    return joinMixed(term.split(CJK_PARTS).map((part) => {
        if (!CJK.test(part)) return part;
        const e = bestTagFor(part);
        if (e) return formatTag(e.tag);
        const en = gtDone.get(part);
        if (!en) return part; // 离线或翻译失败时保留这段中文，不影响其他部分
        const te = tagForEnglish(en);
        return te ? formatTag(te.tag) : formatPhrase(en);
    }));
}

// 字典优先；查不到的中文用机器翻译结果替换，没有译文则原样保留
function translateText(text) {
    return text
        .split("\n")
        .map((line) => {
            if (!CJK.test(line)) return line;
            return line
                .split(/[,，、]/)
                .map((seg) => {
                    if (!CJK.test(seg) || /<[^>]*>/.test(seg)) return seg.trim();
                    const [pre, core, post] = splitWeight(seg);
                    const term = core.trim().replace(PINYIN_RESIDUE, "");
                    return (pre + translateMixedTerm(term) + post).trim();
                })
                .join(", ")
                .trimEnd(); // 行尾的逗号保留为 ","，不留多余空格
        })
        .join("\n");
}

// 只把字典里找不到的中文片段送去机器翻译，绝不发送同段英文 tag。
function untranslatedTerms(text) {
    const out = new Set();
    for (const seg of text.split(/[,，、\n]/)) {
        if (!CJK.test(seg) || /<[^>]*>/.test(seg)) continue;
        const term = splitWeight(seg)[1].trim().replace(PINYIN_RESIDUE, "");
        for (const part of term.split(CJK_PARTS)) {
            if (part && CJK.test(part) && !bestTagFor(part)) out.add(part);
        }
    }
    return [...out];
}

async function translateString(text) {
    await loadData();
    if (!entries || !CJK.test(text)) return text;
    await Promise.all(untranslatedTerms(text).map(machineTranslate));
    return translateText(text);
}

async function translateTextarea(textarea) {
    const v = textarea.value;
    const t = await translateString(v);
    if (textarea.value !== v) return; // 等翻译期间用户又改了内容，放弃本次
    if (t !== v) setValue(textarea, t, t.length);
}

// 节点右键菜单：翻译该节点所有文本部件
async function translateNode(node) {
    for (const w of node.widgets || []) {
        if (typeof w.value !== "string" || !CJK.test(w.value)) continue;
        const v = w.value;
        const t = await translateString(v);
        if (t === v || w.value !== v) continue;
        w.value = t;
        const el = w.inputEl || w.element;
        if (el && "value" in el) el.value = t;
        w.callback?.(t);
    }
    node.setDirtyCanvas?.(true, true);
}

// ---------- 事件 ----------

function isPromptBox(el) {
    return !!el && el.tagName === "TEXTAREA" && !el.closest("#zhtac-popup")
        && (el.classList.contains("comfy-multiline-input") || !!el.closest("[data-node-id]"));
}

function scheduleSearch(textarea) {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(async () => {
        await loadData();
        const tok = currentToken(textarea);
        if (!tok) return hidePopup();
        state.textarea = textarea;
        state.tokenStart = tok.start;
        state.tokenEnd = tok.end;
        const limit = opt("ZhTag.MaxResults");
        state.results = search(tok.text, limit);
        state.index = 0;
        renderPopup();
        if (CJK.test(tok.text)) {
            const source = tok.text.trim();
            addTranslation(textarea, translationQuery(source), limit, source);
        }
    }, 60);
}

// 自动补全的机器翻译候选同样只发送中文，连写的英文 tag 留在编辑器里。
function translationQuery(source) {
    const match = source.match(/^([㐀-鿿豈-﫿]+)\s*[A-Za-z0-9_][A-Za-z0-9_()\\ \-]*$/);
    return match ? match[1] : source;
}

// 译文异步返回后并入候选：译文本身是标签时置顶该标签，另附一条“翻译”候选插入译文原文
function addTranslation(textarea, query, limit, source = query) {
    machineTranslate(query).then((en) => {
        if (!en || state.textarea !== textarea) return;
        const tok = currentToken(textarea);
        if (!tok || tok.text.trim() !== source || document.activeElement !== textarea) return;
        const seg = segmentAt(textarea, textarea.selectionStart);
        if (isDismissed(textarea, seg.start, seg.text)) return; // 已按 Esc 关掉，译文晚到也不再弹出
        const results = state.results.filter((r) => !r.gt);
        const te = tagForEnglish(en);
        if (te && !results.some((r) => r.e === te)) results.unshift({ e: te, score: 0, hit: `译:${en}` });
        const gtItem = { gt: en, src: source };
        if (!te || normalizeTag(en) !== te.tag) {
            const strong = results.some((r) => r.score <= 1);
            if (strong) results.splice(Math.min(results.length, limit - 1), 0, gtItem);
            else results.unshift(gtItem);
        }
        state.results = results.slice(0, limit);
        renderPopup();
    });
}

function hotkeyMatches(ev) {
    const parts = String(opt("ZhTag.Hotkey")).toLowerCase().split("+").map((s) => s.trim());
    const key = parts.pop();
    return !!key && ev.key.toLowerCase() === key
        && ev.altKey === parts.includes("alt") && ev.ctrlKey === parts.includes("ctrl")
        && ev.shiftKey === parts.includes("shift");
}

// 输入法兼容：不同输入法/浏览器触发 input、compositionend 的顺序和次数不一致，
// 因此不维护“正在拼写”的状态，而是在多个时机检查文本是否变化，变了就重新搜索；
// 只在事件本身标明处于拼写中（isComposing / keyCode 229）时跳过。
const lastSeen = new WeakMap();

function isImeEvent(ev) {
    return ev.isComposing || ev.keyCode === 229;
}

function checkChanged(ta) {
    if (suppressInput || !isPromptBox(ta) || !opt("ZhTag.Enabled")) return;
    const sig = ta.value + "|" + ta.selectionStart;
    if (lastSeen.get(ta) === sig) return;
    lastSeen.set(ta, sig);
    scheduleSearch(ta);
    autoConvert(ta);
}

// 实时翻译：刚打下分隔符（逗号/顿号/换行）时，把前一段中文原地换成英文，之后可以随意手改
async function autoConvert(ta) {
    if (!opt("ZhTag.AutoTranslateV2")) return;
    const v = ta.value;
    const pos = ta.selectionStart;
    if (pos < 1 || pos !== ta.selectionEnd || !SEP.test(v[pos - 1])) return;
    let start = pos - 1;
    while (start > 0 && !SEP.test(v[start - 1])) start--;
    const seg = v.slice(start, pos - 1);
    if (!CJK.test(seg) || /<[^>]*>/.test(seg)) return;
    if (isDismissed(ta, start, seg)) return; // 按 Esc 拒绝过候选的这段保留中文
    const lead = seg.match(/^\s*/)[0];
    const out = (await translateString(seg)).trim();
    // 等翻译期间这一段被改过就放弃；之后打的字不影响
    const cur = ta.value;
    if (cur.slice(start, start + seg.length) !== seg || !out || out === seg.trim()) return; // 翻译失败则保留中文
    let tail = start + seg.length;
    let sep = cur[tail];
    // 全角逗号/顿号顺便换成半角 ", "
    if (sep === "，" || sep === "、") {
        sep = cur[tail + 1] === " " ? "," : ", ";
        tail += 1;
    } else sep = "";
    const insert = lead + out + sep;
    const next = cur.slice(0, start) + insert + cur.slice(tail);
    const caret = ta.selectionStart;
    const delta = insert.length - (tail - start);
    setValue(ta, next, caret >= tail ? caret + delta : caret);
    lastSeen.set(ta, ta.value + "|" + ta.selectionStart);
}

function onInput(ev) {
    if (isImeEvent(ev)) return; // 拼写中（文本框里是拼音），等上屏后再搜
    checkChanged(ev.target);
}

// 不改变文本的按键，弹窗打开时由 onKeyDown 处理，keyup 不应重新搜索
const NAV_KEYS = new Set(["ArrowDown", "ArrowUp", "PageDown", "PageUp", "Enter", "Tab", "Escape", "Shift", "Control", "Alt", "Meta"]);

function onKeyUp(ev) {
    if (isImeEvent(ev) || NAV_KEYS.has(ev.key)) return;
    checkChanged(ev.target); // 兜底：部分输入法上屏后不触发 input
}

function popupOpen(ta) {
    return state.results.length && state.textarea === ta && popup && popup.style.display !== "none";
}

function onKeyDown(ev) {
    const ta = ev.target;
    if (!isPromptBox(ta) || !opt("ZhTag.Enabled") || isImeEvent(ev)) return; // 拼写中的按键交给输入法
    if (hotkeyMatches(ev)) {
        ev.preventDefault();
        ev.stopPropagation();
        hidePopup();
        translateTextarea(ta);
        return;
    }
    if (ev.key === "Escape") {
        // 弹窗还没出来（搜索在等延迟）或译文还没回来时按 Esc，也算拒绝了这一段
        clearTimeout(searchTimer);
        const seg = segmentAt(ta, ta.selectionStart);
        state.dismissed = CJK.test(seg.text) ? { ta, ...seg } : null;
    }
    if (!popupOpen(ta)) return;
    const n = state.results.length;
    let handled = true;
    switch (ev.key) {
        case "ArrowDown": state.index = (state.index + 1) % n; renderPopup(); break;
        case "ArrowUp": state.index = (state.index - 1 + n) % n; renderPopup(); break;
        case "PageDown": state.index = Math.min(n - 1, state.index + 5); renderPopup(); break;
        case "PageUp": state.index = Math.max(0, state.index - 5); renderPopup(); break;
        case "Enter":
            if (ev.ctrlKey || ev.metaKey || ev.shiftKey) { handled = false; break; } // Ctrl+Enter 仍为加入队列
            choose(state.index); break;
        case "Tab": choose(state.index); break;
        case "Escape": hidePopup(); break;
        default: handled = false;
    }
    if (handled) {
        ev.preventDefault();
        ev.stopImmediatePropagation(); // 不让 pysssss 补全、ComfyUI 快捷键再处理
    }
}

function install() {
    // 捕获阶段监听，先于文本框自身和其他补全插件的处理
    document.addEventListener("input", onInput, true);
    document.addEventListener("keydown", onKeyDown, true);
    document.addEventListener("keyup", onKeyUp, true);
    document.addEventListener("compositionstart", (ev) => { if (isPromptBox(ev.target)) hidePopup(); }, true);
    document.addEventListener("compositionend", (ev) => {
        const ta = ev.target;
        // Chrome 在 compositionend 时文本已上屏；Firefox 随后还会再发一次 input，checkChanged 会自动去重
        setTimeout(() => checkChanged(ta), 0);
    }, true);
    document.addEventListener("focusout", (ev) => {
        if (isPromptBox(ev.target)) setTimeout(() => { if (document.activeElement !== state.textarea) hidePopup(); }, 150);
    }, true);
    document.addEventListener("focusin", (ev) => {
        if (isPromptBox(ev.target) && opt("ZhTag.Enabled")) loadData();
    }, true);
    // 画布平移/缩放时文本框会移动，直接关闭弹窗
    window.addEventListener("resize", hidePopup);
    document.addEventListener("wheel", (ev) => { if (!ev.target.closest?.("#zhtac-popup")) hidePopup(); }, { capture: true, passive: true });

    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = new URL("./zh_tag_autocomplete.css", import.meta.url).href;
    document.head.appendChild(link);
}

app.registerExtension({
    name: "ZhTag.Autocomplete",
    settings: SETTINGS.map(({ id, name, type, defaultValue, attrs, options, section, backend }) => ({
        id, name, type, defaultValue, attrs, options,
        category: [CATEGORY, section, name],
        onChange: backend ? () => pushConfig() : undefined,
    })),
    setup() {
        install();
        pushConfig();
    },
    // 节点右键菜单
    getNodeMenuItems(node) {
        if (!(node.widgets || []).some((w) => typeof w.value === "string")) return [];
        return [{ content: "中文 → 英文标签", callback: () => translateNode(node) }];
    },
});

// 供调试/其他脚本使用
window.zhTagAutocomplete = { search, translateText, translateString, loadData, machineTranslate };
