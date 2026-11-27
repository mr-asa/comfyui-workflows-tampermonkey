// ==UserScript==
// @name         ComfyUI Workflows
// @namespace    https://github.com/mr-asa
// @homepageURL  https://github.com/mr-asa/comfyui-workflows-tampermonkey
// @supportURL   https://github.com/mr-asa/comfyui-workflows-tampermonkey/issues
// @updateURL    https://raw.githubusercontent.com/mr-asa/comfyui-workflows-tampermonkey/main/ComfyUIWorkflows.user.js
// @downloadURL  https://raw.githubusercontent.com/mr-asa/comfyui-workflows-tampermonkey/main/ComfyUIWorkflows.user.js
// @version      0.2.0
// @icon         https://raw.githubusercontent.com/Comfy-Org/ComfyUI_frontend/main/public/assets/favicon.ico
// @description  Find embedded ComfyUI workflows and prompts in web media, attachments, and code blocks.
// @match        http://*/*
// @match        https://*/*
// @exclude      *://youtube.com/*
// @exclude      *://*.youtube.com/*
// @exclude      *://youtu.be/*
// @exclude      *://*.youtube-nocookie.com/*
// @exclude      *://netflix.com/*
// @exclude      *://*.netflix.com/*
// @exclude      *://twitch.tv/*
// @exclude      *://*.twitch.tv/*
// @exclude      *://disneyplus.com/*
// @exclude      *://*.disneyplus.com/*
// @exclude      *://primevideo.com/*
// @exclude      *://*.primevideo.com/*
// @exclude      *://hulu.com/*
// @exclude      *://*.hulu.com/*
// @exclude      *://max.com/*
// @exclude      *://*.max.com/*
// @exclude      *://spotify.com/*
// @exclude      *://*.spotify.com/*
// @noframes
// @grant        GM_addStyle
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_setClipboard
// @grant        GM_registerMenuCommand
// @grant        GM_xmlhttpRequest
// @connect      discordapp.com
// @connect      discordapp.net
// @connect      discord.com
// @connect      localhost
// @connect      127.0.0.1
// @connect      civitai.com
// @connect      huggingface.co
// @connect      google.com
// @connect      *
// @license      MIT
// ==/UserScript==

