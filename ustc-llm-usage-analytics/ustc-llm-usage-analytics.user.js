// ==UserScript==
// @name         USTC LLM 用量统计与可视化
// @namespace    https://llm.ustc.edu.cn/
// @version      2.3.3
// @description  在线统计当天用量 + 本地持久化每日快照，形成历史累计柱状图
// @author       0d000721
// @match        https://llm.ustc.edu.cn/*
// @grant        GM_xmlhttpRequest
// @grant        GM_addStyle
// @grant        GM_registerMenuCommand
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_deleteValue
// @connect      llm.ustc.edu.cn
// @connect      cdn.jsdelivr.net
// @connect      fastly.jsdelivr.net
// @connect      unpkg.com
// @require      https://cdn.jsdelivr.net/npm/echarts@5/dist/echarts.min.js
// @grant        unsafeWindow
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  const BASE = 'https://llm.ustc.edu.cn';
  const STORE_KEY = 'ustc_usage_history';

  /* ================= 工具 ================= */
  const $ = (sel, root) => (root || document).querySelector(sel);

  function todayStr(d) {
    const t = d || new Date();
    const p = (n) => String(n).padStart(2, '0');
    return t.getFullYear() + '-' + p(t.getMonth() + 1) + '-' + p(t.getDate());
  }

  function fmtNum(n) {
    if (n == null) return '-';
    const v = Number(n);
    if (!isFinite(v)) return '-';
    if (Math.abs(v) >= 1e8) return (v / 1e8).toFixed(2) + '亿';
    if (Math.abs(v) >= 1e4) return (v / 1e4).toFixed(2) + '万';
    return String(v);
  }
  const fmtInt = fmtNum;

  function fmtMs(ms) {
    if (ms == null) return '-';
    const v = Number(ms);
    if (v < 1000) return v.toFixed(0) + ' ms';
    if (v < 60000) return (v / 1000).toFixed(2) + ' s';
    return (v / 60000).toFixed(2) + ' min';
  }
  function fmtMoney(x) {
    if (x == null) return '-';
    const v = Number(x);
    if (!isFinite(v)) return '-';
    return '¥' + v.toFixed(v < 1 ? 4 : 2);
  }

  /* ================= 网络 ================= */
  function api(path) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'GET',
        url: BASE + path,
        headers: { Accept: 'application/json' },
        onload(res) {
          if (res.status >= 200 && res.status < 300) {
            try { resolve(JSON.parse(res.responseText)); }
            catch (e) { reject(new Error('JSON 解析失败: ' + e.message)); }
          } else {
            reject(new Error('HTTP ' + res.status + ': ' + res.responseText.slice(0, 300)));
          }
        },
        onerror() { reject(new Error('网络错误')); },
        ontimeout() { reject(new Error('请求超时')); },
      });
    });
  }

  function usageQuery(startDate, endDate) {
    const q = new URLSearchParams();
    if (startDate) q.set('start_date', startDate);
    if (endDate) q.set('end_date', endDate);
    const s = q.toString();
    return s ? '?' + s : '';
  }

  function fetchSummary(startDate, endDate) {
    return api('/api/usage/summary' + usageQuery(startDate, endDate));
  }
  function fetchModels(startDate, endDate) {
    return api('/api/usage/models' + usageQuery(startDate, endDate));
  }
  // 拉全量当天明细(用于精确统计耗时/成功率)
  async function fetchAllLogs(onProgress) {
    const first = await api('/api/usage/logs?page=1&page_size=50');
    const pages = first.pages || 1;
    const total = first.total || 0;
    let items = (first.items || []).slice();
    for (let p = 2; p <= pages; p++) {
      if (onProgress) onProgress(p, pages);
      const r = await api('/api/usage/logs?page=' + p + '&page_size=50');
      items = items.concat(r.items || []);
    }
    console.log('[USTC] fetchAllLogs: 接口 total=' + total + ' pages=' + pages + ' 实际拉到=' + items.length + ' 条');
    // 过滤掉"总 Token 为 0"的访问(通常是 unknown 错误/空调用),避免污染统计与图表
    const before = items.length;
    items = items.filter((it) => {
      const v = Number(it.total_tokens);
      return isFinite(v) && v > 0;
    });
    if (before !== items.length) console.log('[USTC] fetchAllLogs: 已过滤 ' + (before - items.length) + ' 条总Token为0的记录, 剩余 ' + items.length + ' 条');
    return items;
  }

  /* ================= 持久化 ================= */
  // 存储结构: { "YYYY-MM-DD": { ts: epochMs, total: {...summary}, byModel: {name: {...}} } }
  function getHistory() {
    try { return GM_getValue(STORE_KEY, {}); }
    catch (e) { return {}; }
  }
  function saveHistory(h) {
    try { GM_setValue(STORE_KEY, h); }
    catch (e) { console.warn('[USTC] 保存历史失败', e); }
  }

  // 把某天的 summary + models 快照归档(打时间戳)
  function archiveDay(dateKey, summary, models) {
    const h = getHistory();
    const byModel = {};
    (models || []).forEach((m) => {
      byModel[m.name || '未知'] = {
        name: m.name || '未知',
        request_count: m.request_count || 0,
        prompt_tokens: m.prompt_tokens || 0,
        completion_tokens: m.completion_tokens || 0,
        cache_read_input_tokens: m.cache_read_input_tokens || 0,
        total_tokens: m.total_tokens || 0,
        spend: m.spend || 0,
      };
    });
    h[dateKey] = {
      ts: Date.now(),
      archived_at: new Date().toLocaleString('zh-CN'),
      total: summary || {},
      byModel: byModel,
    };
    saveHistory(h);
    return h;
  }

  // 用明细日志补全"昨天/前天"的每日汇总并归档(不覆盖今天,不覆盖已有的历史手动快照)
  function backfillPastDays(logs) {
    if (!logs || !logs.length) return 0;
    const today = todayStr();
    const dayBuckets = {};   // dayKey -> items
    logs.forEach((it) => {
      const t = new Date(it.started_at);
      if (isNaN(t)) return;
      const dk = todayStr(t);
      if (dk === today) return;          // 跳过今天(今天用 summary 归档)
      (dayBuckets[dk] = dayBuckets[dk] || []).push(it);
    });

    let updated = 0;
    const h = getHistory();
    Object.keys(dayBuckets).sort().forEach((dk) => {
      const items = dayBuckets[dk];
      // 聚合(明细是最近三天的完整真相,能捕捉到上次归档后新增的调用)
      let request_count = items.length;
      let prompt_tokens = 0, completion_tokens = 0, cache_read_input_tokens = 0, total_tokens = 0;
      let latencySum = 0, latencyCnt = 0, successCnt = 0, failCnt = 0;
      const byModelRaw = {};
      items.forEach((it) => {
        const name = it.model_name || it.model || '未知';
        prompt_tokens += Number(it.prompt_tokens) || 0;
        completion_tokens += Number(it.completion_tokens) || 0;
        cache_read_input_tokens += Number(it.cache_read_input_tokens) || 0;
        total_tokens += Number(it.total_tokens) || 0;
        if (it.latency_ms != null) { latencySum += Number(it.latency_ms) || 0; latencyCnt++; }
        const st = String(it.status || '');
        if (st === '成功' || /success/i.test(st)) successCnt++; else failCnt++;
        (byModelRaw[name] = byModelRaw[name] || { name: name, request_count: 0, prompt_tokens: 0, completion_tokens: 0, cache_read_input_tokens: 0, total_tokens: 0, spend: 0 });
        byModelRaw[name].request_count++;
        byModelRaw[name].prompt_tokens += Number(it.prompt_tokens) || 0;
        byModelRaw[name].completion_tokens += Number(it.completion_tokens) || 0;
        byModelRaw[name].cache_read_input_tokens += Number(it.cache_read_input_tokens) || 0;
        byModelRaw[name].total_tokens += Number(it.total_tokens) || 0;
      });
      // 保留之前归档里已有的 spend(明细不含费用字段)
      const prevSpend = (h[dk] && h[dk].total && Number(h[dk].total.spend)) || 0;
      const summary = {
        request_count, prompt_tokens, completion_tokens,
        cache_read_input_tokens, total_tokens, spend: prevSpend,
      };
      const models = Object.values(byModelRaw);
      const byModel = {};
      models.forEach((m) => { byModel[m.name] = m; });

      // 覆盖式更新:用明细的最新聚合替换该天(捕捉归档后新增的调用)
      const prev = h[dk];
      h[dk] = {
        ts: Date.now(),
        archived_at: new Date().toLocaleString('zh-CN') + ' (由访问日志完善)',
        total: summary,
        byModel: byModel,
        source: 'logs-backfill',
      };
      updated++;
    });
    if (updated) saveHistory(h);
    console.log('[USTC] 完善历史:', updated, '天 (', Object.keys(dayBuckets).sort().join(', '), ')');
    return updated;
  }

