const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");
let extension;
const requests = [];
let onlineAvailable = true;
const rows = JSON.parse(fs.readFileSync(path.join(root, "data", "tags.json"), "utf8"));

const context = vm.createContext({
    console,
    setTimeout,
    clearTimeout,
    Event: class Event {
        constructor(type) { this.type = type; }
    },
    window: {},
    app: {
        extensions: [],
        extensionManager: { setting: { get: () => undefined } },
        ui: { settings: { getSettingValue: () => undefined } },
        registerExtension: (value) => { extension = value; },
    },
    fetch: async (url) => {
        if (url === "/zh_tag_autocomplete/tags.json") return { json: async () => rows };
        if (url.startsWith("/zh_tag_autocomplete/translate?q=")) {
            const query = decodeURIComponent(url.split("?q=")[1]);
            requests.push(query);
            if (!onlineAvailable) return { ok: false };
            const text = query === "一个词典里没有的描述" ? "a translated phrase" : "";
            return { ok: true, json: async () => ({ text }) };
        }
        throw new Error(`Unexpected fetch: ${url}`);
    },
});

const source = fs.readFileSync(path.join(root, "web", "zh_tag_autocomplete.js"), "utf8")
    .replace('import { app } from "../../scripts/app.js";', "")
    .replaceAll("import.meta.url", '"http://localhost/"')
    .replace("window.zhTagAutocomplete = {", "window.zhTagAutocomplete = { choose, state, translationQuery,");
vm.runInContext(source, context, { filename: "zh_tag_autocomplete.js" });

async function run() {
    const api = context.window.zhTagAutocomplete;
    await api.loadData();

    const autoTranslate = extension.settings.find((setting) => setting.id === "ZhTag.AutoTranslateV2");
    assert.equal(autoTranslate.defaultValue, true, "实时翻译应默认开启");
    assert.equal(api.translationQuery("一个词典里没有的描述1girl"), "一个词典里没有的描述", "补全翻译不能发送尾部英文");

    let out = await api.translateString("一个词典里没有的描述1girl");
    assert.equal(out, "a translated phrase 1girl", "翻译中文时不能吞掉连写的英文 tag");
    assert.deepEqual(requests, ["一个词典里没有的描述"], "只能把中文部分发送给翻译接口");

    out = await api.translateString("(黑丝1girl:1.2)");
    assert.equal(out, "(black thighhighs 1girl:1.2)", "本地词典翻译也必须保留英文和权重");

    onlineAvailable = false;
    out = await api.translateString("1girl另一个词典里没有的描述");
    assert.equal(out, "1girl另一个词典里没有的描述", "离线时混合原文应保持不变");
    assert.equal(requests.at(-1), "另一个词典里没有的描述", "离线请求同样不能包含英文 tag");

    function chooseAt(value, tokenEnd) {
        const textarea = {
            value,
            selectionStart: tokenEnd,
            selectionEnd: tokenEnd,
            dispatchEvent: () => {},
            focus: () => {},
        };
        Object.assign(api.state, {
            textarea,
            results: [{ e: { tag: "black_thighhighs" } }],
            tokenStart: 0,
            tokenEnd,
        });
        api.choose(0);
        return textarea.value;
    }

    assert.equal(chooseAt("黑丝1girl", 7), "black thighhighs 1girl", "候选插入不能吞掉尾部英文");
    assert.equal(chooseAt("黑丝1girl", 2), "black thighhighs 1girl", "光标在英文前时也不能吞掉英文");

    console.log("Frontend tests: 7 passed");
}

run().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