(() => {
"use strict";


const DEFAULT_SERVER = "http://127.0.0.1:8188";
const BADGE_CLASS = "cuw-badge";
const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const KEYS = ["workflow", "prompt"];
const IMAGE_EXT = /\.(png|webp|jpe?g)$/i;
const BOX_EXT = /\.(mp4|mov|m4v|m4a)$/i; // ISO base media: walk the boxes to find moov
const RANGE_EXT = /\.(mp4|webm|mov|mkv|m4v|flac|mp3|ogg|opus|m4a|wav)$/i; // large: never download whole
const JSON_EXT = /\.json$/i;
const RANGE_CHUNK = 4 * 1024 * 1024; // bytes read from the head and tail of large files
const MAX_MOOV = 64 * 1024 * 1024;
const MAX_JSON = 32 * 1024 * 1024;
const MAX_JSON_FILE = 16 * 1024 * 1024;
const MODEL_EXT = /\.(safetensors|ckpt|pt|pth|bin|gguf|sft|onnx)$/i;

/* ------------------------------- graph helpers ------------------------------- */

/** JSON.parse that also accepts the NaN/Infinity values Python-written ComfyUI JSON can contain (read as null). */
function parseJson(text) {
    try {
        return JSON.parse(text);
    } catch (err) {
        const fixed = text.replace(/"(?:[^"\\]|\\.)*"|-?Infinity|NaN/g, m => (m[0] === '"' ? m : "null"));
        if (fixed === text) throw err;
        return JSON.parse(fixed);
    }
}

const isLink = v => Array.isArray(v) && v.length === 2 && (typeof v[0] === "string" || typeof v[0] === "number") && typeof v[1] === "number";

/** API prompt graph ({id: {class_type, inputs}}) built from an editor workflow, links resolved. */
function graphFromWorkflow(wf) {
    const links = new Map();
    for (const l of wf.links || []) {
        if (Array.isArray(l)) links.set(l[0], [l[1], l[2]]);
        else if (l && l.id != null) links.set(l.id, [l.origin_id, l.origin_slot]);
    }
    const g = {};
    for (const n of wf.nodes || []) {
        const inputs = {};
        for (const i of n.inputs || []) {
            if (i.link == null) continue;
            const l = links.get(i.link);
            if (l) inputs[i.name] = [String(l[0]), l[1]];
        }
        if (/TextEncode|String|Text|Prompt/i.test(n.type) && inputs.text === undefined) {
            const w = (n.widgets_values || []).find(x => typeof x === "string");
            if (w !== undefined) inputs.text = w;
        }
        g[String(n.id)] = { class_type: n.type, inputs, widgets: n.widgets_values };
    }
    return g;
}

function variantGraph(variant) {
    try {
        if (variant.prompt) return parseJson(variant.prompt);
        if (variant.workflow) return graphFromWorkflow(parseJson(variant.workflow));
    } catch { /* fall through */ }
    return null;
}

/** Follow a conditioning/text link back to the text it ultimately carries. */
function traceText(g, ref, seen = new Set()) {
    const id = String(ref[0]);
    const node = g[id];
    if (!node || seen.has(id)) return "";
    seen.add(id);
    const inp = node.inputs || {};
    const texts = [];
    for (const k of ["text", "text_g", "text_l", "prompt", "string", "value", "positive_prompt"]) {
        if (typeof inp[k] === "string" && inp[k].trim() && !texts.includes(inp[k])) texts.push(inp[k]);
    }
    if (texts.length) return texts.join("\n");
    const preferred = ["text", "string", "value", "conditioning", "conditioning_1", "conditioning_to", "positive", "prompt"];
    const keys = [...preferred.filter(k => k in inp), ...Object.keys(inp).filter(k => !preferred.includes(k))];
    for (const k of keys) {
        if (!isLink(inp[k])) continue;
        const r = traceText(g, inp[k], seen);
        if (r) return r;
    }
    return "";
}

/** {positive, negative} prompt texts, traced from the sampler; falls back to the first two text encoders. */
function extractPrompts(variant) {
    const g = variantGraph(variant);
    if (!g) return {};
    const entries = Object.entries(g).sort((a, b) => Number(a[0]) - Number(b[0]));
    const sampler = entries.find(([, n]) => /sampler|guider/i.test(n.class_type) && isLink(n.inputs?.positive))
        ?? entries.find(([, n]) => /guider/i.test(n.class_type) && isLink(n.inputs?.conditioning)); // BasicGuider: positive only
    if (sampler) {
        const inp = sampler[1].inputs;
        return {
            positive: traceText(g, inp.positive ?? inp.conditioning) || undefined,
            negative: isLink(inp.negative) ? traceText(g, inp.negative) || undefined : undefined
        };
    }
    const enc = entries.filter(([, n]) => /CLIPTextEncode/i.test(n.class_type) && typeof n.inputs?.text === "string");
    return { positive: enc[0]?.[1].inputs.text, negative: enc[1]?.[1].inputs.text };
}

function modelKind(key, cls) {
    const s = `${key ?? ""} ${cls ?? ""}`.toLowerCase();
    if (/lora/.test(s)) return "LoRA";
    if (/ckpt|checkpoint/.test(s)) return "Checkpoint";
    if (/vae/.test(s)) return "VAE";
    if (/controlnet|control_net/.test(s)) return "ControlNet";
    if (/unet|diffusion|gguf/.test(s)) return "Diffusion model";
    if (/clip|t5|text_encoder|llm/.test(s)) return "Text encoder";
    if (/upscale/.test(s)) return "Upscaler";
    if (/ipadapter|ip_adapter/.test(s)) return "IP-Adapter";
    if (/embedding|textual/.test(s)) return "Embedding";
    return "Model";
}

/** Model files (checkpoints, LoRAs, VAEs, ...) used by a variant. */
function extractModels(variant) {
    const out = [];
    const seen = new Set();
    const add = (name, key, cls, strength) => {
        const k = `${name}|${cls}`;
        if (seen.has(k)) return;
        seen.add(k);
        out.push({ name, kind: modelKind(key, cls), cls, key, strength });
    };
    try {
        if (variant.prompt) {
            for (const node of Object.values(parseJson(variant.prompt))) {
                const inp = node?.inputs;
                if (!inp) continue;
                const strength = inp.strength_model ?? inp.strength;
                for (const [key, v] of Object.entries(inp)) {
                    if (typeof v === "string" && MODEL_EXT.test(v)) add(v, key, node.class_type, typeof strength === "number" ? strength : undefined);
                    else if (v && typeof v === "object" && !Array.isArray(v)) {
                        // e.g. rgthree Power Lora Loader: {on, lora, strength}
                        const s = Object.values(v).find(x => typeof x === "string" && MODEL_EXT.test(x));
                        if (s) add(s, key, node.class_type, typeof v.strength === "number" ? v.strength : undefined);
                    }
                }
            }
        } else if (variant.workflow) {
            for (const node of parseJson(variant.workflow).nodes || []) {
                for (const w of node.widgets_values || []) {
                    if (typeof w === "string" && MODEL_EXT.test(w)) add(w, undefined, node.type);
                    else if (w && typeof w === "object" && !Array.isArray(w)) {
                        const s = Object.values(w).find(x => typeof x === "string" && MODEL_EXT.test(x));
                        if (s) add(s, undefined, node.type, typeof w.strength === "number" ? w.strength : undefined);
                    }
                }
            }
        }
    } catch { /* ignore malformed graphs */ }
    return out;
}

const normName = s => String(s).trim().replace(/\\/g, "/").toLowerCase();
const noExt = s => normName(s).split("/").pop().replace(MODEL_EXT, "");
const QUANT_TOKENS = new Set([
    "fp4", "fp8", "fp16", "fp32", "bf16", "f16", "f32", "nf4", "nvfp4", "mxfp4", "int4", "int8", "fn", "fnuz",
    "scaled", "convrot", "gptq", "awq", "svdq", "svdquant", "nunchaku", "gguf"
]);

/**
 * File name reduced to its identity: no folder, extension, or quantization/precision tokens
 * (Q4_K_M, IQ4_XS, fp8_e4m3fn, bf16, int8, convrot, ...). Variants like "turbo" are kept.
 */
function quantKey(name) {
    const tokens = normName(name).split("/").pop().replace(MODEL_EXT, "").split(/[-_. ]+/).filter(Boolean);
    const kept = [];
    let afterQ = false;
    for (const t of tokens) {
        if (/^i?q\d+$/.test(t)) { afterQ = true; continue; }
        if (afterQ && /^(?:k|m|s|l|xs|xxs|\d)$/.test(t)) continue; // the K_M / _0 part of Q4_K_M, Q8_0
        afterQ = false;
        if (QUANT_TOKENS.has(t) || /^e\dm\d(?:fnuz|fn)?$/.test(t) || /^w\d+a\d+$/.test(t)) continue;
        kept.push(t);
    }
    return kept.join("_");
}

/** Files sharing most name tokens with `name` (extra or missing words like "attn", "KJ", "turbo"); suggestions only. */
function relatedModels(name, available) {
    const tokens = n => new Set(quantKey(n).split("_").filter(Boolean));
    const want = tokens(name);
    return available.map(o => {
        const have = tokens(o);
        const shared = [...want].filter(t => have.has(t));
        return { o, words: shared.filter(t => !/^\d+$/.test(t)).length, score: shared.length / Math.max(want.size, have.size, 1) };
    })
        .filter(x => x.words >= 2 && x.score >= 0.7)
        .sort((a, b) => b.score - a.score)
        .slice(0, 3)
        .map(x => x.o);
}

/**
 * How a wanted model file relates to the files a server offers: ok (exact, or same file name in
 * another folder, with `matches` set), similar (other quantization), or missing.
 */
function matchModel(name, available) {
    const want = normName(name);
    if (available.some(o => normName(o) === want)) return { st: "ok" };
    const folder = want.split("/").slice(0, -1).join("/");
    const closest = list => list.sort((x, y) =>
        (normName(y).startsWith(folder + "/") ? 1 : 0) - (normName(x).startsWith(folder + "/") ? 1 : 0));
    // .sft is the short extension for the same safetensors format
    const canon = o => normName(o).replace(/\.sft$/, ".safetensors");
    const wantCanon = canon(name);
    const base = wantCanon.split("/").pop();
    const moved = available.filter(o => canon(o).split("/").pop() === base);
    if (moved.length) {
        const sameFolder = moved.some(o => canon(o) === wantCanon);
        return { st: "ok", matches: closest(moved), hint: sameFolder ? "found with another extension: " : "found in another folder: " };
    }
    const key = quantKey(name);
    const similar = key.length >= 3 ? available.filter(o => quantKey(o) === key) : [];
    if (similar.length) return { st: "similar", matches: closest(similar), hint: "similar (other quantization): " };
    const related = relatedModels(name, available);
    return related.length ? { st: "related", matches: related, hint: "possibly related: " } : { st: "missing" };
}

const searchLinks = name => [
    ["Civitai", `https://civitai.com/search/models?query=${encodeURIComponent(noExt(name))}`, "civitai.com"],
    ["Hugging Face", `https://huggingface.co/models?search=${encodeURIComponent(noExt(name))}`, "huggingface.co"],
    ["Web", `https://www.google.com/search?q=${encodeURIComponent(noExt(name))}`, "www.google.com"]
];

/* ------------------------------- byte helpers ------------------------------- */

async function inflate(bytes) {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate"));
    return new Uint8Array(await new Response(stream).arrayBuffer());
}

const utf8 = new TextDecoder("utf-8");
const latin = new TextDecoder("latin1");

/**
 * Find workflow/prompt JSON objects inside arbitrary text. Workflow JSON has "nodes";
 * API prompt JSON has "class_type". Returns variants paired by order of appearance.
 */
function scanText(text) {
    const starts = /\{\s*"(?:last_node_id|id|revision|version|nodes|\d+)"\s*:/g;
    const workflows = [];
    const prompts = [];
    let m;
    while ((m = starts.exec(text))) {
        const end = matchBrace(text, m.index);
        if (end < 0) continue;
        starts.lastIndex = end + 1;
        const chunk = text.slice(m.index, end + 1);
        let obj;
        try { obj = parseJson(chunk); } catch { continue; }
        if (Array.isArray(obj.nodes)) { if (!workflows.includes(chunk)) workflows.push(chunk); }
        else if (Object.values(obj).some(v => v && typeof v === "object" && "class_type" in v)) { if (!prompts.includes(chunk)) prompts.push(chunk); }
    }
    return pairVariants(workflows, prompts);
}

function pairVariants(workflows, prompts) {
    const variants = [];
    for (let i = 0; i < Math.max(workflows.length, prompts.length); i++) {
        variants.push({ workflow: workflows[i], prompt: prompts[i] });
    }
    return variants.length ? { variants } : null;
}

/** Index of the brace closing the object that opens at `start`, string-aware; -1 if none. */
function matchBrace(text, start) {
    let depth = 0, inStr = false;
    const limit = Math.min(text.length, start + MAX_JSON);
    for (let i = start; i < limit; i++) {
        const c = text.charCodeAt(i);
        if (inStr) {
            if (c === 92) i++;
            else if (c === 34) inStr = false;
        } else if (c === 34) inStr = true;
        else if (c === 123) depth++;
        else if (c === 125 && --depth === 0) return i;
    }
    return -1;
}

const scanBytes = buf => scanText(utf8.decode(buf));

async function parsePng(buf) {
    if (!PNG_SIG.every((b, i) => buf[i] === b)) return null;
    const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    const found = {};
    let pos = 8;

    while (pos + 8 <= buf.length) {
        const len = view.getUint32(pos);
        const type = latin.decode(buf.subarray(pos + 4, pos + 8));
        const start = pos + 8;
        const end = start + len;
        if (type === "IEND") break;
        if (type === "tEXt" || type === "zTXt" || type === "iTXt") {
            const chunk = buf.subarray(start, end);
            const nul = chunk.indexOf(0);
            const key = latin.decode(chunk.subarray(0, nul)).toLowerCase();
            if (KEYS.includes(key)) {
                try {
                    if (type === "tEXt") {
                        found[key] = utf8.decode(chunk.subarray(nul + 1));
                    } else if (type === "zTXt") {
                        found[key] = utf8.decode(await inflate(chunk.subarray(nul + 2)));
                    } else {
                        // iTXt: key\0 compFlag compMethod lang\0 translated\0 text
                        let p = chunk.indexOf(0, nul + 3) + 1;
                        p = chunk.indexOf(0, p) + 1;
                        const body = chunk.subarray(p);
                        found[key] = utf8.decode(chunk[nul + 1] === 1 ? await inflate(body) : body);
                    }
                } catch { /* unreadable chunk: skip */ }
            }
        }
        pos = end + 4; // skip CRC
    }
    return found.workflow || found.prompt ? { variants: [{ workflow: found.workflow, prompt: found.prompt }] } : null;
}



GM_addStyle(`
.cuw-badge {
    position: absolute;
    left: clamp(0px, calc(var(--cuw-x) - 12px), calc(100% - 24px));
    top: clamp(0px, calc(var(--cuw-y) - 12px), calc(100% - 24px));
    z-index: 10; width: 24px; height: 24px; padding: 0; border: 0; border-radius: 6px;
    background: #141414e6; color: #6ee79b; font: 700 11px/24px system-ui; cursor: pointer;
}
.cuw-badge:hover { background: #303030; }
.cuw-dialog, .cuw-toast {
    color: #f2f3f5; background: #25262b; border: 1px solid #52545b; border-radius: 10px;
    font: 14px/1.5 system-ui;
}
.cuw-dialog { position: fixed; inset: 0; margin: auto; width: min(560px, 88vw); max-height: 85vh; padding: 18px; overflow: auto; }
.cuw-dialog::backdrop { background: #0008; }
.cuw-dialog h2, .cuw-dialog h4 { margin: 0 0 8px; color: inherit; }
.cuw-dialog h2, .cuw-name { overflow-wrap: anywhere; }
.cuw-card, .cuw-settings { display: grid; gap: 10px; }
.cuw-row, .cuw-actions { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; }
.cuw-actions { justify-content: flex-end; margin-top: 12px; }
.cuw-menu { display: grid; gap: 6px; }
.cuw-dialog button { background: #454854; color: inherit; border: 0; border-radius: 5px; padding: 6px 10px; cursor: pointer; }
.cuw-dialog button:hover { background: #575b6c; }
.cuw-dialog input:not([type="checkbox"]), .cuw-dialog textarea {
    box-sizing: border-box; width: 100%; padding: 6px; color: inherit; background: #191a1e; border: 1px solid #52545b; border-radius: 5px;
}
.cuw-dialog textarea { resize: vertical; }
.cuw-coordinates { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
.cuw-note, .cuw-extra { color: #c6c8d0; font-size: 12px; }
.cuw-name { flex: 1; }
.cuw-ok { color: #6ee79b; } .cuw-similar { color: #fbbf24; } .cuw-missing { color: #fda4af; }
.cuw-links a { margin-left: 6px; color: #b8c9ff; }
.cuw-links img { width: 16px; height: 16px; vertical-align: middle; }
.cuw-toast { position: fixed; z-index: 2147483647; bottom: 16px; right: 16px; padding: 10px 14px; }
`);

function element(tag, props, ...children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(props || {})) {
        if (key === "key") continue;
        if (key === "onClick") node.addEventListener("click", value);
        else if (key in node) node[key] = value;
        else node.setAttribute(key, value);
    }
    for (const child of children.flat(Infinity)) {
        if (child != null && child !== false) node.append(child);
    }
    return node;
}

function button(label, action) {
    return element("button", { type: "button", onClick: action }, label);
}

function notify(message, { type, timeout = 3500 } = {}) {
    const toast = element("div", { className: "cuw-toast", role: type === "error" ? "alert" : "status" }, message);
    (document.querySelector(".cuw-dialog[open]") || document.body).append(toast);
    setTimeout(() => toast.remove(), timeout);
}

function showDialog(title, content, { confirmText = "Close", cancelText, onConfirm } = {}) {
    const previous = document.querySelector(".cuw-dialog[open]");
    if (previous) previous.close();

    const dialog = element("dialog", { className: "cuw-dialog", "aria-label": title });
    const actions = element("div", { className: "cuw-actions" });
    if (cancelText) actions.append(button(cancelText, () => dialog.close()));
    actions.append(button(confirmText, () => {
        if (onConfirm?.() !== false) dialog.close();
    }));
    dialog.append(element("h2", null, title), content, actions);
    dialog.addEventListener("close", () => dialog.remove(), { once: true });
    dialog.addEventListener("keydown", event => event.stopPropagation());
    document.body.append(dialog);
    dialog.showModal();
    return dialog;
}

function request(url, { method = "GET", headers, body, maxBytes, partial = false } = {}) {
    return new Promise((resolve, reject) => {
        const fail = () => reject(new Error("Request failed"));
        const check = response => {
            if ((partial && response.status && response.status !== 206) || (maxBytes && response.loaded > maxBytes)) {
                reject(new Error("Response did not match the requested byte range or size"));
                handle.abort();
            }
        };
        const handle = GM_xmlhttpRequest({
            method, url, headers, data: body, timeout: 15000, anonymous: true, responseType: "arraybuffer",
            onreadystatechange: response => {
                if (response.readyState === 2) check(response);
            },
            onprogress: check,
            onerror: fail, ontimeout: fail, onabort: fail,
            onload: response => {
                const bytes = response.response;
                if ((partial && response.status !== 206) || (maxBytes && bytes?.byteLength > maxBytes)) {
                    fail();
                    return;
                }
                const text = async () => utf8.decode(bytes);
                resolve({
                    ok: response.status >= 200 && response.status < 300,
                    status: response.status,
                    headers: new Headers((response.responseHeaders || "").split(/\r?\n/).flatMap(line => {
                        const i = line.indexOf(":");
                        return i > 0 ? [[line.slice(0, i), line.slice(i + 1).trim()]] : [];
                    })),
                    arrayBuffer: async () => bytes,
                    text,
                    json: async () => JSON.parse(await text())
                });
            }
        });
    });
}

const DEFAULT_SETTINGS = { x: 0, y: 0, server: DEFAULT_SERVER, copyFilename: false };
const coordinate = (value, fallback) =>
    typeof value === "number" && Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : fallback;

class ComfyUIWorkflow {
    settings = { ...DEFAULT_SETTINGS, ...GM_getValue("settings", {}) };
    cache = new Map();
    checked = new WeakMap();
    scanTimer = null;

    get server() {
        return this.settings.server;
    }

    start() {
        this.settings.x = coordinate(this.settings.x, 0);
        this.settings.y = coordinate(this.settings.y, 0);
        this.applyPosition();
        GM_registerMenuCommand("ComfyUI Workflow settings", () => this.showSettings());
        const schedule = () => {
            if (this.scanTimer) return;
            this.scanTimer = setTimeout(() => {
                this.scanTimer = null;
                this.scan();
            }, 150);
        };
        new MutationObserver(schedule).observe(document.body, {
            subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ["src", "srcset", "href"]
        });
        document.addEventListener("loadedmetadata", schedule, true);
        document.addEventListener("load", schedule, true);
        this.scan();
    }

    applyPosition() {
        document.documentElement.style.setProperty("--cuw-x", `${this.settings.x * 100}%`);
        document.documentElement.style.setProperty("--cuw-y", `${this.settings.y * 100}%`);
    }

    scan() {
        const root = /^(?:(?:ptb|canary)\.)?discord\.com$/.test(location.hostname)
            ? document.querySelector('[class*="messagesWrapper"]')
            : document;
        if (!root) return;
        root.querySelectorAll("img, video, audio, a[href]").forEach(el => {
            const kind = el.localName;
            if (kind === "img" && el.naturalWidth && el.naturalWidth < 128) return;
            const source = el.currentSrc || (kind === "a" ? el.href : el.getAttribute("src"));
            this.process(el, this.originalUrl(source, kind));
        });
        root.querySelectorAll("code").forEach(code => this.process(code, code.textContent, true));
    }


    async process(el, source, isCode = false) {
        const previous = this.checked.get(el);
        if (previous?.source === source) return;
        const state = { source, badge: null };
        previous?.badge?.remove();
        this.checked.set(el, state);
        if (!source) return;

        const data = isCode ? (/"nodes"|"class_type"/.test(source) && scanText(source)) : await this.getMeta(source, el.localName);
        if (!data || !el.isConnected || this.checked.get(el) !== state) return;

        const host = isCode ? el.closest("pre") ?? el
            : el.matches("a") ? el.parentElement : el.closest("a, picture")?.parentElement ?? el.parentElement;
        if (!host || [...host.children].some(child => child.classList.contains(BADGE_CLASS) && child.dataset.source === source)) return;
        if (getComputedStyle(host).position === "static") host.style.position = "relative";
        const label = data.variants.some(v => v.workflow) ? "WF" : "P";
        const title = label === "WF" ? "ComfyUI workflow actions" : "ComfyUI prompt actions";
        const open = event => {
            event.preventDefault();
            event.stopPropagation();
            this.showMenu(isCode ? `pasted-${Date.now()}.json` : source, data);
        };
        const badge = element("button", { className: BADGE_CLASS, type: "button", title, "aria-label": title, onClick: open }, label);
        badge.dataset.source = isCode ? "" : source;
        badge.addEventListener("contextmenu", open);
        state.badge = badge;
        host.append(badge);
    }

    showSettings() {
        const axis = (name, value) => element("input", { type: "number", min: 0, max: 1, step: "any", value, "aria-label": name });
        const x = axis("X (horizontal)", this.settings.x);
        const y = axis("Y (vertical)", this.settings.y);
        const server = element("input", { type: "url", value: this.server, required: true, spellcheck: false });
        const copy = element("input", { type: "checkbox", checked: this.settings.copyFilename });
        const readServer = () => {
            server.setCustomValidity("");
            const value = server.value.trim().replace(/\/+$/, "");
            if (!/^https?:\/\//i.test(value)) server.setCustomValidity("Enter an HTTP or HTTPS ComfyUI URL.");
            return server.reportValidity() ? value : null;
        };
        const test = async () => {
            const url = readServer();
            if (!url) return;
            try {
                const result = await request(`${url}/system_stats`);
                if (!result.ok) throw new Error(`HTTP ${result.status}`);
                notify("ComfyUI is reachable");
            } catch (error) {
                notify(`Cannot reach ${url} (${error.message})`, { type: "error" });
            }
        };
        const content = element("div", { className: "cuw-settings" },
            element("div", { className: "cuw-coordinates" },
                element("label", null, "X (horizontal)", x), element("label", null, "Y (vertical)", y)),
            element("div", { className: "cuw-note" },
                "Badge position relative to the attachment or code block. (0, 0) top left · (1, 0) top right · (0, 1) bottom left · (1, 1) bottom right · (0.5, 0.5) center."),
            element("label", null, "ComfyUI server URL", server),
            element("div", null, button("Test connection", test)),
            element("label", null, copy, " Copy JSON filename after download"));
        x.required = y.required = true;
        showDialog("ComfyUI Workflow settings", content, {
            confirmText: "Save", cancelText: "Cancel",
            onConfirm: () => {
                if (!x.reportValidity() || !y.reportValidity()) return false;
                const url = readServer();
                if (!url) return false;
                this.settings = { x: x.valueAsNumber, y: y.valueAsNumber, server: url, copyFilename: copy.checked };
                GM_setValue("settings", this.settings);
                this.applyPosition();
            }
        });
    }

    showMenu(url, { variants }) {
        const filename = new URL(url, location.href).pathname.split("/").pop();
        let base = filename.replace(/\.[a-z0-9]+$/i, "");
        try { base = decodeURIComponent(base); } catch { /* keep the encoded name */ }
        const menu = element("div", { className: "cuw-menu" });
        const add = (label, action) => menu.append(button(label, () => {
            dialog.close();
            Promise.resolve().then(action).catch(error => notify(error.message, { type: "error" }));
        }));
        variants.forEach((variant, i) => {
            const suffix = variants.length > 1 ? ` #${i + 1}` : "";
            const file = variants.length > 1 ? `${base}_${i + 1}` : base;
            const { positive, negative } = extractPrompts(variant);
            if (positive || negative) add("Prompts" + suffix, () => this.showPrompts({ positive, negative }, file));
            if (variant.prompt) add("Queue in ComfyUI" + suffix, () => this.sendToComfy(variant.prompt));
            if (extractModels(variant).length) add("Models and LoRAs" + suffix, () => this.showModels(variant, file));
            if (variant.workflow) add("Save workflow as JSON" + suffix, () => this.save(file, variant.workflow));
            if (variant.prompt) add("Save prompt as JSON" + suffix, () => this.save(file + ".prompt", variant.prompt));
        });
        add("Settings", () => this.showSettings());
        const dialog = showDialog(base, menu);
    }

    showPrompts(prompts, title) {
        const content = element("div", { className: "cuw-card" });
        for (const [label, text] of Object.entries({ Positive: prompts.positive, Negative: prompts.negative })) {
            if (!text) continue;
            content.append(element("section", null,
                element("div", { className: "cuw-row" }, element("h4", null, label),
                    button("Copy", () => { GM_setClipboard(text, "text"); notify(`${label} prompt copied`); })),
                element("textarea", { readOnly: true, value: text, rows: Math.min(10, Math.max(3, Math.ceil(text.length / 70))), "aria-label": label })));
        }
        showDialog(`Prompts: ${title}`, content);
    }

    save(base, json) {
        const filename = base.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_") + ".json";
        const url = URL.createObjectURL(new Blob([json], { type: "application/json" }));
        const link = element("a", { href: url, download: filename });
        document.body.append(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 30000);
        if (this.settings.copyFilename) GM_setClipboard(filename, "text");
        notify(`Download started: ${filename}`);
    }


    /**
     * Compare every model file in the prompt with what the server offers. Same file in another
     * folder or another quantization is rewritten to the server's name; the rest is reported missing.
     */
    async planModels(graph) {
        const changes = [];
        const missing = [];
        const classes = [...new Set(Object.values(graph).map(n => n?.class_type).filter(Boolean))];
        const options = new Map();
        await Promise.all(classes.map(async c => options.set(c, await this.comboOptions(c))));
        for (const [id, node] of Object.entries(graph)) {
            const combos = options.get(node?.class_type);
            if (!combos) continue;
            for (const [key, val] of Object.entries(node.inputs || {})) {
                if (typeof val !== "string" || !MODEL_EXT.test(val) || !combos[key]) continue;
                const r = matchModel(val, combos[key]);
                if (r.st === "ok" && !r.matches) continue;
                if (r.st === "missing" || r.st === "related") missing.push({ cls: node.class_type, key, name: val });
                else changes.push({ id, cls: node.class_type, key, from: val, to: r.matches[0], st: r.st });
            }
        }
        return { changes, missing };
    }

    async sendToComfy(promptJson) {
        let graph;
        try { graph = parseJson(promptJson); } catch {
            notify("The prompt JSON is not valid", { type: "error" });
            return;
        }
        const { changes, missing } = await this.planModels(graph);
        if (missing.length) {
            this.showLines("Not sent: models missing on the ComfyUI server",
                missing.map(m => `${m.cls} (${m.key}): ${m.name}`));
            return;
        }
        for (const c of changes) graph[c.id].inputs[c.key] = c.to;
        const similar = changes.filter(c => c.st === "similar");
        if (!similar.length) return this.postPrompt(graph, changes.length);

        const h = element;
        showDialog("Use similar models?", h("div", { className: "cuw-card" },
            h("div", { className: "cuw-note" }, "These files are not on the server. Send with the similar ones instead?"),
            similar.map(c => h("div", { key: c.id + c.key, className: "cuw-row" },
                h("span", { className: "cuw-name" }, c.from, h("div", { className: "cuw-extra" }, "→ " + c.to))))
        ), { confirmText: "Send", cancelText: "Cancel", onConfirm: () => this.postPrompt(graph, changes.length) });
    }

    async postPrompt(graph, adjusted) {
        const server = this.server;
        try {
            const res = await request(`${server}/prompt`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ prompt: graph, client_id: "discord-comfyui-userscript" })
            });
            const text = await res.text();
            if (res.ok) {
                let n = "";
                try { n = ` (queue #${JSON.parse(text).number})`; } catch { /* no number */ }
                notify("Queued in ComfyUI" + n + (adjusted ? `, ${adjusted} model name(s) adjusted` : ""), { type: "success" });
                return;
            }
            let title = `ComfyUI rejected the prompt (HTTP ${res.status})`;
            const lines = [];
            try {
                const err = JSON.parse(text);
                if (err.error?.message) lines.push(err.error.message + (err.error.details ? `: ${err.error.details}` : ""));
                for (const [id, ne] of Object.entries(err.node_errors || {})) {
                    const detail = (ne.errors || []).map(e => [e.message, e.details].filter(Boolean).join(" ")).join("; ");
                    lines.push(`${ne.class_type} (#${id}): ${detail}`);
                }
            } catch { lines.push(text.slice(0, 500)); }
            this.showLines(title, lines);
        } catch (err) {
            notify(`Cannot reach ComfyUI at ${server} (${err.message}). Set the URL in plugin settings.`, { type: "error", timeout: 8000 });
        }
    }

    showLines(title, lines) {
        const h = element;
        showDialog(title, h("div", { className: "cuw-card" },
            lines.map((l, i) => h("div", { key: i, className: "cuw-row" }, h("span", { className: "cuw-name" }, l)))
        ), { confirmText: "Close", cancelText: null });
    }

    /** Option lists of every combo input of a node class on the server, or null if unreachable. */
    async comboOptions(cls) {
        try {
            const res = await request(`${this.server}/object_info/${encodeURIComponent(cls)}`);
            if (!res.ok) return null;
            const info = (await res.json())[cls];
            if (!info) return null;
            const out = {};
            for (const group of [info.input?.required, info.input?.optional]) {
                for (const [key, spec] of Object.entries(group || {})) {
                    const opts = Array.isArray(spec?.[0]) ? spec[0] : spec?.[1]?.options;
                    if (Array.isArray(opts)) out[key] = opts;
                }
            }
            return out;
        } catch {
            return null;
        }
    }

    /** Site favicons as data URIs (fetched outside the page, so Discord's CSP does not apply). */
    async loadIcons() {
        this.iconCache ??= new Map();
        await Promise.all(searchLinks("x").map(async ([, , domain]) => {
            if (this.iconCache.has(domain)) return;
            try {
                const res = await request(`https://${domain}/favicon.ico`);
                if (!res.ok) return;
                const bytes = new Uint8Array(await res.arrayBuffer());
                let bin = "";
                for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
                this.iconCache.set(domain, `data:${res.headers?.get?.("content-type") || "image/x-icon"};base64,${btoa(bin)}`);
            } catch { /* fall back to the text label */ }
        }));
        return this.iconCache;
    }

    async showModels(variant, title) {
        const models = extractModels(variant);
        const classes = [...new Set(models.map(m => m.cls))];
        const options = new Map();
        await Promise.all(classes.map(async c => options.set(c, await this.comboOptions(c))));
        const status = m => {
            const combos = options.get(m.cls);
            if (!combos) return { st: "unknown" };
            const lists = m.key && combos[m.key] ? [combos[m.key]] : Object.values(combos);
            return matchModel(m.name, lists.flat());
        };
        const symbols = { ok: "✓", similar: "≈", related: "~", missing: "✗", unknown: "?" };
        const reachable = [...options.values()].some(Boolean);
        const icons = await this.loadIcons();


        const h = element;
        const kinds = [...new Set(models.map(m => m.kind))];
        const content = h("div", { className: "cuw-card" },
            !reachable && h("div", { className: "cuw-note" }, `ComfyUI at ${this.server} is not reachable, so availability is unknown.`),
            kinds.map(kind => h("div", { key: kind },
                h("h4", null, kind),
                models.filter(m => m.kind === kind).map(m => {
                    const { st, matches, hint } = status(m);
                    return h("div", { className: "cuw-row", key: m.name + m.cls },
                        h("span", { className: `cuw-${st}`, title: st }, symbols[st]),
                        h("span", { className: "cuw-name" }, m.name,
                            matches && h("div", { className: "cuw-extra" }, hint + matches.slice(0, 3).join(", ") + (matches.length > 3 ? ` (+${matches.length - 3})` : ""))),
                        m.strength !== undefined && h("span", { className: "cuw-extra" }, `strength ${m.strength}`),
                        h("span", { className: "cuw-links" },
                            searchLinks(m.name).map(([label, href, domain]) => h("a", { key: label, href, title: `Search ${label}`, target: "_blank", rel: "noreferrer" },
                                icons.get(domain) ? h("img", { src: icons.get(domain), alt: label }) : label)))
                    );
                })
            ))
        );
        showDialog(`Models and LoRAs: ${title}`, content, { confirmText: "Close", cancelText: null });
    }

    /* ------------------------------------ fetching ----------------------------------- */

    /** Strip Discord resize parameters to request the original attachment. */
    originalUrl(src, kind) {
        if (!src) return null;
        try {
            const url = new URL(src, document.baseURI);
            if (!["http:", "https:"].includes(url.protocol)) return null;
            if (url.hostname === "media.discordapp.net") url.hostname = "cdn.discordapp.com";
            if (url.hostname === "cdn.discordapp.com") {
                ["width", "height", "format", "quality", "animated"].forEach(key => url.searchParams.delete(key));
            }
            if (/\.(m3u8|mpd)$/i.test(url.pathname)) return null;
            const supported = [IMAGE_EXT, RANGE_EXT, JSON_EXT].some(ext => ext.test(url.pathname));
            const extensionlessMedia = ["img", "audio", "video"].includes(kind) && !/\.[a-z0-9]+$/i.test(url.pathname);
            if (!supported && !extensionlessMedia) return null;
            url.hash = "";
            return url.href;
        } catch {
            return null;
        }
    }

    getMeta(url, kind) {
        const rangeOnly = kind === "audio" || kind === "video";
        const key = rangeOnly ? "range:" + url : url;
        if (!this.cache.has(key)) {
            this.cache.set(key, this.fetchMeta(url, rangeOnly).catch(() => null));
            if (this.cache.size > 512) this.cache.delete(this.cache.keys().next().value);
        }
        return this.cache.get(key);
    }

    async fetchMeta(url, rangeOnly) {
        const name = new URL(url).pathname;
        if (rangeOnly || RANGE_EXT.test(name)) return this.fetchLargeMeta(url, BOX_EXT.test(name));
        const res = await request(url, { maxBytes: JSON_EXT.test(name) ? MAX_JSON_FILE : MAX_MOOV });
        if (!res.ok) return null;
        const buf = new Uint8Array(await res.arrayBuffer());
        if (JSON_EXT.test(name)) return scanBytes(buf);
        return (await parsePng(buf)) ?? scanBytes(buf);
    }


    /** Video/audio can be huge: read only the parts that hold metadata. */
    async fetchLargeMeta(url, isBox) {
        const workflows = [];
        const prompts = [];
        const collect = buf => {
            const r = buf && scanBytes(buf);
            for (const v of r?.variants ?? []) {
                if (v.workflow && !workflows.includes(v.workflow)) workflows.push(v.workflow);
                if (v.prompt && !prompts.includes(v.prompt)) prompts.push(v.prompt);
            }
        };
        if (isBox) collect(await this.readMoov(url));
        if (!workflows.length && !prompts.length) {
            const [head, tail] = await Promise.all([
                this.fetchRange(url, `bytes=0-${RANGE_CHUNK - 1}`, RANGE_CHUNK),
                this.fetchRange(url, `bytes=-${RANGE_CHUNK}`, RANGE_CHUNK)
            ]);
            collect(head);
            collect(tail);
        }
        return pairVariants(workflows, prompts);
    }

    /** Walk the top-level ISO boxes with small Range requests and read the moov box. */
    async readMoov(url) {
        let off = 0;
        for (let guard = 0; guard < 64; guard++) {
            const hdr = await this.fetchRange(url, `bytes=${off}-${off + 15}`, 16);
            if (!hdr || hdr.length < 8) return null;
            const view = new DataView(hdr.buffer, hdr.byteOffset, hdr.byteLength);
            let size = view.getUint32(0);
            const type = latin.decode(hdr.subarray(4, 8));
            if (size === 1 && hdr.length >= 16) size = Number(view.getBigUint64(8));
            if (!Number.isSafeInteger(size) || size < 8) return null; // size 0 = "to end of file": nothing more to walk
            if (type === "moov") {
                return size <= MAX_MOOV ? this.fetchRange(url, `bytes=${off}-${off + size - 1}`, size) : null;
            }
            off += size;
        }
        return null;
    }



    async fetchRange(url, range, maxBytes) {
        try {
            const response = await request(url, { headers: { Range: range }, maxBytes, partial: true });
            return response.ok ? new Uint8Array(await response.arrayBuffer()) : null;
        } catch {
            return null;
        }
    }
}

new ComfyUIWorkflow().start();
})();
