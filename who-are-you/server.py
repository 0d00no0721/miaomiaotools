# -*- coding: utf-8 -*-
"""who_are_you 本地 HTTP 服务 + Web 前端。

监听 127.0.0.1:9588:
  GET  /              → Web 前端页面 (进度展示 + 结果展示)
  GET  /ping          → 健康检查
  POST /analyze       → 启动分析任务, 立即返回 job_id
  GET  /progress?id=  → 查询任务进度 (phase, progress, log, result)
"""
import http.server
import json
import os
import re
import subprocess
import sys
import threading
import time
import urllib.parse
from pathlib import Path

BASE = Path(__file__).resolve().parent
PORT = 9588

# ---------------------------------------------------------------------------
# Job 管理
# ---------------------------------------------------------------------------
_jobs = {}
_job_lock = threading.Lock()

# main.py 输出里的阶段标记 → 进度百分比
_PHASE_MAP = [
    (r"\[1/5\]", 10, "采集个人主页"),
    (r"\[2/5\]", 30, "采集回答列表"),
    (r"\[3/5\]", 50, "读取最高赞回答"),
    (r"\[4/5\]", 65, "查询关注关系"),
    (r"\[5/5\]", 75, "保存数据"),
    (r"分词与关键词", 82, "关键词提取"),
    (r"生成词云", 88, "生成词云图"),
    (r"调用 LLM", 92, "LLM 倾向分析"),
    (r"生成报告", 98, "生成报告"),
    (r"完成", 100, "完成"),
]


def _parse_progress(line):
    """从 main.py 的 stdout 行解析 (progress_pct, phase_text)。"""
    for pat, pct, label in _PHASE_MAP:
        if re.search(pat, line):
            return pct, label
    return None, None


def _extract_result(stdout, token):
    """从 stdout 和数据文件提取完整结果。"""
    result = {"report": "", "report_url": "", "summary": "", "scores": {},
              "profile": {}, "follow": {}, "keywords": [], "analysis": {},
              "top_list": [], "articles_count": 0}
    for line in stdout.splitlines():
        if "报告已保存" in line:
            p = line.split(":", 1)[-1].strip()
            result["report"] = p
            result["report_url"] = "file:///" + p.replace("\\", "/")
    # 从 stdout 提取分数和概括
    for line in stdout.splitlines():
        if "概括:" in line:
            result["summary"] = line.split("概括:", 1)[-1].strip()[:500]
        for dim in ("political", "economic", "cultural"):
            if dim in line and "(" in line:
                m = re.search(r"(\-?\d+)\s*\((.+?)\)", line)
                if m:
                    result["scores"][dim] = {"score": int(m.group(1)), "label": m.group(2)}
    # 从数据文件提取完整信息
    if token:
        data_file = BASE / "data" / ("%s.json" % token)
        if data_file.exists():
            try:
                d = json.loads(data_file.read_text(encoding="utf-8"))
                result["profile"] = d.get("profile", {})
                result["follow"] = d.get("follow", {})
                result["answers_count"] = len(d.get("answers", []))
                result["articles_count"] = len(d.get("articles", []))
                # 高赞内容 Top 10 (回答 + 文章混合)
                all_content = []
                for a in d.get("answers", []):
                    all_content.append({"type": "回答", "title": a.get("title", ""),
                                        "votes": a.get("votes", 0),
                                        "excerpt": (a.get("excerpt", ""))[:150]})
                for art in d.get("articles", []):
                    all_content.append({"type": "文章", "title": art.get("title", ""),
                                        "votes": art.get("votes", 0),
                                        "excerpt": (art.get("excerpt", ""))[:150]})
                all_content.sort(key=lambda x: x["votes"], reverse=True)
                result["top_list"] = all_content[:10]
            except Exception:
                pass
    result["stdout_tail"] = stdout[-500:]
    return result


