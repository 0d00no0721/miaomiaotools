// ==UserScript==
// @name         知乎只看图片
// @namespace    https://github.com/0d00no0721/zhihu-image-filter
// @version      0.1.0
// @description  在知乎问题页筛选带图片的回答，可设定“至少 X 张图”阈值
// @author       0d00no0721
// @match        https://www.zhihu.com/question/*
// @run-at       document-idle
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_addStyle
// @grant        window.onurlchange
// @noframes
// ==/UserScript==

/**
 * 知乎「只看图片」—— 筛选带图片的回答
 *
 * - 在问题页右上角注入一个固定悬浮条：
 *   [☑ 只看图片]  [至少 1 张]   带图 X / 总 Y
 * - 对每个 .AnswerItem 数出正文内容图数量：
 *   优先从 <script id="js-initialData"> 里 entities.answers.<id>.content 的完整
 *   HTML 中统计（连“展开”才显示全文的折叠回答也能算到），失败时退化为直接扫 DOM。
 * - MutationObserver 监听懒加载，新滚入的回答自动走同一套判定。
 * - 用 GM_setValue 记忆开关状态与阈值。
 */
(function () {
    'use strict';

    const STORE_KEY = 'zimfState_v1';
    const ITEM_SELECTOR = '.AnswerItem';
    const RICH_SELECTOR = [
        '.RichContent-inner',
        '.RichText',
        '.RichContent',
    ].join(',');

    /* ---------------------------------------------------------------- *
     *  状态
     * ---------------------------------------------------------------- */
    const state = {
        enabled: true, // 只看图片开关
        min: 1,        // 至少多少张
    };

    function loadState() {
        try {
            const saved = GM_getValue(STORE_KEY, null);
            if (saved && typeof saved === 'object') {
                if (typeof saved.enabled === 'boolean') state.enabled = saved.enabled;
                const m = parseInt(saved.min, 10);
                if (!Number.isNaN(m) && m >= 1) state.min = m;
            }
        } catch (e) { /* 忽略 */ }
    }

    function saveState() {
        try {
            GM_setValue(STORE_KEY, { enabled: state.enabled, min: state.min });
        } catch (e) { /* 忽略 */ }
    }

    /* ---------------------------------------------------------------- *
     *  初始数据缓存（<script id="js-initialData">）
     * ---------------------------------------------------------------- */
    let initialData = null;
    function parseInitialData() {
        try {
            const el = document.getElementById('js-initialData');
            if (!el || !el.textContent) return null;
            return JSON.parse(el.textContent);
        } catch (e) {
            return null;
        }
    }

    function answerContentHtml(answerId) {
        try {
            const answers = initialData
                && initialData.initialState
                && initialData.initialState.entities
                && initialData.initialState.entities.answers;
            const a = answers && answers[answerId];
            return a ? (a.content || null) : null;
        } catch (e) {
            return null;
        }
    }

    /* ---------------------------------------------------------------- *
     *  图片计数
     * ---------------------------------------------------------------- */

    // html 字符串 → 正文内容图数量
    function countImagesFromHTML(html) {
        if (!html) return 0;
        try {
            const doc = new DOMParser().parseFromString(html, 'text/html');
            return countImagesInRoot(doc.body);
        } catch (e) {
            return 0;
        }
    }

    // DOM 元素 → 正文内容图数量
    function countImagesFromEl(el) {
        return el ? countImagesInRoot(el) : 0;
    }

    function countImagesInRoot(root) {
        if (!root || !root.querySelectorAll) return 0;
        const imgs = root.querySelectorAll('img');
        let n = 0;
        imgs.forEach((img) => {
            // 跳过内联表情小图
            if (img.hasAttribute('eeimg')) return;
            // 跳过链接卡片缩略图
            if (img.closest && img.closest('.LinkCard')) return;
            n += 1;
        });
        return n;
    }

    /* ---------------------------------------------------------------- *
     *  AnswerItem 处理
     * ---------------------------------------------------------------- */
    function answerIdOf(el) {
        // 优先用 data-zop 属性（JSON，React 会保留 data-* 属性）
        try {
            const zop = el.getAttribute('data-zop');
            if (zop) {
                const obj = JSON.parse(zop.replace(/&quot;/g, '"'));
                if (obj && obj.itemId) return String(obj.itemId);
            }
        } catch (e) { /* ignore */ }
        const n = el.getAttribute('name');
        return n ? String(n) : null;
    }

    function computeCount(el) {
        const id = answerIdOf(el);
        let count = null;
        if (id) {
            const html = answerContentHtml(id);
            if (html) count = countImagesFromHTML(html);
        }
        if (count === null) {
            const rich = el.querySelector(RICH_SELECTOR);
            count = rich ? countImagesFromEl(rich) : 0;
        }
        return count;
    }

    function addBadge(el, count) {
        let badge = el.querySelector(':scope > .zimf-badge');
        if (count >= state.min && count >= 1) {
            if (!badge) {
                badge = document.createElement('span');
                badge.className = 'zimf-badge';
                el.appendChild(badge);
            }
            badge.textContent = count + '图';
            badge.style.display = '';
        } else if (badge) {
            badge.style.display = 'none';
        }
    }

    function applyVisibility(el, count) {
        if (state.enabled && count < state.min) {
            el.classList.add('zimf-hidden');
        } else {
            el.classList.remove('zimf-hidden');
        }
    }

    function processItem(el) {
        const count = computeCount(el);
        el.dataset.zimfImgCount = String(count);
        addBadge(el, count);
        applyVisibility(el, count);
        return count;
    }

    /* ---------------------------------------------------------------- *
     *  计数与统计显示
     * ---------------------------------------------------------------- */
    function updateCounter() {
        const items = Array.from(document.querySelectorAll(ITEM_SELECTOR));
        const total = items.length;
        let qualified = 0;
        for (const it of items) {
            const c = parseInt(it.dataset.zimfImgCount, 10);
            if (!Number.isNaN(c) && c >= state.min) qualified += 1;
        }
        if (countLabel) {
            countLabel.textContent = `带图 ${qualified} / 总 ${total}`;
        }
    }

    function refreshAll() {
        const items = document.querySelectorAll(ITEM_SELECTOR);
        items.forEach(processItem);
        updateCounter();
    }

    /* ---------------------------------------------------------------- *
     *  UI：右上角固定悬浮条
     * ---------------------------------------------------------------- */
    let countLabel = null;

    function buildBar() {
        const bar = document.createElement('div');
        bar.className = 'zimf-bar';

        const toggle = document.createElement('input');
        toggle.type = 'checkbox';
        toggle.className = 'zimf-toggle';
        toggle.checked = !!state.enabled;

        const toggleLabel = document.createElement('label');
        toggleLabel.className = 'zimf-toggle-label';
        toggleLabel.appendChild(toggle);
        toggleLabel.appendChild(document.createTextNode(' 只看图片'));

        const minInput = document.createElement('input');
        minInput.type = 'number';
        minInput.min = '1';
        minInput.max = '999';
        minInput.step = '1';
        minInput.className = 'zimf-input';
        minInput.value = String(state.min);

        const minWrap = document.createElement('label');
        minWrap.className = 'zimf-min-wrap';
        minWrap.appendChild(document.createTextNode('至少 '));
        minWrap.appendChild(minInput);
        minWrap.appendChild(document.createTextNode(' 张'));

        countLabel = document.createElement('div');
        countLabel.className = 'zimf-count';

        bar.appendChild(toggleLabel);
        bar.appendChild(minWrap);
        bar.appendChild(countLabel);
        document.body.appendChild(bar);

        toggle.addEventListener('change', () => {
            state.enabled = toggle.checked;
            saveState();
            const items = document.querySelectorAll(ITEM_SELECTOR);
            items.forEach((el) => {
                const c = parseInt(el.dataset.zimfImgCount, 10) || 0;
                applyVisibility(el, c);
                addBadge(el, c);
            });
            updateCounter();
        });

        minInput.addEventListener('change', () => {
            let v = parseInt(minInput.value, 10);
            if (Number.isNaN(v) || v < 1) v = 1;
            minInput.value = String(v);
            state.min = v;
            saveState();
            refreshAll();
        });
    }

    /* ---------------------------------------------------------------- *
     *  懒加载观察器
     * ---------------------------------------------------------------- */
    let pending = false;
    function scheduleScan() {
        if (pending) return;
        pending = true;
        requestAnimationFrame(() => {
            pending = false;
            let again = false;
            document.querySelectorAll(ITEM_SELECTOR).forEach((el) => {
                if (!el.dataset.zimfImgCount) {
                    processItem(el);
                    again = true;
                }
            });
            updateCounter();
            if (again) scheduleScan();
        });
    }

    function startObserver() {
        const mo = new MutationObserver(() => scheduleScan());
        mo.observe(document.body, { childList: true, subtree: true });
        return mo;
    }

    /* ---------------------------------------------------------------- *
     *  路由切换（SPA）
     * ---------------------------------------------------------------- */
    function handleUrlChange() {
        initialData = parseInitialData();
        // 清掉已处理标记，重新绑定（initialData 已变）
        document.querySelectorAll(ITEM_SELECTOR).forEach((el) => {
            delete el.dataset.zimfImgCount;
        });
        refreshAll();
    }

    /* ---------------------------------------------------------------- *
     *  样式
     * ---------------------------------------------------------------- */
    GM_addStyle(`
        .zimf-bar {
            position: fixed;
            top: 72px;
            right: 16px;
            z-index: 10001;
            display: flex;
            align-items: center;
            gap: 10px;
            padding: 8px 12px;
            background: #ffffff;
            border: 1px solid #d9dde5;
            border-radius: 10px;
            box-shadow: 0 2px 10px rgba(0,0,0,0.12);
            font-size: 13px;
            color: #1a1a1a;
            font-family: -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
            user-select: none;
        }
        .zimf-toggle-label { cursor: pointer; white-space: nowrap; }
        .zimf-min-wrap { white-space: nowrap; color: #555; }
        .zimf-input {
            width: 44px;
            padding: 2px 4px;
            margin: 0 2px;
            border: 1px solid #d9dde5;
            border-radius: 4px;
            text-align: center;
            font-size: 13px;
        }
        .zimf-count {
            color: #1772f6;
            font-weight: 600;
            white-space: nowrap;
        }
        .zimf-bar, .zimf-bar * { box-sizing: border-box; }

        .AnswerItem.zimf-hidden { display: none !important; }

        .zimf-badge {
            position: absolute;
            top: 10px;
            right: 10px;
            z-index: 10;
            display: inline-block;
            padding: 2px 8px;
            border-radius: 10px;
            background: rgba(23, 114, 246, 0.92);
            color: #fff;
            font-size: 12px;
            font-weight: 600;
            line-height: 1.4;
            pointer-events: none;
            box-shadow: 0 1px 4px rgba(0,0,0,0.25);
        }
        .AnswerItem { position: relative; }
    `);

    /* ---------------------------------------------------------------- *
     *  初始化
     * ---------------------------------------------------------------- */
    function init() {
        loadState();
        initialData = parseInitialData();
        buildBar();
        refreshAll();
        startObserver();

        try {
            if (window.onurlchange === null) {
                window.addEventListener('urlchange', handleUrlChange);
            }
        } catch (e) { /* 不支持则不监听 */ }
    }

    init();
})();
