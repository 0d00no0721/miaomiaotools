// ==UserScript==
// @name         知乎查成分启动器
// @namespace    https://github.com/0d00no0721/who_are_you
// @version      1.1
// @description  在知乎用户主页添加"查成分"按钮, 点击后打开本地分析前端
// @author       who_are_you
// @match        https://www.zhihu.com/people/*
// @match        https://www.zhihu.com/org/*
// @grant        GM_openInTab
// @run-at       document-idle
// @noframes
// ==/UserScript==

(function() {
    'use strict';

    var FRONTEND = 'http://127.0.0.1:9588/';
    var btn = null;

    function getToken() {
        var m = location.pathname.match(/\/(people|org)\/([^/?#]+)/);
        return m ? m[2] : null;
    }

    function createButton() {
        if (btn) return;
        var token = getToken();
        if (!token) return;
        btn = document.createElement('div');
        btn.innerHTML = '🔍 查成分';
        btn.style.cssText = [
            'position:fixed', 'right:24px', 'bottom:24px',
            'z-index:99999', 'background:#1772f6', 'color:#fff',
            'padding:10px 20px', 'border-radius:24px',
            'font-size:14px', 'font-weight:600', 'cursor:pointer',
            'box-shadow:0 2px 8px rgba(0,0,0,0.3)',
            'user-select:none', 'transition:all 0.2s',
            'font-family:"Microsoft YaHei",sans-serif'
        ].join(';');
        btn.onmouseenter = function() { btn.style.background = '#0d5bd1'; };
        btn.onmouseleave = function() { btn.style.background = '#1772f6'; };
        btn.onclick = function() {
            var url = FRONTEND + '?target=' + encodeURIComponent(token);
            GM_openInTab(url, {active: true});
        };
        document.body.appendChild(btn);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', createButton);
    } else {
        createButton();
    }

    var lastUrl = location.href;
    setInterval(function() {
        if (location.href !== lastUrl) {
            lastUrl = location.href;
            if (btn) { btn.remove(); btn = null; }
            setTimeout(createButton, 1000);
        }
    }, 1000);
})();