/* ================= ECharts ================= */
  let echartsPromise = null;
  function loadECharts() {
    if (window.__ustc_echarts) return Promise.resolve(window.__ustc_echarts);
    if (echartsPromise) return echartsPromise;
    echartsPromise = new Promise((resolve, reject) => {
      // 1) 优先取 Tampermonkey @require 注入的全局 echarts
      const g = (typeof unsafeWindow !== 'undefined' && unsafeWindow.echarts) ? unsafeWindow.echarts
             : (window.echarts || (typeof globalThis !== 'undefined' ? globalThis.echarts : null));
      if (g) { window.__ustc_echarts = g; resolve(g); return; }

      // 2) 否则动态注入,多源依次尝试
      const srcs = [
        'https://fastly.jsdelivr.net/npm/echarts@5/dist/echarts.min.js',
        'https://unpkg.com/echarts@5/dist/echarts.min.js',
        'https://registry.npmmirror.com/echarts/5.5.0/files/dist/echarts.min.js',
        'https://cdn.bootcdn.net/ajax/libs/echarts/5.5.0/echarts.min.js',
      ];
      let i = 0;
      const tryNext = () => {
        if (i >= srcs.length) { reject(new Error('无法加载 ECharts，所有 CDN 源均失败（可能被跟踪防护/广告拦截）')); return; }
        const url = srcs[i++];
        const s = document.createElement('script');
        s.src = url;
        s.onload = () => {
          const g2 = window.echarts || (typeof globalThis !== 'undefined' ? globalThis.echarts : null);
          if (g2) { window.__ustc_echarts = g2; resolve(g2); }
          else tryNext();
        };
        s.onerror = tryNext;
        document.head.appendChild(s);
      };
      tryNext();
    });
    return echartsPromise.then((e) => { window.__ustc_echarts = e; return e; });
  }

  /* ================= 样式 ================= */
  GM_addStyle(`
    #ustc-usage-fab {
      position: fixed; z-index: 2147483000; right: 24px; bottom: 24px;
      width: 52px; height: 52px; border-radius: 50%;
      background: linear-gradient(135deg, #2563eb, #1d4ed8); color: #fff;
      border: none; cursor: pointer; font-size: 22px;
      box-shadow: 0 6px 20px rgba(37,99,235,.45);
      display: flex; align-items: center; justify-content: center;
      transition: transform .15s ease;
    }
    #ustc-usage-fab:hover { transform: scale(1.08); }
    #ustc-usage-fab.loading { animation: ustc-spin 1s linear infinite; }
    @keyframes ustc-spin { to { transform: rotate(360deg); } }

    #ustc-usage-drawer {
      position: fixed; z-index: 2147483001; top: 0; right: 0; bottom: 0;
      width: 920px; max-width: 98vw; background: #0f172a; color: #e2e8f0;
      box-shadow: -8px 0 40px rgba(0,0,0,.5);
      transform: translateX(100%); transition: transform .25s ease;
      display: flex; flex-direction: column;
      font-family: system-ui, -apple-system, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif;
    }
    #ustc-usage-drawer.open { transform: translateX(0); }
    #ustc-usage-drawer .hdr {
      padding: 16px 20px; border-bottom: 1px solid #1e293b;
      display: flex; align-items: center; justify-content: space-between;
    }
    #ustc-usage-drawer .hdr h2 { margin: 0; font-size: 17px; font-weight: 600; }
    #ustc-usage-drawer .close {
      background: #1e293b; color: #cbd5e1; border: none; cursor: pointer;
      width: 30px; height: 30px; border-radius: 8px; font-size: 16px;
    }

    #ustc-usage-drawer .tabs {
      display: flex; gap: 6px; padding: 12px 20px 0;
      border-bottom: 1px solid #1e293b;
    }
    #ustc-usage-drawer .tab {
      background: transparent; color: #94a3b8; border: none; cursor: pointer;
      padding: 8px 16px; border-radius: 8px 8px 0 0; font-size: 14px;
      border-bottom: 2px solid transparent; margin-bottom: -1px;
    }
    #ustc-usage-drawer .tab.active {
      color: #fff; border-bottom-color: #2563eb; background: #131c2e;
    }

    #ustc-usage-drawer .toolbar {
      padding: 12px 20px; display: flex; gap: 10px; align-items: center; flex-wrap: wrap;
      border-bottom: 1px solid #1e293b;
    }
    #ustc-usage-drawer .toolbar button {
      background: #2563eb; color: #fff; border: none; cursor: pointer;
      padding: 8px 14px; border-radius: 8px; font-size: 13px;
    }
    #ustc-usage-drawer .toolbar button.ghost { background: #1e293b; color: #cbd5e1; }
    #ustc-usage-drawer .toolbar button:disabled { opacity: .5; cursor: default; }
    #ustc-usage-drawer .toolbar button.danger { background: #7f1d1d; }
    #ustc-usage-drawer .seg-group { display: inline-flex; gap: 4px; background: #1e293b; border-radius: 8px; padding: 3px; }
    #ustc-usage-drawer .seg-group button {
      background: transparent; color: #94a3b8; border: none; cursor: pointer;
      padding: 5px 10px; border-radius: 6px; font-size: 12px;
    }
    #ustc-usage-drawer .seg-group button.active { background: #2563eb; color: #fff; }
    #ustc-usage-drawer .hist-controls { display: flex; align-items: center; gap: 12px; padding: 12px 20px; border-bottom: 1px solid #1e293b; flex-wrap: wrap; }
    #ustc-usage-drawer .hist-controls .cap { font-size: 12px; color: #64748b; }

    #ustc-usage-drawer .kpis {
      display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; padding: 16px 20px 0;
    }
    #ustc-usage-drawer .kpi { background: #1e293b; border-radius: 10px; padding: 12px 14px; }
    #ustc-usage-drawer .kpi .lbl { font-size: 12px; color: #94a3b8; }
    #ustc-usage-drawer .kpi .val { font-size: 20px; font-weight: 700; margin-top: 4px; color: #fff; }

    #ustc-usage-drawer .body {
      flex: 1; overflow-y: auto; padding: 16px 20px 24px;
      display: flex; flex-direction: column; gap: 18px;
    }
    #ustc-usage-drawer .chart { width: 100%; height: 320px; background: #0b1220; border-radius: 10px; }
    #ustc-usage-drawer .chart.tall { height: 380px; }
    #ustc-usage-drawer .card {
      background: #131c2e; border-radius: 12px; padding: 14px 16px; border: 1px solid #1e293b;
    }
    #ustc-usage-drawer .card h3 { margin: 0 0 10px; font-size: 14px; color: #cbd5e1; font-weight: 600; }
    #ustc-usage-drawer .card .note { font-size: 12px; color: #64748b; margin-top: 8px; }
    #ustc-usage-drawer .empty { color: #64748b; text-align: center; padding: 40px 0; font-size: 14px; }
    #ustc-usage-drawer .err { color: #f87171; background: #2a1215; border-radius: 8px; padding: 12px; font-size: 13px; white-space: pre-wrap; }
    #ustc-usage-drawer .progress { height: 6px; background: #1e293b; border-radius: 3px; overflow: hidden; margin-top: 8px; }
    #ustc-usage-drawer .progress > div { height: 100%; background: #2563eb; width: 0; transition: width .2s; }
  `);

  /* ================= UI 骨架 ================= */
  const fab = document.createElement('button');
  fab.id = 'ustc-usage-fab';
  fab.title = '用量统计与可视化';
  fab.textContent = '📊';
  document.body.appendChild(fab);

  const drawer = document.createElement('div');
  drawer.id = 'ustc-usage-drawer';
  drawer.innerHTML = `
    <div class="hdr"><h2>📊 用量统计与可视化</h2><button class="close">✕</button></div>
    <div class="tabs">
      <button class="tab active" data-tab="today">当天</button>
      <button class="tab" data-tab="history">历史累计</button>
    </div>
    <div class="toolbar">
      <button id="ustc-btn-load">🔄 刷新并归档</button>
      <button id="ustc-btn-export" class="ghost">⬇ 导出 CSV</button>
      <button id="ustc-btn-clear-history" class="ghost danger">🗑 清空本地历史</button>
    </div>
    <div class="kpis" id="ustc-kpis"></div>
    <div class="body" id="ustc-body"></div>
  `;
  document.body.appendChild(drawer);

  let currentTab = 'today';
  let lastTodaySummary = null;
  let lastTodayModels = [];
  let lastLogItems = [];
  let histRangeDays = 7;   // 历史展示天数范围(7/15/30)
  let histMode = 'bar';    // bar=柱状(堆叠) / line=累计折线

  /* 标签切换 */
  drawer.querySelectorAll('.tab').forEach((t) => {
    t.addEventListener('click', () => {
      drawer.querySelectorAll('.tab').forEach((x) => x.classList.remove('active'));
      t.classList.add('active');
      currentTab = t.dataset.tab;
      renderActive();
    });
  });
  drawer.querySelector('.close').addEventListener('click', () => drawer.classList.remove('open'));
  drawer.querySelector('#ustc-btn-load').addEventListener('click', load);
  drawer.querySelector('#ustc-btn-export').addEventListener('click', exportCSV);
  drawer.querySelector('#ustc-btn-clear-history').addEventListener('click', () => {
    if (confirm('确认清空本地累计的历史快照？此操作不可恢复。')) {
      GM_deleteValue(STORE_KEY);
      renderHistory();
    }
  });

  fab.addEventListener('click', () => {
    drawer.classList.toggle('open');
    if (drawer.classList.contains('open') && !lastTodaySummary) load();
  });

  /* ================= 渲染 ================= */
  function renderActive() {
    if (currentTab === 'today') renderToday();
    else renderHistory();
  }

  function setKPIs(cards) {
    $('#ustc-kpis').innerHTML = cards.map((c) =>
      '<div class="kpi"><div class="lbl">' + c.lbl + '</div><div class="val">' + c.val + '</div></div>'
    ).join('');
  }

  function card(title) {
    const c = document.createElement('div');
    c.className = 'card';
    const h = document.createElement('h3');
    h.textContent = title;
    c.appendChild(h);
    return c;
  }
  function div(cls) { const d = document.createElement('div'); d.className = cls; return d; }

  // 按半小时粒度 + 模型 聚合明细日志,返回 { slots, models, matrix }
  // matrix[modelName][slotIndex] = total_tokens
  function buildHalfHourSeries(items) {
    const p = (n) => String(n).padStart(2, '0');
    const now = Date.now();
    const windowStart = now - 24 * 3600 * 1000;

    // 对齐到半小时边界
    const startD = new Date(windowStart);
    const startMin = startD.getMinutes() < 30 ? 0 : 30;
    const windowStartAligned = new Date(startD);
    windowStartAligned.setMinutes(startMin, 0, 0);

    // 生成完整半小时槽序列(大约48个)
    const allSlots = [];
    let cur = windowStartAligned.getTime();
    while (cur <= now) {
      const d = new Date(cur);
      const hh = p(d.getHours());
      const mm = p(d.getMinutes());
      const slotKey = todayStr(d) + ' ' + hh + ':' + mm;
      const label = p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + hh + ':' + mm;
      allSlots.push({ slotKey, label, ts: cur, totalTokens: 0, byModel: {} });
      cur += 30 * 60 * 1000;
    }

    const modelSet = new Set();
    // 填充数据
    items.forEach((it) => {
      const t = new Date(it.started_at);
      if (isNaN(t)) return;
      const ts = t.getTime();
      if (ts < windowStartAligned.getTime() || ts > now) return;
      // 定位所属槽
      const idx = Math.floor((ts - windowStartAligned.getTime()) / (30 * 60 * 1000));
      if (idx < 0 || idx >= allSlots.length) return;
      const slot = allSlots[idx];
      const model = it.model_name || it.model || '未知';
      modelSet.add(model);
      const tk = Number(it.total_tokens) || 0;
      slot.byModel[model] = (slot.byModel[model] || 0) + tk;
      slot.totalTokens += tk;
    });

    const models = Array.from(modelSet).sort();

    // 合并连续空闲槽 -> segments
    const segments = [];
    let idleRun = null;
    allSlots.forEach((slot, idx) => {
      if (slot.totalTokens === 0) {
        if (!idleRun) idleRun = { startIdx: idx, endIdx: idx, startLabel: slot.label, endTs: slot.ts };
        else { idleRun.endIdx = idx; idleRun.endTs = slot.ts; }
      } else {
        if (idleRun) { segments.push({ type: 'idle', data: idleRun }); idleRun = null; }
        segments.push({ type: 'active', slot: slot, idx: idx });
      }
    });
    if (idleRun) segments.push({ type: 'idle', data: idleRun });

    // 计算空闲时长文案
    function fmtIdleSpan(ms) {
      const m = Math.round(ms / 60000);
      if (m < 60) return m + '分钟';
      return (m / 60).toFixed(1) + '小时';
    }

    // 组装 labels + 每模型每段数据 + 空闲区间(用于 markArea)
    const labels = [];
    const idleRanges = [];
    const segData = {};   // model -> number[]  (对齐 segments)
    models.forEach((m) => { segData[m] = []; });

    segments.forEach((seg) => {
      if (seg.type === 'idle') {
        const startSlot = allSlots[seg.data.startIdx];
        const endSlot = allSlots[seg.data.endIdx];
        const spanMs = (endSlot.ts + 30 * 60 * 1000) - startSlot.ts;
        const label = startSlot.label.split(' ')[1] + ' ~ ' + (function () {
          const ed = new Date(endSlot.ts + 30 * 60 * 1000);
          return p(ed.getHours()) + ':' + p(ed.getMinutes());
        })() + '\n(空闲 ' + fmtIdleSpan(spanMs) + ')';
        labels.push(label);
        idleRanges.push({ name: '空闲', label: label.replace('\n', ' ') });
        models.forEach((m) => { segData[m].push(0); });
      } else {
        labels.push(seg.slot.label);
        models.forEach((m) => { segData[m].push(seg.slot.byModel[m] || 0); });
      }
    });

    return { labels, models, segData, idleRanges, segments };
  }

  // 统一图表初始化:延迟一帧 + 主动 resize,避免抽屉/SPA 场景尺寸为 0 导致不显示
  function makeChart(el, option) {
    const ec = window.__ustc_echarts;
    if (!ec) { console.warn('[USTC] ECharts 未就绪'); return null; }
    // 强制容器尺寸(兜底)
    el.style.width = '100%';
    if (!el.clientHeight) el.style.height = '320px';
    console.log('[USTC debug] makeChart 容器尺寸 w=' + el.clientWidth + ' h=' + el.clientHeight + ' 偏移=' + el.getBoundingClientRect().width + 'x' + el.getBoundingClientRect().height);
    const chart = ec.init(el, null, { renderer: 'canvas' });
    // 注入动画:折线图从左到右延伸,柱状图从下往上生长
    const hasLine = (option.series || []).some((s) => (s.type || '').indexOf('line') !== -1);
    const anim = hasLine
      ? { animation: true, animationDuration: 1200, animationDurationUpdate: 600, animationEasing: 'linear', animationEasingUpdate: 'linear' }
      : { animation: true, animationDuration: 900, animationDurationUpdate: 500, animationEasing: 'cubicOut', animationEasingUpdate: 'cubicInOut' };
    chart.setOption(Object.assign({}, anim, option));
    console.log('[USTC debug] makeChart 实例化后 canvas 数=' + el.querySelectorAll('canvas').length);
    // 用 setTimeout 确保抽屉 transition 完成后再 resize
    setTimeout(() => { try { chart.resize(); } catch (e) { console.warn('[USTC] resize err', e); } }, 350);
    return chart;
  }

  /* --- 当天渲染 --- */
  function renderToday() {
    const body = $('#ustc-body');
    body.innerHTML = '';
    if (!lastTodaySummary) {
      body.innerHTML = '<div class="empty">点击「🔄 刷新并归档」开始抓取当天数据</div>';
      return;
    }
    const s = lastTodaySummary;
    setKPIs([
      { lbl: '请求数', val: fmtInt(s.request_count) },
      { lbl: '总 Token', val: fmtInt(s.total_tokens) },
      { lbl: '输入 Token', val: fmtInt(s.prompt_tokens) },
      { lbl: '输出 Token', val: fmtInt(s.completion_tokens) },
      { lbl: '缓存命中', val: fmtInt(s.cache_read_input_tokens) },
      { lbl: '费用', val: fmtMoney(s.spend) },
    ]);

    const echarts = window.__ustc_echarts;
    console.log('[USTC debug] echarts ready:', !!echarts, 'models raw count:', (lastTodayModels || []).length, 'models:', lastTodayModels);

    // 按时间统计(半小时粒度,按模型分层设色)
    if (lastLogItems && lastLogItems.length) {
      const cardT = card('最近24小时按时间统计（半小时粒度 · 按模型分层设色）');
      const cT = div('chart tall'); cardT.appendChild(cT); body.appendChild(cardT);
      if (echarts) {
        const agg = buildHalfHourSeries(lastLogItems);
        const palette = ['#3b82f6', '#f59e0b', '#22c55e', '#f97316', '#06b6d4', '#8b5cf6', '#ec4899', '#14b8a6', '#eab308', '#ef4444'];
        const series = agg.models.map((m, i) => ({
          name: m,
          type: 'bar',
          stack: 'time',
          data: agg.segData[m],
          itemStyle: { color: palette[i % palette.length] },
        }));
        // 空闲区间用 markArea 灰色高亮(以 dataIndex 定位)
        const markAreas = [];
        let segIndex = 0;
        agg.segments.forEach((seg) => {
          if (seg.type === 'idle') {
            markAreas.push([{ itemStyle: { color: 'rgba(148,163,184,0.12)' }, xAxis: segIndex }, { xAxis: segIndex }]);
          }
          segIndex++;
        });
        if (markAreas.length) series[series.length - 1].markArea = { silent: true, data: markAreas };

        makeChart(cT, {
          tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
          legend: { top: 4, textStyle: { color: '#cbd5e1' }, type: 'scroll' },
          grid: { left: 8, right: 8, top: 40, bottom: 20, containLabel: true },
          xAxis: { type: 'category', data: agg.labels, axisLabel: { color: '#94a3b8', rotate: 45, interval: 0 } },
          yAxis: { type: 'value', axisLabel: { color: '#94a3b8' } },
          series: series,
        });
      }
    } else {
      const cardT = card('最近24小时按时间统计');
      cardT.innerHTML = '<h3>最近24小时按时间统计</h3><div class="empty">暂无明细数据</div>';
      body.appendChild(cardT);
    }

    // 归档说明
    const h = getHistory();
    const today = todayStr();
    const note = card('归档状态');
    note.innerHTML = '<h3>归档状态</h3><div style="font-size:13px;color:#94a3b8;">' +
      (h[today] ? '✅ 今天快照已归档 · 时间戳：' + h[today].archived_at : '⏳ 今天尚未归档（点「🔄 刷新并归档」）') +
      '<div class="note">本地历史共 ' + Object.keys(h).length + ' 天</div></div>';
    body.appendChild(note);
  }

  /* --- 历史累计渲染 --- */
  function renderHistory() {
    const body = $('#ustc-body');
    body.innerHTML = '';
    const h = getHistory();
    const days = Object.keys(h).sort();

    if (!days.length) {
      setKPIs([
        { lbl: '累计天数', val: '0' },
        { lbl: '累计请求', val: '0' },
        { lbl: '累计 Token', val: '0' },
      ]);
      body.innerHTML = '<div class="empty">还没有本地历史快照。<br/>打开当天页点击「🔄 刷新并归档」，从今天开始积累，往后每天都会自动存档一天。</div>';
      return;
    }

    let totalReq = 0, totalTok = 0, totalSpend = 0;
    const firstDay = days[0], lastDay = days[days.length - 1];
    days.forEach((d) => {
      const s = h[d].total || {};
      totalReq += Number(s.request_count) || 0;
      totalTok += Number(s.total_tokens) || 0;
      totalSpend += Number(s.spend) || 0;
    });

    setKPIs([
      { lbl: '累计天数', val: fmtInt(days.length) },
      { lbl: '累计请求', val: fmtInt(totalReq) },
      { lbl: '累计 Token', val: fmtInt(totalTok) },
      { lbl: '累计费用', val: fmtMoney(totalSpend) },
      { lbl: '首次记录', val: firstDay },
      { lbl: '最近记录', val: lastDay },
    ]);

    const echarts = window.__ustc_echarts;

    // ---- 控制条:范围 + 模式 ----
    const controls = document.createElement('div');
    controls.className = 'hist-controls';
    const rangeGroup = document.createElement('div');
    rangeGroup.className = 'seg-group';
    [7, 15, 30].forEach((n) => {
      const b = document.createElement('button');
      b.textContent = n + '天';
      if (histRangeDays === n) b.classList.add('active');
      b.addEventListener('click', () => { histRangeDays = n; renderHistory(); });
      rangeGroup.appendChild(b);
    });
    const modeGroup = document.createElement('div');
    modeGroup.className = 'seg-group';
    const modeBar = document.createElement('button');
    modeBar.textContent = '柱状图';
    if (histMode === 'bar') modeBar.classList.add('active');
    modeBar.addEventListener('click', () => { histMode = 'bar'; renderHistory(); });
    const modeDaily = document.createElement('button');
    modeDaily.textContent = '单日折线';
    if (histMode === 'daily') modeDaily.classList.add('active');
    modeDaily.addEventListener('click', () => { histMode = 'daily'; renderHistory(); });
    const modeLine = document.createElement('button');
    modeLine.textContent = '累计折线';
    if (histMode === 'line') modeLine.classList.add('active');
    modeLine.addEventListener('click', () => { histMode = 'line'; renderHistory(); });
    modeGroup.appendChild(modeBar); modeGroup.appendChild(modeDaily); modeGroup.appendChild(modeLine);

    controls.appendChild(document.createTextNode('范围'));
    controls.appendChild(rangeGroup);
    controls.appendChild(document.createTextNode('模式'));
    controls.appendChild(modeGroup);
    body.appendChild(controls);

    // ---- 展示天数 = min(已有天数, 选择) ----
    const showDays = Math.min(days.length, histRangeDays);
    const selectedDays = days.slice(-showDays);

    // 模型全集 + 各天各模型 token
    const modelSet = new Set();
    selectedDays.forEach((d) => {
      Object.keys(h[d].byModel || {}).forEach((m) => { modelSet.add(m); });
    });
    const models = Array.from(modelSet).sort();
    const perDay = {};
    models.forEach((m) => { perDay[m] = {}; });
    selectedDays.forEach((d) => {
      const bm = h[d].byModel || {};
      models.forEach((m) => { perDay[m][d] = Number((bm[m] && bm[m].total_tokens)) || 0; });
    });

    const palette = ['#3b82f6', '#f59e0b', '#22c55e', '#f97316', '#06b6d4', '#8b5cf6', '#ec4899', '#14b8a6', '#eab308', '#ef4444'];

    let title, series, yName;
    if (histMode === 'bar') {
      title = '每日用量（按模型分层设色 · 最近 ' + showDays + ' 天）';
      series = models.map((m, i) => ({
        name: m,
        type: 'bar',
        stack: 'day',
        data: selectedDays.map((d) => perDay[m][d]),
        itemStyle: { color: palette[i % palette.length] },
      }));
      yName = 'Token';
    } else if (histMode === 'daily') {
      title = '单日用量（按模型 · 最近 ' + showDays + ' 天）';
      series = models.map((m, i) => ({
        name: m,
        type: 'line',
        smooth: true,
        data: selectedDays.map((d) => perDay[m][d]),
        itemStyle: { color: palette[i % palette.length] },
      }));
      yName = 'Token';
    } else {
      title = '累计用量（按模型 · 最近 ' + showDays + ' 天）';
      series = models.map((m, i) => {
        let acc = 0;
        const data = selectedDays.map((d) => { acc += perDay[m][d]; return acc; });
        return { name: m, type: 'line', smooth: true, data: data, itemStyle: { color: palette[i % palette.length] }, areaStyle: { opacity: 0.06 } };
      });
      yName = '累计 Token';
    }

    const cardChart = card(title);
    const c = div('chart tall'); cardChart.appendChild(c); body.appendChild(cardChart);
    if (echarts) {
      makeChart(c, {
        tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
        legend: { top: 4, textStyle: { color: '#cbd5e1' }, type: 'scroll' },
        grid: { left: 8, right: 8, top: 40, bottom: 6, containLabel: true },
        xAxis: { type: 'category', data: selectedDays, axisLabel: { color: '#94a3b8' } },
        yAxis: { type: 'value', name: yName, nameTextStyle: { color: '#64748b' }, axisLabel: { color: '#94a3b8' } },
        series: series,
      });
    }

    const note = card('说明');
    note.innerHTML = '<h3>说明</h3><div style="font-size:13px;color:#94a3b8;line-height:1.7;">' +
      '数据保存在浏览器本地（Tampermonkey 存储），不上传。<br/>' +
      '展示天数 = min(已累积天数, 所选范围)。当前显示最近 ' + showDays + ' 天。<br/>' +
      '「单日折线」为每天实际用量；「累计折线」为按模型的逐日累加值。之前未采集的历史无法找回。</div>';
    body.appendChild(note);
  }

  /* ================= 导出 CSV ================= */
  function exportCSV() {
    const header = ['模型', '请求数', '输入Token', '输出Token', '缓存命中', '总Token', '费用'];
    if (currentTab === 'today' && lastTodayModels.length) {
      // 当天:直接按模型导出
      const rows = lastTodayModels
        .slice().sort((a, b) => (b.total_tokens || 0) - (a.total_tokens || 0))
        .map((m) => [m.name, m.request_count, m.prompt_tokens, m.completion_tokens, m.cache_read_input_tokens, m.total_tokens, m.spend]);
      downloadCSV('ustc-分模型统计-当天-' + todayStr() + '.csv', header, rows);
    } else if (currentTab === 'history') {
      // 历史累计:跨天按模型聚合导出
      const h = getHistory();
      const days = Object.keys(h).sort();
      const acc = {};
      days.forEach((d) => {
        Object.values(h[d].byModel || {}).forEach((m) => {
          const k = m.name || '未知';
          (acc[k] = acc[k] || { name: k, request_count: 0, prompt_tokens: 0, completion_tokens: 0, cache_read_input_tokens: 0, total_tokens: 0, spend: 0 });
          acc[k].request_count += Number(m.request_count) || 0;
          acc[k].prompt_tokens += Number(m.prompt_tokens) || 0;
          acc[k].completion_tokens += Number(m.completion_tokens) || 0;
          acc[k].cache_read_input_tokens += Number(m.cache_read_input_tokens) || 0;
          acc[k].total_tokens += Number(m.total_tokens) || 0;
          acc[k].spend += Number(m.spend) || 0;
        });
      });
      const rows = Object.values(acc)
        .sort((a, b) => b.total_tokens - a.total_tokens)
        .map((m) => [m.name, m.request_count, m.prompt_tokens, m.completion_tokens, m.cache_read_input_tokens, m.total_tokens, m.spend]);
      if (!rows.length) { alert('历史累计还没有数据，先到「当天」页刷新并归档'); return; }
      downloadCSV('ustc-分模型统计-历史累计.csv', header, rows);
    } else {
      alert('暂无数据可导出，请先「刷新并归档」');
    }
  }
  function downloadCSV(filename, header, rows) {
    const csv = [header, ...rows].map((r) => r.map((c) => {
      const s = String(c == null ? '' : c);
      return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    }).join(',')).join('\n');
    const blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  /* ================= 主加载 ================= */
  async function load() {
    const btn = $('#ustc-btn-load');
    if (btn) btn.disabled = true;
    fab.classList.add('loading');
    const body = $('#ustc-body');
    const today = todayStr();
    body.innerHTML = '<div class="empty">正在抓取当天用量并归档，请稍候…<div class="progress"><div id="ustc-prog" style="width:30%"></div></div></div>';

    try {
      await loadECharts();
      $('#ustc-prog').style.width = '50%';

      // 当天汇总 + 按模型 + 明细日志(最近三天,用于时间图与历史补全)
      const [summary, models, logs] = await Promise.all([
        fetchSummary(today, today),
        fetchModels(today, today),
        fetchAllLogs(),
      ]);
      $('#ustc-prog').style.width = '80%';

      lastTodaySummary = summary;
      lastTodayModels = (models || []).filter((m) => {
        const v = Number(m.total_tokens);
        return isFinite(v) && v > 0;   // 剔除总Token为0的模型(unknown/错误)
      });

      // 明细拆分:
      //  - 时间图窗口 = 从现在往前 24 小时(跨自然日)
      //  - 其余(早于24h但在最近三天内)用于补全昨天/前天历史
      const nowTs = Date.now();
      const windowLogs = [];   // 24h 窗口内,用于时间图
      const otherLogs = [];    // 更早的,用于补全历史
      (logs || []).forEach((it) => {
        const t = new Date(it.started_at);
        if (isNaN(t)) return;
        const ts = t.getTime();
        if (ts >= nowTs - 24 * 3600 * 1000 && ts <= nowTs) windowLogs.push(it);
        else otherLogs.push(it);
      });
      lastLogItems = windowLogs;   // 时间图用最近24小时
      console.log('[USTC] 明细拆分: 最近24小时', windowLogs.length, '条 / 更早(用于补全历史)', otherLogs.length, '条');

      // 兜底:若 models 接口返回空,改用今天的访问日志明细按模型聚合
      if (!lastTodayModels || !lastTodayModels.length) {
        const agg = {};
        windowLogs.forEach((it) => {
          const name = it.model_name || it.model || '未知';
          (agg[name] = agg[name] || {
            name: name, request_count: 0, prompt_tokens: 0,
            completion_tokens: 0, cache_read_input_tokens: 0, total_tokens: 0, spend: 0,
          });
          agg[name].request_count++;
          agg[name].prompt_tokens += Number(it.prompt_tokens) || 0;
          agg[name].completion_tokens += Number(it.completion_tokens) || 0;
          agg[name].cache_read_input_tokens += Number(it.cache_read_input_tokens) || 0;
          agg[name].total_tokens += Number(it.total_tokens) || 0;
        });
        lastTodayModels = Object.values(agg);
        console.log('[USTC] models 接口为空,已用今天访问日志兜底聚合:', lastTodayModels.length, '个模型');
      }

      // 归档今天快照(打时间戳,覆盖式)
      archiveDay(today, summary, lastTodayModels);

      // 用完整明细(最近三天)补全昨天/前天的历史快照
      // 注意:必须用 logs 全量,而非 otherLogs(否则昨天落在24h窗口内的部分会丢失)
      backfillPastDays(logs || []);

      $('#ustc-prog').style.width = '100%';
      renderActive();
    } catch (e) {
      body.innerHTML = '<div class="err">加载失败：\n' + (e && e.message ? e.message : e) + '</div>';
    } finally {
      if (btn) btn.disabled = false;
      fab.classList.remove('loading');
    }
  }

  GM_registerMenuCommand('打开用量统计面板', () => {
    drawer.classList.add('open');
    if (!lastTodaySummary) load();
  });

  console.log('[USTC LLM Analytics] 脚本已加载，点击右下角 📊 按钮打开统计面板。');
})();