def _run_job(job_id, target, answers, top, reuse):
    """后台线程: 运行 main.py, 逐行更新进度。"""
    env = dict(os.environ)
    env["PYTHONIOENCODING"] = "utf-8"
    cmd = [sys.executable, str(BASE / "main.py"),
           target, "--answers", str(answers), "--top", str(top)]
    if reuse:
        cmd.append("--reuse-data")
    all_lines = []
    try:
        p = subprocess.Popen(
            cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
            text=True, encoding="utf-8", errors="replace",
            env=env, cwd=str(BASE),
        )
        for line in p.stdout:
            line = line.rstrip("\n\r")
            if not line.strip():
                continue
            all_lines.append(line)
            pct, phase = _parse_progress(line)
            with _job_lock:
                job = _jobs.get(job_id)
                if job:
                    if pct is not None:
                        job["progress"] = pct
                    if phase:
                        job["phase"] = phase
                    job["log"] = all_lines[-15:]
                    job["updated"] = time.time()
        p.wait()
        rc = p.returncode
        with _job_lock:
            job = _jobs.get(job_id)
            if job:
                stdout_full = "\n".join(all_lines)
                if rc == 0:
                    job["status"] = "done"
                    job["progress"] = 100
                    job["phase"] = "完成"
                    # 提取 token
                    token = ""
                    for ln in all_lines:
                        m = re.search(r"token=([^\s)]+)", ln)
                        if m:
                            token = m.group(1)
                    job["result"] = _extract_result(stdout_full, token)
                else:
                    job["status"] = "error"
                    job["error"] = "exit %d" % rc
                    job["log"] = all_lines[-15:]
    except Exception as e:
        with _job_lock:
            job = _jobs.get(job_id)
            if job:
                job["status"] = "error"
                job["error"] = str(e)
                job["log"] = all_lines[-15:]


# ---------------------------------------------------------------------------
# HTML 前端 (内嵌)
# ---------------------------------------------------------------------------
_FRONTEND_HTML = r"""<!DOCTYPE html>
<html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>知乎查成分</title>
<style>
:root{
  --bg:#f0f2f5; --card:#fff; --text:#1a1a2e; --text2:#555; --muted:#999;
  --brand:#0066ff; --brand-l:#3d8bff; --brand-d:#0052cc;
  --left:#e74c3c; --right:#3498db; --center:#bdc3c7;
  --ok:#27ae60; --warn:#e67e22; --err:#e74c3c;
  --radius:12px; --shadow:0 2px 12px rgba(0,0,0,.08); --shadow-lg:0 8px 32px rgba(0,0,0,.12);
}
*{box-sizing:border-box;margin:0;padding:0}
body{
  font-family:"Microsoft YaHei","Segoe UI",sans-serif;
  background:linear-gradient(135deg,#f0f2f5 0%,#e8ecf1 100%);
  color:var(--text); line-height:1.7; min-height:100vh; padding:32px 16px;
}
.wrap{max-width:720px;margin:0 auto}
h1{font-size:28px;font-weight:800;margin-bottom:6px;display:flex;align-items:center;gap:10px}
h1 .icon{font-size:32px}
.subtitle{color:var(--muted);font-size:14px;margin-bottom:24px}
.input-row{display:flex;gap:12px;margin-bottom:20px}
input{
  flex:1;padding:14px 18px;border:2px solid #e0e0e0;border-radius:var(--radius);
  font-size:15px;font-family:inherit;transition:border-color .2s,box-shadow .2s;outline:none;
}
input:focus{border-color:var(--brand);box-shadow:0 0 0 3px rgba(0,102,255,.12)}
button{
  padding:14px 32px;border:none;border-radius:var(--radius);
  background:var(--brand);color:#fff;font-size:15px;font-weight:700;cursor:pointer;
  font-family:inherit;transition:all .2s;white-space:nowrap;
}
button:hover:not(:disabled){background:var(--brand-d);transform:translateY(-1px);box-shadow:0 4px 12px rgba(0,102,255,.3)}
button:active:not(:disabled){transform:translateY(0)}
button:disabled{background:#b0b8c4;cursor:not-allowed}
button .spinner{display:inline-block;width:14px;height:14px;border:2px solid rgba(255,255,255,.3);border-top-color:#fff;border-radius:50%;animation:spin .6s linear infinite;margin-right:8px;vertical-align:-2px}
@keyframes spin{to{transform:rotate(360deg)}}
.card{
  background:var(--card);border-radius:var(--radius);padding:24px;margin:16px 0;
  box-shadow:var(--shadow);transition:box-shadow .3s;
  animation:cardIn .4s cubic-bezier(.4,0,.2,1);
}
@keyframes cardIn{from{opacity:0;transform:translateY(12px)}to{opacity:1;transform:translateY(0)}}
.card:hover{box-shadow:var(--shadow-lg)}
.progress-bar{height:28px;background:#e8ecf1;border-radius:14px;overflow:hidden;position:relative;margin:12px 0}
.progress-fill{
  height:100%;background:linear-gradient(90deg,var(--brand) 0%,var(--brand-l) 50%,var(--brand) 100%);
  background-size:200% 100%;animation:shimmer 2s linear infinite;
  transition:width .6s cubic-bezier(.4,0,.2,1);border-radius:14px;
  box-shadow:0 0 12px rgba(0,102,255,.4);
}
@keyframes shimmer{0%{background-position:0% 0}100%{background-position:-200% 0}}
.progress-text{position:absolute;top:0;left:0;right:0;text-align:center;line-height:28px;font-size:13px;color:#333;font-weight:700;text-shadow:0 1px 2px rgba(255,255,255,.5)}
.phase{font-size:17px;font-weight:700;margin:10px 0;display:flex;align-items:center;gap:8px}
.phase::before{content:'';width:8px;height:8px;border-radius:50%;background:var(--brand);animation:pulse 1.2s infinite}
@keyframes pulse{0%,100%{opacity:1;transform:scale(1);box-shadow:0 0 0 0 rgba(0,102,255,.4)}50%{opacity:.6;transform:scale(1.4);box-shadow:0 0 0 6px rgba(0,102,255,0)}}
.steps{display:flex;gap:4px;margin:14px 0 10px}
.step{flex:1;height:4px;border-radius:2px;background:#e0e0e0;transition:background .4s}
.step.active{background:var(--brand)}
.step.done{background:var(--ok)}
.log{
  background:#1a1b2e;color:#a8b2d1;font-family:"Cascadia Code","Consolas",monospace;
  font-size:12px;padding:14px;border-radius:10px;max-height:220px;overflow-y:auto;margin:10px 0;
  border:1px solid rgba(255,255,255,.05);
}
.log div{margin:3px 0;white-space:pre-wrap;word-break:break-all;animation:fadeIn .3s ease}
.log div:last-child{color:#7dc4ff;font-weight:600}
@keyframes fadeIn{from{opacity:0;transform:translateY(-4px)}to{opacity:1;transform:translateY(0)}}
.log::-webkit-scrollbar{width:6px}
.log::-webkit-scrollbar-track{background:transparent}
.log::-webkit-scrollbar-thumb{background:rgba(255,255,255,.15);border-radius:3px}
.score-row{display:flex;align-items:center;gap:14px;margin:12px 0}
.score-label{font-weight:700;width:60px;font-size:15px}
.score-bar{flex:1;height:22px;background:linear-gradient(to right,var(--left),var(--center) 45%,var(--center) 55%,var(--right));border-radius:11px;position:relative;box-shadow:inset 0 1px 3px rgba(0,0,0,.1)}
.score-mid{position:absolute;left:50%;top:0;bottom:0;width:2px;background:rgba(0,0,0,.3);transform:translateX(-50%)}
.score-thumb{
  position:absolute;top:-3px;width:18px;height:18px;border-radius:50%;
  border:3px solid #fff;box-shadow:0 2px 6px rgba(0,0,0,.25);
  transform:translateX(-50%);transition:left .5s cubic-bezier(.4,0,.2,1);
}
.score-val{font-weight:800;width:110px;text-align:right;font-size:14px}
.summary{
  padding:16px 18px;background:linear-gradient(135deg,#f8f9ff,#f0f4ff);
  border-radius:10px;margin:10px 0;font-size:14px;border-left:4px solid var(--brand);
}
.summary b{display:block;margin-bottom:6px;font-size:15px}
.kw{display:flex;flex-wrap:wrap;gap:8px;margin:10px 0}
.kw span{background:linear-gradient(135deg,#eef4ff,#e0ecff);border:1px solid #c8dcff;border-radius:14px;padding:5px 14px;font-size:13px;color:#4a6fa5;font-weight:500}
.badge{display:inline-block;padding:4px 14px;border-radius:14px;font-size:13px;font-weight:700}
.b-yes{background:#e8f8ee;color:#1b7a3e}.b-no{background:#f5f5f5;color:#666;border:1px solid #e0e0e0}.b-unk{background:#fff5e6;color:#c97000}
.err{color:var(--err);font-weight:600}
a{color:var(--brand);text-decoration:none;font-weight:500}
a:hover{text-decoration:underline}
.hidden{display:none!important}
.modal-overlay{position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,.4);z-index:1000;display:flex;align-items:center;justify-content:center;animation:fadeIn .2s}
.modal{background:#fff;border-radius:16px;padding:28px;max-width:500px;width:90%;max-height:80vh;overflow-y:auto;box-shadow:0 20px 60px rgba(0,0,0,.2)}
.modal h2{font-size:20px;margin-bottom:16px}
.modal label{display:block;font-weight:600;font-size:13px;margin:10px 0 4px;color:var(--text2)}
.modal input,.modal select{width:100%;padding:10px 12px;border:1px solid #ddd;border-radius:8px;font-size:14px;font-family:inherit;margin-bottom:4px}
.modal .row{display:flex;gap:10px}
.modal .row>div{flex:1}
.modal .actions{display:flex;gap:10px;margin-top:20px;justify-content:flex-end}
.modal .actions button{padding:10px 20px}
.btn-secondary{background:#e0e4ea;color:#555}
.btn-secondary:hover{background:#d0d4da}
.test-result{margin-top:8px;padding:8px 12px;border-radius:8px;font-size:13px}
.test-ok{background:#e8f8ee;color:#1b7a3e}
.test-err{background:#fde8e8;color:#c0392b}
.footer{text-align:center;margin-top:32px;padding:16px;color:var(--muted);font-size:12px;line-height:1.8}
.footer a{color:var(--muted);font-weight:400}
@media(max-width:600px){
  body{padding:16px 10px}
  .wrap{max-width:100%}
  h1{font-size:22px}
  .subtitle{font-size:13px}
  .input-row{flex-direction:column}
  .input-row button{width:100%}
  .card{padding:18px 16px}
  .score-row{flex-wrap:wrap;gap:8px}
  .score-label{width:100%}
  .score-bar{width:100%;order:2}
  .score-val{width:100%;text-align:left;order:3}
}
</style></head><body>
<div class="wrap">
<h1><span class="icon">🔍</span> 知乎查成分</h1>
<p class="subtitle">输入知乎用户主页地址，AI 自动采集回答并分析政治 / 经济 / 文化三维倾向</p>
<div class="input-row">
  <input id="target" placeholder="输入知乎用户 URL 或 url_token，如 62-32-1-7" />
  <button id="btn" onclick="start()">开始分析</button>
  <button id="settings-btn" onclick="openSettings()" style="background:#6c7a89;padding:14px 18px">⚙</button>
</div>

<div id="progress-card" class="card hidden">
  <div class="phase" id="phase">准备中...</div>
  <div class="steps" id="steps">
    <div class="step" data-min="10"></div>
    <div class="step" data-min="30"></div>
    <div class="step" data-min="50"></div>
    <div class="step" data-min="65"></div>
    <div class="step" data-min="82"></div>
    <div class="step" data-min="100"></div>
  </div>
  <div class="progress-bar"><div class="progress-fill" id="pfill" style="width:0%"></div><div class="progress-text" id="ptext">0%</div></div>
  <div class="log" id="log"></div>
</div>

<div id="result-card" class="card hidden"></div>
<div class="footer">
  知乎查成分 · 基于 BrowserSkill + jieba + LLM · 倾向分数为 AI 估计，仅供参考<br>
  请勿用于人身攻击或网络暴力
</div>
</div>

<div id="settings-modal" class="modal-overlay hidden" onclick="if(event.target===this)closeSettings()">
  <div class="modal">
    <h2>⚙ LLM 设置</h2>
    <label>厂商</label>
    <select id="cfg-provider" onchange="onProviderChange()"></select>
    <label>API 规范</label>
    <select id="cfg-api"><option value="openai">OpenAI 兼容</option><option value="anthropic">Anthropic</option></select>
    <label>Base URL</label>
    <input id="cfg-baseurl" placeholder="https://api.example.com/v1" />
    <label>API Key</label>
    <input id="cfg-apikey" type="password" placeholder="sk-..." />
    <label>模型名</label>
    <input id="cfg-model" placeholder="模型名, 如 deepseek-chat" />
    <div id="test-result" class="test-result hidden"></div>
    <div class="actions">
      <button class="btn-secondary" onclick="closeSettings()">取消</button>
      <button class="btn-secondary" onclick="testLLM()">测试连接</button>
      <button onclick="saveConfig()">保存</button>
    </div>
  </div>
</div>

<script>
var jobTimer = null;
var params = new URLSearchParams(location.search);
if (params.get('target')) document.getElementById('target').value = params.get('target');
document.getElementById('target').addEventListener('keydown', function(e) {
  if (e.key === 'Enter') start();
});

function start() {
  var target = document.getElementById('target').value.trim();
  if (!target) { alert('请输入目标用户'); return; }
  var btn = document.getElementById('btn');
  btn.disabled = true; btn.innerHTML = '<span class="spinner"></span>分析中';
  document.getElementById('progress-card').classList.remove('hidden');
  document.getElementById('result-card').classList.add('hidden');
  document.getElementById('log').innerHTML = '';
  setProgress(0, '启动中...');
  fetch('/analyze', {method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({target: target, answers: 600, top: 1})})
    .then(function(r){return r.json();})
    .then(function(d){
      if (d.ok) { poll(d.job_id); }
      else { showError(d.error || '启动失败'); }
    })
    .catch(function(e){ showError('请求失败: ' + e); });
}

function poll(jobId) {
  var lastLogLen = 0;
  jobTimer = setInterval(function(){
    fetch('/progress?id=' + jobId)
      .then(function(r){return r.json();})
      .then(function(d){
        setProgress(d.progress || 0, d.phase || '');
        if (d.log && d.log.length > lastLogLen) {
          var logEl = document.getElementById('log');
          for (var i = lastLogLen; i < d.log.length; i++) {
            var div = document.createElement('div');
            div.textContent = d.log[i];
            logEl.appendChild(div);
          }
          lastLogLen = d.log.length;
          logEl.scrollTop = logEl.scrollHeight;
        }
        if (d.status === 'done') {
          clearInterval(jobTimer);
          showResult(d.result || {});
          var btn = document.getElementById('btn');
          btn.disabled = false; btn.textContent = '再次分析';
        } else if (d.status === 'error') {
          clearInterval(jobTimer);
          showError(d.error || '分析失败');
          var btn = document.getElementById('btn');
          btn.disabled = false; btn.textContent = '重新分析';
        }
      })
      .catch(function(e){});
  }, 1500);
}

function setProgress(pct, phase) {
  document.getElementById('pfill').style.width = pct + '%';
  document.getElementById('ptext').textContent = pct + '%';
  if (phase) document.getElementById('phase').textContent = phase;
  var steps = document.querySelectorAll('.step');
  steps.forEach(function(s) {
    var min = parseInt(s.dataset.min);
    s.classList.toggle('done', pct >= 100);
    s.classList.toggle('active', pct >= min && pct < 100);
  });
}

function showResult(r) {
  var html = '<div style="text-align:center;margin-bottom:20px"><div style="font-size:48px">✅</div><h2 style="margin-top:8px">分析完成</h2></div>';
  // 用户信息
  var p = r.profile || {};
  if (p.name) {
    html += '<div class="summary" style="border-left-color:var(--brand)"><b>👤 ' + esc(p.name || '') + '</b>';
    if (p.headline) html += '<br><span style="color:#666">' + esc(p.headline) + '</span>';
    html += '<br><span style="font-size:12px;color:#888">回答 ' + (p.answerCount || 0) + ' · 粉丝 ' + (p.follower || 0);
    if (p.ip) html += ' · IP:' + esc(p.ip);
    html += '</span></div>';
  }
  // 概括
  if (r.summary) {
    html += '<div class="summary"><b>📋 详细分析</b>' + esc(r.summary) + '</div>';
  }
  // 三维倾向
  if (r.scores) {
    html += '<div style="margin:20px 0 8px;font-weight:700;font-size:16px">📊 三维度倾向</div>';
    html += '<div style="display:flex;justify-content:space-between;font-size:11px;color:var(--muted);margin:0 60px 0 74px;padding:0 110px 0 0"><span>← 左</span><span>中间</span><span>右 →</span></div>';
    var dims = [['political','政治'],['economic','经济'],['cultural','文化']];
    for (var i = 0; i < dims.length; i++) {
      var key = dims[i][0], name = dims[i][1];
      var s = r.scores[key] || {score:0, label:'中间'};
      var left = (s.score + 100) / 200 * 100;
      var color = s.score <= -20 ? 'var(--left)' : s.score >= 20 ? 'var(--right)' : 'var(--center)';
      html += '<div class="score-row"><span class="score-label">' + name + '</span>'
        + '<div class="score-bar"><div class="score-mid"></div>'
        + '<div class="score-thumb" style="left:' + left + '%;background:' + color + '"></div></div>'
        + '<span class="score-val" style="color:' + color + '">' + (s.score > 0 ? '+' : '') + s.score + ' ' + esc(s.label) + '</span></div>';
    }
  }
  // 高赞内容 Top 10
  var tl = r.top_list || [];
  if (tl.length > 0) {
    html += '<div style="margin:20px 0 8px;font-weight:700;font-size:16px">📝 高赞内容 Top ' + tl.length + '</div>';
    html += '<table style="width:100%;border-collapse:collapse;font-size:13px"><tr style="color:#888;font-size:12px"><th style="text-align:left;padding:6px">#</th><th style="text-align:left;padding:6px">类型</th><th style="text-align:left;padding:6px">赞</th><th style="text-align:left;padding:6px">标题</th></tr>';
    for (var j = 0; j < tl.length; j++) {
      var a = tl[j];
      var bg = j % 2 ? '#f9f9f9' : '#fff';
      html += '<tr style="background:' + bg + '"><td style="padding:6px">' + (j+1) + '</td><td style="padding:6px">' + esc(a.type||'') + '</td><td style="padding:6px">' + (a.votes||0) + '</td><td style="padding:6px">' + esc(a.title||'') + '</td></tr>';
    }
    html += '</table>';
  }
  // 双向关注关系
  var f = r.follow || {};
  if (f.forward || f.reverse || f.status) {
    var fwd = f.forward || f.status || 'unknown';
    var rev = f.reverse || 'unknown';
    var fmap = {'yes':['b-yes','已关注'],'no':['b-no','未关注'],'unknown':['b-unk','无法确认']};
    var fb = fmap[fwd] || fmap['unknown'];
    var rb = fmap[rev] || fmap['unknown'];
    html += '<div style="margin:16px 0;padding:12px;background:#f9f9f9;border-radius:10px">';
    html += '<div style="font-weight:600;margin-bottom:8px">🔗 子夜极光关注关系</div>';
    html += '<div style="margin:4px 0">子夜极光 → 该用户: <span class="badge ' + fb[0] + '">' + fb[1] + '</span></div>';
    html += '<div style="margin:4px 0">该用户 → 子夜极光: <span class="badge ' + rb[0] + '">' + rb[1] + '</span></div>';
    html += '</div>';
  }
  // 报告链接
  if (r.report_url) {
    var token = r.report_url.match(/report_([^.]+)\.html/);
    var href = token ? ('/report?path=' + token[1]) : r.report_url;
    html += '<a href="' + esc(href) + '" target="_blank" style="display:block;text-align:center;margin:20px 0;padding:16px;background:linear-gradient(135deg,var(--brand),var(--brand-l));color:#fff;border-radius:var(--radius);font-size:17px;font-weight:700;text-decoration:none;transition:all .2s;box-shadow:0 4px 16px rgba(0,102,255,.3)" onmouseover="this.style.transform=\'translateY(-2px)\';this.style.boxShadow=\'0 6px 20px rgba(0,102,255,.4)\'" onmouseout="this.style.transform=\'translateY(0)\';this.style.boxShadow=\'0 4px 16px rgba(0,102,255,.3)\'">📄 点击查看完整报告</a>';
  }
  if (r.stdout_tail) {
    html += '<details style="margin-top:12px"><summary style="cursor:pointer;color:var(--muted);font-size:13px;padding:8px 0">📋 运行日志</summary><div class="log" style="margin-top:8px">' + esc(r.stdout_tail) + '</div></details>';
  }
  document.getElementById('result-card').innerHTML = html;
  document.getElementById('result-card').classList.remove('hidden');
  document.getElementById('result-card').scrollIntoView({behavior:'smooth',block:'nearest'});
}

function showError(msg) {
  document.getElementById('result-card').innerHTML = 
    '<div style="text-align:center;margin-bottom:16px"><div style="font-size:48px">❌</div></div>'
    + '<p class="err" style="text-align:center;font-size:16px;margin-bottom:12px">' + esc(msg) + '</p>'
    + '<p style="text-align:center;color:var(--muted);font-size:13px">请检查 run.bat 窗口的输出或确认浏览器已登录知乎</p>';
  document.getElementById('result-card').classList.remove('hidden');
  document.getElementById('result-card').scrollIntoView({behavior:'smooth',block:'nearest'});
}

function esc(s) {
  return String(s).replace(/&/g,'&'+'amp;').replace(/</g,'&'+'lt;').replace(/>/g,'&'+'gt;');
}

var _cfgProviders = {};
var _cfgCurrent = '';

function openSettings() {
  document.getElementById('settings-modal').classList.remove('hidden');
  fetch('/config').then(function(r){return r.json();}).then(function(d){
    _cfgProviders = d.providers || {};
    _cfgCurrent = d.provider || '';
    var sel = document.getElementById('cfg-provider');
    sel.innerHTML = '';
    Object.keys(_cfgProviders).forEach(function(k){
      var p = _cfgProviders[k];
      var opt = document.createElement('option');
      opt.value = k; opt.textContent = p.name || k;
      if (k === _cfgCurrent) opt.selected = true;
      sel.appendChild(opt);
    });
    onProviderChange();
  });
}

function closeSettings() {
  document.getElementById('settings-modal').classList.add('hidden');
  document.getElementById('test-result').classList.add('hidden');
}

function onProviderChange() {
  var key = document.getElementById('cfg-provider').value;
  var p = _cfgProviders[key] || {};
  document.getElementById('cfg-api').value = p.api || 'openai';
  document.getElementById('cfg-baseurl').value = p.base_url || '';
  document.getElementById('cfg-apikey').value = '';
  document.getElementById('cfg-apikey').placeholder = p.has_key ? ('已配置 (' + (p.api_key || '') + ')') : 'sk-...';
  document.getElementById('cfg-model').value = p.model || '';
}

function testLLM() {
  var key = document.getElementById('cfg-provider').value;
  var data = {
    provider: key,
    provider_data: {
      api: document.getElementById('cfg-api').value,
      base_url: document.getElementById('cfg-baseurl').value,
      model: document.getElementById('cfg-model').value
    }
  };
  var ak = document.getElementById('cfg-apikey').value;
  if (ak) data.provider_data.api_key = ak;
  var el = document.getElementById('test-result');
  el.className = 'test-result'; el.textContent = '测试中...'; el.classList.remove('hidden');
  fetch('/test-llm', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(data)})
    .then(function(r){return r.json();})
    .then(function(d){
      el.className = 'test-result ' + (d.ok ? 'test-ok' : 'test-err');
      el.textContent = (d.ok ? '✅ ' : '❌ ') + (d.message || '');
    })
    .catch(function(e){
      el.className = 'test-result test-err';
      el.textContent = '❌ 请求失败: ' + e;
    });
}

function saveConfig() {
  var key = document.getElementById('cfg-provider').value;
  var data = {
    provider: key,
    provider_key: key,
    provider_data: {
      api: document.getElementById('cfg-api').value,
      base_url: document.getElementById('cfg-baseurl').value,
      model: document.getElementById('cfg-model').value
    }
  };
  var ak = document.getElementById('cfg-apikey').value;
  if (ak) data.provider_data.api_key = ak;
  fetch('/config', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(data)})
    .then(function(r){return r.json();})
    .then(function(d){
      if (d.ok) { closeSettings(); }
      else { alert('保存失败: ' + (d.error || '')); }
    })
    .catch(function(e){ alert('保存失败: ' + e); });
}
</script>
</body></html>"""


# ---------------------------------------------------------------------------
# Config helpers (供 HTTP handler 使用)
# ---------------------------------------------------------------------------
def _load_cfg():
    sys.path.insert(0, str(BASE))
    from _llm import load_config
    return load_config()


def _save_cfg(cfg):
    sys.path.insert(0, str(BASE))
    from _llm import save_config
    save_config(cfg)


def _test_llm(cfg):
    sys.path.insert(0, str(BASE))
    from _llm import test_connection
    return test_connection(cfg)


# ---------------------------------------------------------------------------
# HTTP Handler
# ---------------------------------------------------------------------------
class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        pass

    def _send(self, code, obj, content_type="application/json"):
        if isinstance(obj, str):
            body = obj.encode("utf-8")
        else:
            body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", content_type + "; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "POST, GET, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()
        try:
            self.wfile.write(body)
        except (ConnectionAbortedError, BrokenPipeError, ConnectionResetError):
            pass

    def do_OPTIONS(self):
        self._send(200, {"ok": True})

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        if path == "/" or path == "/index.html":
            self._send(200, _FRONTEND_HTML, "text/html")
        elif path == "/ping":
            self._send(200, {"ok": True, "service": "who_are_you"})
        elif path == "/progress":
            qs = urllib.parse.parse_qs(parsed.query)
            job_id = (qs.get("id") or [""])[0]
            with _job_lock:
                job = _jobs.get(job_id)
                if not job:
                    self._send(404, {"ok": False, "error": "job not found"})
                    return
                self._send(200, dict(job))
        elif path == "/config":
            cfg = _load_cfg()
            # 打码 api_key
            providers = {}
            for k, v in cfg.get("providers", {}).items():
                v2 = dict(v)
                ak = v2.get("api_key", "")
                if ak and len(ak) > 8:
                    v2["api_key"] = ak[:4] + "***" + ak[-4:]
                else:
                    v2["api_key"] = "***" if ak else ""
                v2["has_key"] = bool(ak)
                providers[k] = v2
            self._send(200, {"ok": True, "provider": cfg.get("provider", ""), "providers": providers})
        elif path == "/report":
            qs = urllib.parse.parse_qs(parsed.query)
            token = (qs.get("path") or [""])[0]
            if not token:
                self._send(400, {"ok": False, "error": "missing path"})
                return
            report_file = BASE / ("report_%s.html" % token)
            if not report_file.exists():
                self._send(404, {"ok": False, "error": "report not found"})
                return
            self._send(200, report_file.read_text(encoding="utf-8"), "text/html")
        else:
            self._send(404, {"ok": False, "error": "not found"})

    def do_POST(self):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path == "/analyze":
            self._handle_analyze()
        elif parsed.path == "/config":
            self._handle_save_config()
        elif parsed.path == "/test-llm":
            self._handle_test_llm()
        else:
            self._send(404, {"ok": False, "error": "not found"})

    def _handle_analyze(self):
        try:
            length = int(self.headers.get("Content-Length", 0))
            raw = self.rfile.read(length)
            data = json.loads(raw.decode("utf-8"))
        except Exception as e:
            self._send(400, {"ok": False, "error": "bad request: %s" % e})
            return
        target = (data.get("target") or "").strip()
        if not target:
            self._send(400, {"ok": False, "error": "missing target"})
            return
        answers = int(data.get("answers", 600))
        top = int(data.get("top", 1))
        reuse = bool(data.get("reuse", False))
        job_id = "job_%d" % int(time.time() * 1000)
        with _job_lock:
            _jobs[job_id] = {
                "status": "running", "progress": 0, "phase": "启动中...",
                "log": [], "result": None, "updated": time.time(),
            }
        t = threading.Thread(target=_run_job, args=(job_id, target, answers, top, reuse), daemon=True)
        t.start()
        self._send(200, {"ok": True, "job_id": job_id})

    def _handle_save_config(self):
        try:
            length = int(self.headers.get("Content-Length", 0))
            raw = self.rfile.read(length)
            data = json.loads(raw.decode("utf-8"))
        except Exception as e:
            self._send(400, {"ok": False, "error": "bad request: %s" % e})
            return
        cfg = _load_cfg()
        provider = data.get("provider", cfg.get("provider", ""))
        providers = cfg.get("providers", {})
        # 更新指定 provider 的字段
        upd = data.get("provider_data", {})
        if upd:
            key = data.get("provider_key", provider)
            pc = providers.get(key, {})
            pc.update({k: v for k, v in upd.items() if v is not None})
            providers[key] = pc
        cfg["provider"] = provider
        cfg["providers"] = providers
        _save_cfg(cfg)
        self._send(200, {"ok": True})

    def _handle_test_llm(self):
        try:
            length = int(self.headers.get("Content-Length", 0))
            raw = self.rfile.read(length)
            data = json.loads(raw.decode("utf-8"))
        except Exception as e:
            self._send(400, {"ok": False, "error": "bad request: %s" % e})
            return
        cfg = _load_cfg()
        # 允许前端临时传入 provider_data 覆盖
        if data.get("provider"):
            cfg["provider"] = data["provider"]
        upd = data.get("provider_data")
        if upd:
            key = data.get("provider", cfg.get("provider", ""))
            cfg.setdefault("providers", {}).setdefault(key, {}).update(upd)
        ok, msg = _test_llm(cfg)
        self._send(200, {"ok": ok, "message": msg})


def main():
    server = http.server.HTTPServer(("127.0.0.1", PORT), Handler)
    print("who_are_you 服务已启动: http://127.0.0.1:%d" % PORT)
    print("在浏览器里打开此地址即可使用, 或在知乎主页点油猴脚本的按钮。")
    print("按 Ctrl+C 停止")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n已停止")
        server.shutdown()


if __name__ == "__main__":
    main()
