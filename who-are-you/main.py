# -*- coding: utf-8 -*-
"""who_are_you — 知乎"查成分"工具。

用法:
    python main.py <用户主页URL或url_token> [--answers 600] [--top 1]
                   [--no-llm] [--reuse-data] [--out report.html]

依赖: jieba, wordcloud, requests。采集通过 BrowserSkill(bsk) 驱动已登录的
Edge 浏览器, 需要先在 Edge 里登录知乎并启动 bsk daemon。
"""
import argparse
import base64
import io
import json
import os
import re
import subprocess
import sys
import time
from collections import Counter
from datetime import datetime
from pathlib import Path

BASE = Path(__file__).resolve().parent
# 优先使用本地 libs 目录的依赖 (pip install --target), 避免装到 C 盘
_LIBS = BASE / "libs"
if _LIBS.exists():
    sys.path.insert(0, str(_LIBS))
FONT_PATH = r"C:\Windows\Fonts\msyh.ttc"

# ---------------------------------------------------------------------------
# 词性过滤白名单 + 停用词表
# ---------------------------------------------------------------------------
ALLOW_POS = ("n", "nr", "ns", "nt", "nz", "v", "vn", "a", "ad", "an", "b", "eng")

# 通用高频泛动词/泛名词——词性过滤拦不住, 单独排除
_STOP_GENERIC = """进行 出现 成为 表示 觉得 认为 觉 觉得 认为 希望 需要 开始 直接
真的 感觉 看到 看到 回答 问题 事情 时候 东西 方面 情况 现象 地方 部分 内容 原因
结果 方式 方法 可能 应该 这样 那样 其实 也就是说 也就是 比如 诸如 甚至 到底
反正 无论 不管 虽然 但是 可是 不过 因此 所以 然后 而且 或者 还是 就是 只是
已经 一直 以前 以后 一下 一些 一样 一直 似乎 好像 大概 基本 也许
时候 时间 现在 以前 以后 今天 昨天 明天 以前 现在开始 终于 最后 首先 其次
我们 你们 他们 大家 别人 自己 本人 个人 其实 大家 觉得 认为 发现 认为
知道 了解 明白 清楚 觉得 感觉 看到 听到 认为 说明 表示 指出 强调 认为
他们 我们 你们 自己 别人 大家 有人 人们 某些 一些 许多 很多 大多 少数
"""  # noqa: E501

# 知乎页面残留 / 平台噪声词
_STOP_ZHIHU = """知乎 回答 编辑 赞同 发布 关注 收藏 显示 来自 提问 私信 登录 注册
评论 举报 分享 查看更多 阅读全文 展开 收起 赞同了 添加评论 写回答 关注问题
被浏览 浏览 邀请回答 关注者 关注 内容来源 著作权 归作者 限制 转载 联系
图片 视频 链接 网页 文章 专栏 想法 动态 个人主页 首页 下载 app"""

STOPWORDS = frozenset(
    w for s in (_STOP_GENERIC, _STOP_ZHIHU) for w in s.split() if w.strip()
)

# ---------------------------------------------------------------------------
# 配置
# ---------------------------------------------------------------------------
DEFAULT_CONFIG = {
    "provider": "ustc",
    "providers": {},
    "temperature": 0.3,
    "timeout": 120,
    "max_tokens": 1000,
    "bsk_path": "",
    "bsk_home": "",
    "feature_token": "",
    "scroll_pause_ms": 1500,
}


def load_config():
    p = BASE / "config.json"
    if not p.exists():
        return dict(DEFAULT_CONFIG)
    try:
        data = json.loads(p.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        data = {}
    merged = dict(DEFAULT_CONFIG)
    merged.update({k: v for k, v in data.items() if not k.startswith("_")})
    return merged


# ---------------------------------------------------------------------------
# BrowserSkill CLI 封装
# ---------------------------------------------------------------------------
_BSK_BANNER = re.compile(r"A new bsk version", re.I)


def bsk(cfg, *args, timeout=180):
    """调用 bsk.exe, 返回 (rc, cleaned_output)。过滤版本横幅。"""
    env = dict(os.environ)
    env["BSK_HOME"] = cfg.get("bsk_home", "")
    exe = cfg.get("bsk_path", "")
    try:
        p = subprocess.run(
            [exe, "--quiet", *args],
            capture_output=True, text=True,
            encoding="utf-8", errors="replace",
            timeout=timeout, env=env,
        )
    except subprocess.TimeoutExpired:
        return 124, ""
    raw = (p.stdout or "")
    lines = [ln for ln in raw.splitlines()
             if ln.strip() and not _BSK_BANNER.search(ln)]
    return p.returncode, "\n".join(lines).strip()


def bsk_eval(cfg, sid, expr, timeout=60):
    """执行 JS 并解析返回的 JSON 值。"""
    rc, out = bsk(cfg, "evaluate", "--session", sid, "--quiet", expr, timeout=timeout)
    if rc != 0:
        return None
    s = out.find("{")
    e = out.rfind("}")
    if s < 0 or e <= s:
        return None
    try:
        return json.loads(out[s:e + 1])
    except ValueError:
        return None


def bsk_nav(cfg, sid, url, wait="load", timeout="45s"):
    """导航, 失败重试一次。"""
    for _ in range(2):
        rc, out = bsk(cfg, "navigate", "--session", sid, "--wait-until", wait,
                      "--timeout", timeout, url, timeout=60)
        if rc == 0:
            return True
        time.sleep(1.5)
    return False


def bsk_snapshot_refs(cfg, sid, kind="searchbox"):
    """从 snapshot 里提取匹配 kind 的 @eN ref 列表。"""
    rc, out = bsk(cfg, "snapshot", "--session", sid, "--quiet", timeout=60)
    if rc != 0:
        return []
    pat = re.compile(r"@e(\d+)\s+%s" % re.escape(kind), re.I)
    return ["@e" + m.group(1) for m in pat.finditer(out)]


def session_start(cfg):
    """启动会话, 返回 session_id。"""
    for _ in range(3):
        rc, out = bsk(cfg, "session", "start", "--no-focus", timeout=30)
        if rc == 0:
            sid = out.splitlines()[-1].strip() if out else ""
            if sid and re.fullmatch(r"[a-z0-9]+", sid):
                return sid
        time.sleep(1.5)
    raise RuntimeError(
        "没有浏览器连接到 bsk 守护进程, 无法启动会话。\n"
        "请重新双击 run.bat (它会先关闭 Edge 并带 BrowserSkill 扩展重启),\n"
        "并在 Edge 弹出'关闭开发人员模式下的扩展'提示时点'以后再说'。"
    )


def session_stop(cfg, sid):
    bsk(cfg, "session", "stop", sid, timeout=15)


# ---------------------------------------------------------------------------
# 采集层: 在知乎页面里执行 JS 读取数据
# ---------------------------------------------------------------------------
def parse_token(arg):
    """从主页 URL 或纯 token 提取 url_token。"""
    arg = arg.strip().strip("/")
    m = re.search(r"zhihu\.com/people/([^/?#]+)", arg)
    if m:
        return m.group(1)
    return arg


PROFILE_JS = r"""(function(){
  function txt(s){return (s||'').trim();}
  var root=null;
  try{root=JSON.parse(document.getElementById('js-initialData').textContent);}catch(e){}
  var pe=root && root.initialState && root.initialState.entities && root.initialState.entities.users;
  var keys=pe?Object.keys(pe):[];
  var u=keys.length?pe[keys[keys.length-1]]:{};
  var name=txt(u.name)||txt(document.querySelector('.ProfileHeader-name'));
  var headline=txt(u.headline)||txt(document.querySelector('.ProfileHeader-headline'));
  var desc=txt(u.description)||txt(document.querySelector('.ProfileHeader-description'));
  var gender=u.gender;
  if(gender===1)gender='男';else if(gender===0)gender='女';else gender='未知';
  var ip=txt(u.ipInfo||u.ipLocation)||'';
  var biz=u.employments&&u.employments[0]?txt(u.employments[0].company||u.employments[0].business&&u.employments[0].business.name):'';
  var follower=parseInt(u.followerCount||0,10)||0;
  var answerCnt=parseInt(u.answerCount||0,10)||0;
  var loggedIn=!!(document.querySelector('[aria-label*="通知"]')
    ||document.querySelector('.AppHeader-messages')
    ||document.querySelector('.AppHeader-userInfo')
    ||document.cookie.match(/z_c0/));
  return JSON.stringify({
    loggedIn: loggedIn, name: name, headline: headline, description: desc,
    gender: gender, ip: ip, business: biz, follower: follower, answerCount: answerCnt
  });
})()"""

ANSWERS_JS = r"""(function(){
  var items=[];
  document.querySelectorAll('.List-item').forEach(function(el){
    try{
      var qEl=el.querySelector('.ContentItem-title a')||el.querySelector('h2 a');
      var title=el.querySelector('.ContentItem-title')?el.querySelector('.ContentItem-title').textContent.trim():'';
      var zan=0;
      var btn=el.querySelector('.VoteButton--up');
      if(btn){var m=btn.getAttribute('aria-label')||btn.textContent||'';var mm=m.match(/[\d,万]+/);if(mm){var s=mm[0];if(s.indexOf('万')>=0){zan=Math.round(parseFloat(s)*10000);}else{zan=parseInt(s.replace(/,/g,''),10)||0;}}}
      var excerpt=el.querySelector('.RichContent-inner')?el.querySelector('.RichContent-inner').textContent.trim():'';
      var time=el.querySelector('.ContentItem-time')?el.querySelector('.ContentItem-time').textContent.trim():'';
      var qhref=qEl?qEl.href:'';
      var qid='';
      if(qhref){var m=qhref.match(/question\/(\d+)/);if(m)qid=m[1];}
      var aEl=el.querySelector('[data-zop]');
      var aid='';
      if(aEl){var zop=JSON.parse(aEl.getAttribute('data-zop')||'{}');aid=zop.itemId||'';}
      var id=qid+'_'+aid;
      if(qid&&aid){items.push({id:id,qid:qid,aid:aid,title:title,votes:zan,excerpt:excerpt.substring(0,600),time:time,href:qhref});}
    }catch(e){}
  });
  return JSON.stringify(items);
})()"""

ANSWER_FULL_JS = r"""(function(){
  var root=null;
  try{root=JSON.parse(document.getElementById('js-initialData').textContent);}catch(e){}
  var ans=root&&root.initialState&&root.initialState.entities&&root.initialState.entities.answers;
  if(ans){
    var ks=Object.keys(ans);
    if(ks.length){var a=ans[ks[0]];
      var c=a.content||'';
      var txt2=c.replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim();
      return JSON.stringify({ok:true,content:txt2.substring(0,8000)});}}
  var el=document.querySelector('.RichContent-inner')||document.querySelector('.Post-RichContent');
  if(el){var t=el.textContent.replace(/\s+/g,' ').trim();return JSON.stringify({ok:true,content:t.substring(0,8000)});}
  return JSON.stringify({ok:false,content:''});
})()"""

FOLLOW_JS = r"""(function(){
  var rows=document.querySelectorAll('.List .List-item, .FollowersList .List-item');
  var found=[];
  rows.forEach(function(r){
    var a=r.querySelector('a[data-za-detail-view-element-name]')||r.querySelector('a.UserLink')||r.querySelector('h2 a')||r.querySelector('a[href*="/people/"]');
    if(a){
      var href=a.href||'';var m=href.match(/people\/([^/?#]+)/);
      var name=(a.textContent||'').trim();
      if(m)found.push({token:m[1],name:name});}
  });
  return JSON.stringify({rows:rows.length,found:found});
})()"""


LOGIN_CHECK_JS = r"""(function(){
  var isLogin=!!(document.querySelector('[aria-label*="通知"]')
    ||document.querySelector('.AppHeader-messages')
    ||document.querySelector('.AppHeader-userInfo')
    ||document.cookie.match(/z_c0/));
  return JSON.stringify({loggedIn:isLogin, url:location.href});
})()"""


def wait_for_login(cfg, sid, timeout=300):
    """导航到知乎登录页, 轮询等待用户登录完成。"""
    print("  请在 Edge 窗口里扫码或输入账号登录知乎...")
    bsk_nav(cfg, sid, "https://www.zhihu.com/signin", wait="load")
    deadline = time.time() + timeout
    while time.time() < deadline:
        time.sleep(5)
        d = bsk_eval(cfg, sid, LOGIN_CHECK_JS)
        if d and d.get("loggedIn"):
            print("  登录成功! 继续采集...")
            return True
        print("  等待登录中... (%ds)" % int(timeout - (deadline - time.time())), flush=True)
    return False


def collect_profile(cfg, sid, token):
    url = "https://www.zhihu.com/people/%s" % token
    if not bsk_nav(cfg, sid, url):
        raise RuntimeError("打开主页失败: " + url)
    time.sleep(1.5)
    d = bsk_eval(cfg, sid, PROFILE_JS)
    if not d:
        raise RuntimeError("读取主页数据失败 (页面结构可能变化)")
    if not d.get("name"):
        raise RuntimeError("无法读取用户名, 该用户可能不存在或页面结构变化")
    if not d.get("loggedIn"):
        print("  浏览器未登录知乎, 需要登录后才能采集回答列表。")
        if not wait_for_login(cfg, sid):
            raise RuntimeError("等待登录超时, 请先在 Edge 里登录知乎后重试")
        # 登录后重新导航到主页
        if not bsk_nav(cfg, sid, url):
            raise RuntimeError("登录后重新打开主页失败: " + url)
        time.sleep(1.5)
        d = bsk_eval(cfg, sid, PROFILE_JS)
        if not d:
            raise RuntimeError("登录后读取主页数据失败")
    return d


ANSWERS_API_JS = r"""(async function(){
  try{
    var r=await fetch('/api/v4/members/%TOKEN%/answers?limit=20&offset=%OFFSET%'
      +'&include=data%5B*%5D.is_normal%2Cvoteup_count%2Ccontent%2Cexcerpt'
      +'%2Ccomment_count%2Ccreated_time%2Cupdated_time%2Cquestion.title'
      +'%2Cquestion.id');
    var d=await r.json();
    var out=[];
    (d.data||[]).forEach(function(a){
      out.push({
        id:(a.question&&a.question.id?a.question.id:'')+'_'+a.id,
        qid:a.question?a.question.id.toString():'',
        aid:a.id?a.id.toString():'',
        title:a.question?a.question.title:'',
        votes:a.voteup_count||0,
        excerpt:(a.excerpt||'').substring(0,600),
        content:(a.content||'').replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim().substring(0,2000),
        time:a.updated_time?new Date(a.updated_time*1000).toISOString().substring(0,10):'',
        href:a.question?('https://www.zhihu.com/question/'+a.question.id+'/answer/'+a.id):'',
            type:'answer'
      });
    });
    return JSON.stringify({ok:true, items:out, is_end:!!(d.paging&&d.paging.is_end)});
  }catch(e){return JSON.stringify({ok:false, items:[], is_end:true, error:e.message});}
})()"""


ANSWER_FULL_API_JS = r"""(async function(){
  try{
    var r=await fetch('/api/v4/answers/%AID%?include=content,voteup_count,excerpt,question.title,question.id');
    var d=await r.json();
    var content=(d.content||'').replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim();
    return JSON.stringify({ok:true, content:content.substring(0,8000),
      votes:d.voteup_count||0, title:d.question?d.question.title:''});
  }catch(e){return JSON.stringify({ok:false, content:'', error:e.message});}
})()"""


ANSWER_VOTE_JS = r"""(async function(){
  try{
    var r=await fetch('/api/v4/answers/%AID%?include=voteup_count');
    var d=await r.json();
    return JSON.stringify({ok:true, votes:d.voteup_count||0});
  }catch(e){return JSON.stringify({ok:false, votes:0});}
})()"""


FOLLOWERS_API_JS = r"""(async function(){
  try{
    var r=await fetch('/api/v4/members/%TOKEN%/followers?limit=20&offset=%OFFSET%');
    var d=await r.json();
    var out=[];
    (d.data||[]).forEach(function(u){out.push({token:u.url_token||'', name:u.name||''});});
    return JSON.stringify({ok:true, found:out, is_end:!!(d.paging&&d.paging.is_end)});
  }catch(e){return JSON.stringify({ok:false, found:[], is_end:true, error:e.message});}
})()"""


FOLLOWEES_API_JS = r"""(async function(){
  try{
    var r=await fetch('/api/v4/members/%TOKEN%/followees?limit=20&offset=%OFFSET%');
    var d=await r.json();
    var out=[];
    (d.data||[]).forEach(function(u){out.push({token:u.url_token||'', name:u.name||''});});
    return JSON.stringify({ok:true, found:out, is_end:!!(d.paging&&d.paging.is_end)});
  }catch(e){return JSON.stringify({ok:false, found:[], is_end:true, error:e.message});}
})()"""


ARTICLES_API_JS = r"""(async function(){
  try{
    var r=await fetch('/api/v4/members/%TOKEN%/articles?limit=20&offset=%OFFSET%'
      +'&include=data%5B*%5D.is_normal%2Cvoteup_count%2Ccontent%2Cexcerpt'
      +'%2Ccomment_count%2Ccreated%2Cupdated%2Ctitle%2Cauthor.name');
    var d=await r.json();
    var out=[];
    (d.data||[]).forEach(function(a){
      out.push({
        id:'art_'+(a.id||''),
        aid:(a.id||'').toString(),
        title:a.title||'',
        votes:a.voteup_count||0,
        excerpt:(a.excerpt||'').substring(0,600),
        content:(a.content||'').replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim().substring(0,2000),
        time:a.updated?new Date(a.updated*1000).toISOString().substring(0,10):(a.created?new Date(a.created*1000).toISOString().substring(0,10):''),
        href:a.id?('https://zhuanlan.zhihu.com/p/'+a.id):'',
        type:'article'
      });
    });
    return JSON.stringify({ok:true, items:out, is_end:!!(d.paging&&d.paging.is_end)});
  }catch(e){return JSON.stringify({ok:false, items:[], is_end:true, error:e.message});}
})()"""


def collect_answers(cfg, sid, max_answers, pause_ms, token):
    """通过知乎 API 分页采集回答列表, 并补充赞同数。"""
    # 导航到回答页 (非主页), 确保知乎签名 cookie 有效
    bsk_nav(cfg, sid, "https://www.zhihu.com/people/%s/answers" % token, wait="load")
    time.sleep(3)
    # 首次 API 请求重试 (页面可能还在初始化, 签名 cookie 可能需要刷新)
    for attempt in range(3):
        js = ANSWERS_API_JS.replace("%TOKEN%", token).replace("%OFFSET%", "0")
        d = bsk_eval(cfg, sid, js, timeout=30)
        if d and d.get("ok") and d.get("items"):
            break
        # 重新导航刷新签名
        if attempt < 2:
            bsk_nav(cfg, sid, "https://www.zhihu.com/people/%s/answers" % token, wait="load")
            time.sleep(3)
    seen = {}
    offset = 0
    deadline = time.time() + 300
    while len(seen) < max_answers and time.time() < deadline:
        js = ANSWERS_API_JS.replace("%TOKEN%", token).replace("%OFFSET%", str(offset))
        d = bsk_eval(cfg, sid, js, timeout=30)
        if not d or not d.get("ok"):
            break
        items = d.get("items", [])
        newn = 0
        for it in d.get("items", []):
            iid = str(it.get("id") or "")
            if iid and iid not in seen and len(seen) < max_answers:
                seen[iid] = it
                newn += 1
        if d.get("is_end"):
            break
        if newn == 0:
            break
        offset += 20
        time.sleep(0.8)
        if len(seen) % 40 == 0:
            print("    已收集 %d 条回答..." % len(seen), flush=True)
    # 列表 API 不返回赞同数, 用单条 API 补充 (最多前 30 条)
    answers = list(seen.values())
    print("    补充赞同数 (前 %d 条)..." % min(30, len(answers)), flush=True)
    for i, a in enumerate(answers[:30]):
        aid = a.get("aid", "")
        if aid:
            js2 = ANSWER_VOTE_JS.replace("%AID%", aid)
            vd = bsk_eval(cfg, sid, js2, timeout=15)
            if vd and vd.get("ok"):
                a["votes"] = vd.get("votes", 0)
            time.sleep(0.3)
    return answers


def collect_articles(cfg, sid, max_articles, token):
    """通过知乎 API 分页采集专栏文章列表。"""
    bsk_nav(cfg, sid, "https://www.zhihu.com/people/%s/posts" % token, wait="load")
    time.sleep(3)
    for attempt in range(3):
        js = ARTICLES_API_JS.replace("%TOKEN%", token).replace("%OFFSET%", "0")
        d = bsk_eval(cfg, sid, js, timeout=30)
        if d and d.get("ok") and d.get("items"):
            break
        if attempt < 2:
            bsk_nav(cfg, sid, "https://www.zhihu.com/people/%s/posts" % token, wait="load")
            time.sleep(3)
    seen = {}
    offset = 0
    deadline = time.time() + 180
    while len(seen) < max_articles and time.time() < deadline:
        js = ARTICLES_API_JS.replace("%TOKEN%", token).replace("%OFFSET%", str(offset))
        d = bsk_eval(cfg, sid, js, timeout=30)
        if not d or not d.get("ok"):
            break
        newn = 0
        for it in d.get("items", []):
            iid = str(it.get("id") or "")
            if iid and iid not in seen and len(seen) < max_articles:
                seen[iid] = it
                newn += 1
        if d.get("is_end"):
            break
        if newn == 0:
            break
        offset += 20
        time.sleep(0.8)
        if len(seen) % 40 == 0:
            print("    已收集 %d 篇文章..." % len(seen), flush=True)
    return list(seen.values())


def collect_top_full(cfg, sid, answers, top_n):
    """返回最高赞回答, 全文用列表 API 的 content (已含完整 HTML 正文)。"""
    ranked = sorted(answers, key=lambda a: a.get("votes", 0), reverse=True)
    out = []
    for a in ranked[:top_n]:
        # 列表 API 的 content 字段已经是完整正文 (HTML → 纯文本已处理)
        full = a.get("content", "")
        if not full:
            # 降级: 用单条 API 获取
            aid = a.get("aid", "")
            if aid:
                js = ANSWER_FULL_API_JS.replace("%AID%", aid)
                d = bsk_eval(cfg, sid, js, timeout=30)
                if d and d.get("ok"):
                    full = d.get("content", "")
                time.sleep(0.5)
        out.append(dict(a, full=full))
    return out


def _scan_follow_list(cfg, sid, target_token, api_js, feature_token, direction, max_scan=500):
    """通用: 在 target 的 followers 或 followees 列表里找 feature_token。"""
    offset = 0
    while offset < max_scan:
        js = api_js.replace("%TOKEN%", target_token).replace("%OFFSET%", str(offset))
        d = bsk_eval(cfg, sid, js, timeout=30)
        if not d or not d.get("ok"):
            return {"status": "unknown", "detail": "API 请求失败: %s" % (d.get("error","") if d else "无响应")}
        for f in d.get("found", []):
            if f.get("token") == feature_token:
                return {"status": "yes", "detail": ""}
        if d.get("is_end"):
            if offset == 0 and not d.get("found"):
                return {"status": "unknown", "detail": "列表不可见或为空"}
            return {"status": "no", "detail": "未找到 (扫描了 %d 人)" % (offset + 20)}
        offset += 20
        time.sleep(0.5)
    return {"status": "no", "detail": "在前 %d 人中未找到" % max_scan}


def check_follow(cfg, sid, target_token, feature_token):
    """双向关注关系: forward=子夜极光是否关注目标, reverse=目标是否关注子夜极光。"""
    bsk_nav(cfg, sid, "https://www.zhihu.com/people/%s" % target_token, wait="load")
    time.sleep(2)
    # forward: 子夜极光是否关注目标 → 在目标的 followers 里找子夜极光
    fwd = _scan_follow_list(cfg, sid, target_token, FOLLOWERS_API_JS, feature_token, "forward")
    # reverse: 目标是否关注子夜极光 → 在目标的 followees 里找子夜极光
    rev = _scan_follow_list(cfg, sid, target_token, FOLLOWEES_API_JS, feature_token, "reverse")
    fwd_label = {"yes": "已关注", "no": "未关注", "unknown": "无法确认"}.get(fwd["status"], "无法确认")
    rev_label = {"yes": "已关注", "no": "未关注", "unknown": "无法确认"}.get(rev["status"], "无法确认")
    print("      子夜极光→目标: %s (%s)" % (fwd["status"], fwd.get("detail","")))
    print("      目标→子夜极光: %s (%s)" % (rev["status"], rev.get("detail","")))
    return {
        "forward": fwd["status"],
        "forward_detail": fwd.get("detail", ""),
        "reverse": rev["status"],
        "reverse_detail": rev.get("detail", ""),
        # 兼容旧格式
        "status": fwd["status"],
        "detail": "子夜极光→目标: %s; 目标→子夜极光: %s" % (fwd_label, rev_label),
    }


# ---------------------------------------------------------------------------
# 分析层: 关键词 / 词云 / LLM 倾向
# ---------------------------------------------------------------------------
_CLEAN_RE = re.compile(r"https?://\S+|www\.\S+|@\S+|[\d]{4,}|[^\w\u4e00-\u9fff]+")


def _clean_text(text):
    text = _CLEAN_RE.sub(" ", text)
    return text


def meaningful_words(text):
    """按词性白名单 + 停用词过滤, 返回实义词列表。"""
    import jieba.posseg as pseg
    text = _clean_text(text)
    out = []
    for w, flag in pseg.lcut(text):
        if flag not in ALLOW_POS and flag[:2] not in ALLOW_POS:
            continue
        if flag != "eng" and len(w) < 2:
            continue
        if w in STOPWORDS:
            continue
        out.append(w)
    return out


def cloud_keywords(texts, docs, topk=120, df_max=0.6):
    """TF-IDF + 文档频率上限, 返回 {word: weight}。"""
    import jieba.analyse
    all_text = " ".join(_clean_text(t) for t in texts)
    # 文档频率: 计算每个词出现在多少篇"文档"中
    df = Counter()
    for d in docs:
        ws = set(meaningful_words(d))
        for w in ws:
            df[w] += 1
    n_docs = max(1, len(docs))
    df_cap = set(w for w, c in df.items() if c / n_docs > df_max)
    pairs = jieba.analyse.extract_tags(
        all_text, topK=topk * 2, withWeight=True, allowPOS=ALLOW_POS)
    result = {}
    for w, score in pairs:
        if w in STOPWORDS or w in df_cap or len(w) < 2:
            continue
        result[w] = round(score, 4)
        if len(result) >= topk:
            break
    return result


def make_wordcloud_b64(freq):
    """生成词云 PNG, 返回 base64。无有效词时返回 None。"""
    from wordcloud import WordCloud
    if not freq:
        return None
    wc = WordCloud(
        font_path=FONT_PATH, width=960, height=480,
        background_color="white", max_words=120,
        prefer_horizontal=0.9, colormap="viridis",
    )
    img = wc.generate_from_frequencies(freq)
    buf = io.BytesIO()
    img.to_image().save(buf, format="PNG")
    return base64.b64encode(buf.getvalue()).decode()


def _extract_json(text):
    text = re.sub(r"^```(?:json)?", "", text, flags=re.M)
    text = re.sub(r"```$", "", text, flags=re.M)
    s, e = text.find("{"), text.rfind("}")
    if s < 0 or e <= s:
        return None
    chunk = text[s:e + 1]
    try:
        return json.loads(chunk)
    except ValueError:
        pass
    # 尝试修复截断的 JSON (补全缺失的括号)
    for fix in ["}", "}}", "}}}}", '"}', '"}}', '"}}}}']:
        try:
            return json.loads(chunk + fix)
        except ValueError:
            continue
    return None


def llm_analyze(cfg, profile, top_answers, answers, keywords, articles=None):
    """调用 LLM 产出概括 + 三维倾向。"""
    from _llm import chat, LLMError
    articles = articles or []
    samples = []
    # 混合回答和文章, 按赞数排序取 Top 5
    all_content = []
    for a in answers:
        all_content.append(("回答", a.get("title", ""), a.get("votes", 0), a.get("excerpt", "")[:150]))
    for art in articles:
        all_content.append(("文章", art.get("title", ""), art.get("votes", 0), (art.get("excerpt") or "")[:150]))
    all_content.sort(key=lambda x: x[2], reverse=True)
    for ctype, title, votes, excerpt in all_content[:5]:
        samples.append("【%s·%s】(%s赞)\n%s" % (ctype, title, votes, excerpt))
    top_block = ""
    for t in top_answers:
        top_block += "【%s】(%s赞)\n%s\n\n" % (
            t.get("title", ""), t.get("votes", 0), (t.get("full") or t.get("excerpt", ""))[:2000])
    kw_str = "、".join("%s(%.2f)" % (w, s) for w, s in keywords[:30])
    prompt = (
        "你是政治立场分析助手。根据以下某知乎用户的公开资料（个人简介、最高赞回答全文、"
        "高赞回答摘要、高频关键词），分析其观点倾向。\n\n"
        "【刻度定义】每个维度给出 -100 到 +100 的整数分数："
        "负分=左（政治：集体/权威/平等优先；经济：支持再分配/国有/管制；文化：进步/变革优先），"
        "正分=右（政治：自由/个人权利优先；经济：支持市场化/私有；文化：保守/传统优先），"
        "0 为中间。分数必须给出原文依据（引用或转述具体内容），没有依据就给 0 或接近 0 "
        "并说明信息不足。\n\n"
        "【个人简介】\n姓名: {name}\n一句话简介: {headline}\n详细介绍: {desc}\n"
        "IP属地: {ip}  行业: {biz}  粉丝: {follower}\n\n"
        "【最高赞回答】\n{top}\n\n"
        "【高赞回答样本】\n{samples}\n\n"
        "【高频关键词】\n{kw}\n\n"
        "请输出一个 JSON 对象（不要输出其他文字），包含以下字段：\n"
        '- summary: 5-8句详细分析, 涵盖用户整体形象、主要关注领域、观点特征\n'
        '- political/economic/cultural: 每个维度 {{score: 整数, evidence: [2-3条依据]}}\n'
        '- content_themes: 该用户主要关注的话题主题, 列出3-5个并简要说明\n'
        '- keywords_analysis: 高频关键词反映的兴趣领域和可能的立场信号\n'
        '- user_archetype: 用户画像标签, 1-3个词概括(如"游戏玩家/时政评论者/技术从业者")\n'
        '- confidence: high/medium/low\n'
        '- caveat: 一句话说明信息局限\n\n'
        'JSON 格式:\n'
        '{{"summary":"详细分析文本",'
        '"political":{{"score":0,"evidence":["依据1","依据2"]}},'
        '"economic":{{"score":0,"evidence":["依据1","依据2"]}},'
        '"cultural":{{"score":0,"evidence":["依据1","依据2"]}},'
        '"content_themes":["主题1: 说明","主题2: 说明"],'
        '"keywords_analysis":"关键词分析文本",'
        '"user_archetype":"标签1/标签2",'
        '"confidence":"medium",'
        '"caveat":"信息局限说明"}}'
    ).format(
        name=profile.get("name", ""), headline=profile.get("headline", ""),
        desc=(profile.get("description") or "")[:1000], ip=profile.get("ip", ""),
        biz=profile.get("business", ""), follower=profile.get("follower", 0),
        top=top_block or "（无）", samples="\n\n".join(samples) or "（无）",
        kw=kw_str or "（无）",
    )
    system = "你是严谨的政治学分析助手, 只输出 JSON。"
    try:
        raw = chat(cfg, system, prompt, timeout=float(cfg.get("timeout", 120)))
    except LLMError as e:
        return {"error": str(e)}
    if not raw or not raw.strip():
        return {"error": "LLM 返回空内容"}
    d = _extract_json(raw or "")
    if not d:
        return {"error": "LLM 返回无法解析为 JSON: " + (raw or "")[:200]}
    for dim in ("political", "economic", "cultural"):
        if dim in d and isinstance(d[dim], dict):
            try:
                d[dim]["score"] = int(float(d[dim].get("score", 0)))
            except (TypeError, ValueError):
                d[dim]["score"] = 0
    return d


# ---------------------------------------------------------------------------
# 报告生成
# ---------------------------------------------------------------------------
def _esc(s):
    s = str(s)
    s = s.replace("&", ("&" + "amp;"))
    s = s.replace("<", ("&" + "lt;"))
    s = s.replace(">", ("&" + "gt;"))
    s = s.replace('"', ("&" + "quot;"))
    return s.replace("\n", "<br>")


def _fmt_votes(v):
    if v >= 10000:
        return "%.1f万" % (v / 10000)
    return str(v)


def _score_label(s):
    s = int(s)
    if s <= -60:
        return "极左"
    if s <= -20:
        return "偏左"
    if s < 20:
        return "中间" if s == 0 else ("中间偏左" if s < 0 else "中间偏右")
    if s < 60:
        return "偏右"
    return "极右"


def _bar_color(s):
    # 左红右蓝, 中间灰
    if s <= -20:
        return "#d9534f"
    if s >= 20:
        return "#428bca"
    return "#999"


def _get_model_name(cfg):
    providers = cfg.get("providers", {})
    pc = providers.get(cfg.get("provider", ""), {})
    return pc.get("model", cfg.get("model", "unknown"))


def render_report(target_token, profile, answers, articles, top_answers, keywords,
                  cloud_b64, follow, analysis, cfg):
    now = datetime.now().strftime("%Y-%m-%d %H:%M")
    feature_token = cfg.get("feature_token", "")
    total = profile.get("answerCount", 0)

    # 倾向条
    dims = []
    for key, name in (("political", "政治维度"), ("economic", "经济维度"),
                      ("cultural", "文化维度")):
        if analysis and key in analysis and isinstance(analysis[key], dict):
            sc = analysis[key].get("score", 0)
            ev = analysis[key].get("evidence", []) or []
        else:
            sc = 0
            ev = []
        left = (sc + 100) / 200 * 100
        ev_html = "".join("<li>%s</li>" % _esc(e) for e in ev) or "<li>信息不足</li>"
        dims.append(
            '<div class="dim"><div class="dim-head"><span class="dim-name">%s</span>'
            '<span class="dim-score" style="color:%s">%d (%s)</span></div>'
            '<div class="track"><div class="mid"></div>'
            '<div class="thumb" style="left:%.1f%%;background:%s"></div></div>'
            '<ul class="evi">%s</ul></div>' % (
                name, _bar_color(sc), sc, _score_label(sc), left, _bar_color(sc), ev_html))

    # 高赞回答 (不再单独突出, 放入 Top 列表)
    top_html = ""
    for t in top_answers:
        full = (t.get("full") or t.get("excerpt") or "（无法获取全文）")
        top_html += (
            '<div class="card"><h3>[回答] %s</h3><div class="meta">%s 赞 · %s</div>'
            '<div class="content">%s</div></div>' % (
                _esc(t.get("title", "")), _fmt_votes(t.get("votes", 0)),
                _esc(t.get("time", "")), _esc(full[:2000])))

    # 高赞内容 Top 10 (回答 + 文章混合排序)
    all_content = []
    for a in answers:
        all_content.append(("回答", a.get("votes", 0), a.get("title", ""), (a.get("excerpt") or "")[:100]))
    for art in articles:
        all_content.append(("文章", art.get("votes", 0), art.get("title", ""), (art.get("excerpt") or "")[:100]))
    all_content.sort(key=lambda x: x[1], reverse=True)
    top_list_html = ""
    for i, (ctype, votes, title, excerpt) in enumerate(all_content[:10], 1):
        top_list_html += (
            '<tr><td>%d</td><td>%s</td><td>%s</td><td>%s</td><td>%s</td></tr>' % (
                i, ctype, _fmt_votes(votes), _esc(title), _esc(excerpt)))

    # 关键词表格
    kw_table = ""
    for i, (w, s) in enumerate(keywords[:30], 1):
        kw_table += '<tr><td>%d</td><td>%s</td><td>%.4f</td></tr>' % (i, _esc(w), s)

    # 关键词 chips
    kw_chips = "".join(
        '<span class="chip">%s<small>%.2f</small></span>' % (_esc(w), s)
        for w, s in keywords[:30])

    # 关注关系 (双向)
    fwd_status = follow.get("forward", follow.get("status", "unknown"))
    rev_status = follow.get("reverse", "unknown")
    _badge_map = {"yes": ("badge-ok", "已关注"), "no": ("badge-no", "未关注"),
                  "unknown": ("badge-unk", "无法确认")}
    fwd_badge = _badge_map.get(fwd_status, ("badge-unk", "无法确认"))
    rev_badge = _badge_map.get(rev_status, ("badge-unk", "无法确认"))
    fwd_detail = follow.get("forward_detail", "")
    rev_detail = follow.get("reverse_detail", "")

    # 概括
    if analysis and analysis.get("summary"):
        summary_html = _esc(analysis["summary"])
    elif analysis and analysis.get("error"):
        summary_html = '<span class="err">LLM 分析失败: %s</span>' % _esc(analysis["error"])
    else:
        summary_html = '<span class="muted">(--no-llm 模式, 未调用 LLM)</span>'

    conf = ""
    if analysis and analysis.get("confidence"):
        conf = '<span class="conf">置信度: %s</span>' % _esc(analysis["confidence"])
    caveat = ""
    if analysis and analysis.get("caveat"):
        caveat = '<div class="caveat">%s</div>' % _esc(analysis["caveat"])

    # 用户画像标签
    archetype_html = ""
    if analysis and analysis.get("user_archetype"):
        tags = analysis["user_archetype"].split("/")
        tags_html = "".join('<span class="chip">%s</span>' % _esc(t.strip()) for t in tags if t.strip())
        archetype_html = '<div class="chips" style="margin-top:8px">%s</div>' % tags_html

    # 话题主题
    themes_html = ""
    if analysis and analysis.get("content_themes"):
        themes = analysis["content_themes"]
        if isinstance(themes, list):
            for t in themes:
                themes_html += '<li>%s</li>' % _esc(t)
        else:
            themes_html = '<li>%s</li>' % _esc(str(themes))
        themes_html = '<ul class="evi">%s</ul>' % themes_html

    # 关键词分析
    kw_analysis_html = ""
    if analysis and analysis.get("keywords_analysis"):
        kw_analysis_html = '<p style="font-size:14px;color:#555">%s</p>' % _esc(analysis["keywords_analysis"])

    cloud_html = ""
    if cloud_b64:
        cloud_html = '<img class="cloud" src="data:image/png;base64,%s" alt="词云">' % cloud_b64
    else:
        cloud_html = '<div class="muted">无足够文本生成词云</div>'

    return _HTML_TEMPLATE.format(
        title=_esc(profile.get("name", target_token)),
        target_url="https://www.zhihu.com/people/" + target_token,
        target_token=_esc(target_token),
        name=_esc(profile.get("name", "")),
        headline=_esc(profile.get("headline", "")),
        desc=_esc(profile.get("description", "") or "（无）"),
        meta="IP:%s · %s · 粉丝:%s · 回答:%s" % (
            _esc(profile.get("ip", "未知")), _esc(profile.get("gender", "未知")),
            _fmt_votes(profile.get("follower", 0)), _fmt_votes(total)),
        sample_n=len(answers),
        total=total,
        now=now,
        summary=summary_html, conf=conf, caveat=caveat,
        archetype=archetype_html,
        themes=themes_html or '<span class="muted">信息不足</span>',
        kw_analysis=kw_analysis_html or '<span class="muted">信息不足</span>',
        dims="\n".join(dims),
        top_html=top_html or '<div class="muted">未采集到高赞内容</div>',
        top_list=top_list_html,
        kw_chips=kw_chips or '<span class="muted">无</span>',
        kw_table=kw_table,
        cloud_html=cloud_html,
        fwd_badge=fwd_badge[0], fwd_text=fwd_badge[1],
        rev_badge=rev_badge[0], rev_text=rev_badge[1],
        fwd_detail=_esc(fwd_detail), rev_detail=_esc(rev_detail),
        articles_count=len(articles),
        feature_url="https://www.zhihu.com/people/" + feature_token,
        model=_esc(cfg.get("provider", "") + "/" + _get_model_name(cfg)),
    )


_HTML_TEMPLATE = """<!DOCTYPE html>
<html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>查成分 - {title}</title>
<style>
*{{box-sizing:border-box;margin:0;padding:0}}
body{{font-family:"Microsoft YaHei","Segoe UI",sans-serif;background:#f5f5f5;color:#222;
line-height:1.7;max-width:920px;margin:0 auto;padding:24px 16px 80px}}
h1{{font-size:26px;margin-bottom:4px}}
a{{color:#1772f6;text-decoration:none}}
a:hover{{text-decoration:underline}}
.muted{{color:#999}}
.err{{color:#c0392b}}
.header{{margin-bottom:24px}}
.headline{{color:#666;font-size:15px;margin:4px 0}}
.desc{{background:#fff;border-radius:8px;padding:14px 18px;margin:12px 0;font-size:14px}}
.meta-line{{font-size:13px;color:#888;margin:6px 0 0}}
.sample{{font-size:12px;color:#aaa;margin-top:8px}}
.section{{background:#fff;border-radius:10px;padding:20px 24px;margin:16px 0;box-shadow:0 1px 3px rgba(0,0,0,.06)}}
.section h2{{font-size:18px;margin-bottom:12px;padding-bottom:8px;border-bottom:2px solid #eee}}
.dim{{margin-bottom:20px}}
.dim:last-child{{margin-bottom:0}}
.dim-head{{display:flex;justify-content:space-between;align-items:center;margin-bottom:8px}}
.dim-name{{font-weight:600;font-size:15px}}
.dim-score{{font-weight:700;font-size:15px}}
.track{{position:relative;height:14px;background:linear-gradient(to right,#d9534f,#eee 48%,#eee 52%,#428bca);border-radius:7px}}
.mid{{position:absolute;left:50%;top:0;bottom:0;width:2px;background:#666;transform:translateX(-50%)}}
.thumb{{position:absolute;top:-3px;width:20px;height:20px;border-radius:50%;border:2px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,.3);transform:translateX(-50%)}}
.evi{{margin:8px 0 0 18px;font-size:13px;color:#555}}
.evi li{{margin:3px 0}}
.card{{background:#fafafa;border-radius:8px;padding:14px 18px;margin:10px 0}}
.card h3{{font-size:15px;margin-bottom:6px}}
.card .meta{{font-size:12px;color:#999;margin-bottom:8px}}
.card .content{{font-size:14px;max-height:500px;overflow:auto}}
.chips{{display:flex;flex-wrap:wrap;gap:8px;margin-top:8px}}
.chip{{background:#eef4ff;border:1px solid #d0e0ff;border-radius:16px;padding:4px 12px;font-size:14px}}
.chip small{{color:#999;margin-left:4px}}
.cloud{{width:100%;border-radius:8px;margin-top:8px}}
.badge{{display:inline-block;padding:3px 12px;border-radius:12px;font-size:13px;font-weight:600}}
.badge-ok{{background:#e8f5e9;color:#2e7d32}}
.badge-no{{background:#fafafa;color:#666;border:1px solid #ddd}}
.badge-unk{{background:#fff3e0;color:#e65100}}
.conf{{color:#888;font-size:13px;margin-left:12px}}
.caveat{{margin-top:8px;font-size:13px;color:#999;font-style:italic}}
table{{width:100%;border-collapse:collapse;margin:8px 0;font-size:13px}}
th,td{{text-align:left;padding:8px 12px;border-bottom:1px solid #eee}}
th{{font-weight:600;color:#888;font-size:12px}}
tr:hover{{background:#f9f9f9}}
.footer{{margin-top:32px;font-size:12px;color:#aaa;text-align:center;line-height:1.8}}
</style></head><body>
<div class="header">
<h1>{name}</h1>
<div class="headline">{headline}</div>
<div class="desc">{desc}</div>
<div class="meta-line">{meta}</div>
<div class="sample">采集 {sample_n}/{total} 条回答 · {articles_count} 篇文章 · 生成于 {now} · <a href="{target_url}" target="_blank">查看原主页</a></div>
{archetype}
</div>

<div class="section"><h2>详细分析</h2>
<p style="font-size:14px;line-height:1.8">{summary}</p>{conf}{caveat}</div>

<div class="section"><h2>三维度倾向</h2>
{dims}
<div style="font-size:12px;color:#aaa;margin-top:12px">刻度: -100(极左) ← 0(中间) → +100(极右)</div>
</div>

<div class="section"><h2>话题主题归类</h2>
{themes}</div>

<div class="section"><h2>关键词分析</h2>
{kw_analysis}</div>

<div class="section"><h2>最高赞回答</h2>
{top_html}</div>

<div class="section"><h2>高赞内容 Top 10</h2>
<table>
<tr><th>#</th><th>类型</th><th>赞数</th><th>标题</th><th>摘要</th></tr>
{top_list}
</table></div>

<div class="section"><h2>高频关键词</h2>
<div class="chips">{kw_chips}</div>
<table style="margin-top:12px">
<tr><th>排名</th><th>关键词</th><th>权重</th></tr>
{kw_table}
</table></div>

<div class="section"><h2>回答词云</h2>
{cloud_html}</div>

<div class="section"><h2>特征用户关注关系</h2>
<p>子夜极光 (<a href="{feature_url}" target="_blank">{feature_url}</a>) 与该用户的双向关注关系:</p>
<p>子夜极光 → 该用户: <span class="badge {fwd_badge}">{fwd_text}</span></p>
<p class="muted" style="font-size:13px;margin-top:2px">{fwd_detail}</p>
<p>该用户 → 子夜极光: <span class="badge {rev_badge}">{rev_text}</span></p>
<p class="muted" style="font-size:13px;margin-top:2px">{rev_detail}</p></div>

<div class="footer">
免责声明: 本报告由 AI 根据公开数据自动生成, 倾向分数为模型估计而非事实定性, 仅供了解参考;<br>
分析过程中用户内容曾发送至所配置的 LLM 服务 ({model})。请勿用于人身攻击或网络暴力。
</div>
</body></html>"""


# ---------------------------------------------------------------------------
# 数据持久化
# ---------------------------------------------------------------------------
def save_data(token, data):
    d = BASE / "data"
    d.mkdir(exist_ok=True)
    (d / ("%s.json" % token)).write_text(
        json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")


def load_data(token):
    p = BASE / "data" / ("%s.json" % token)
    if not p.exists():
        return None
    return json.loads(p.read_text(encoding="utf-8"))


# ---------------------------------------------------------------------------
# 主流程
# ---------------------------------------------------------------------------
def main():
    ap = argparse.ArgumentParser(description="知乎查成分工具")
    ap.add_argument("target", help="目标用户主页 URL 或 url_token")
    ap.add_argument("--answers", type=int, default=600, help="最多采集回答数 (默认 600)")
    ap.add_argument("--articles", type=int, default=200, help="最多采集文章数 (默认 200)")
    ap.add_argument("--top", type=int, default=1, help="读取全文的最高赞回答数 (默认 1)")
    ap.add_argument("--no-llm", action="store_true", help="不调用 LLM, 只采集+词云")
    ap.add_argument("--reuse-data", action="store_true", help="复用已采集的数据 (不启动浏览器)")
    ap.add_argument("--out", default="", help="报告输出路径 (默认 report_<token>.html)")
    args = ap.parse_args()

    token = parse_token(args.target)
    cfg = load_config()
    out_path = args.out or str(BASE / ("report_%s.html" % token))
    print("目标: %s  (token=%s)" % (args.target, token))

    # --- 采集或复用 ---
    if args.reuse_data:
        data = load_data(token)
        if not data:
            print("错误: 未找到已采集的数据, 请先运行一次完整采集")
            return 1
        print("复用已采集数据: %d 条回答, %d 篇文章" % (
            len(data.get("answers", [])), len(data.get("articles", []))))
    else:
        print("启动浏览器会话...")
        sid = session_start(cfg)
        print("会话: %s" % sid)
        try:
            print("[1/6] 采集个人主页...")
            profile = collect_profile(cfg, sid, token)
            print("      %s · %s · 回答 %d · 粉丝 %d" % (
                profile.get("name"), profile.get("headline"),
                profile.get("answerCount", 0), profile.get("follower", 0)))

            print("[2/6] 采集回答列表 (最多 %d 条)..." % args.answers)
            answers = collect_answers(
                cfg, sid, args.answers, cfg.get("scroll_pause_ms", 1500), token)
            print("      共采集 %d 条" % len(answers))

            print("[3/6] 采集专栏文章 (最多 %d 篇)..." % args.articles)
            articles = collect_articles(cfg, sid, args.articles, token)
            print("      共采集 %d 篇" % len(articles))

            print("[4/6] 读取高赞内容全文 (Top %d)..." % args.top)
            top_answers = collect_top_full(cfg, sid, answers, args.top)

            print("[5/6] 查询子夜极光双向关注关系...")
            follow = check_follow(cfg, sid, token, cfg.get("feature_token", ""))

            print("[6/6] 保存采集数据...")
            data = {
                "token": token, "profile": profile, "answers": answers,
                "articles": articles, "top_answers": top_answers, "follow": follow,
                "collected_at": datetime.now().isoformat(timespec="seconds"),
            }
            save_data(token, data)
        finally:
            session_stop(cfg, sid)

    profile = data["profile"]
    answers = data["answers"]
    articles = data.get("articles", [])
    top_answers = data.get("top_answers", [])
    follow = data.get("follow", {"status": "unknown", "forward": "unknown", "reverse": "unknown"})

    if not answers and not articles:
        print("错误: 未采集到任何回答或文章, 无法分析")
        return 1

    # --- 分析 ---
    print("分词与关键词提取...")
    texts = []
    for a in answers:
        texts.append((a.get("title") or "") + " " + (a.get("excerpt") or ""))
    for art in articles:
        texts.append((art.get("title") or "") + " " + (art.get("excerpt") or "") + " " + (art.get("content") or "")[:500])
    for t in top_answers:
        if t.get("full"):
            texts.append(t["full"])
    keywords = cloud_keywords(texts, texts, topk=120)
    print("  提取到 %d 个有效关键词, Top10: %s" % (
        len(keywords), ", ".join(w for w, _ in list(keywords.items())[:10])))

    print("生成词云图...")
    cloud_b64 = make_wordcloud_b64(keywords)

    analysis = None
    if not args.no_llm:
        print("调用 LLM 分析三维倾向...")
        analysis = llm_analyze(cfg, profile, top_answers, answers,
                               list(keywords.items()), articles)
        if analysis.get("error"):
            print("  警告: %s" % analysis["error"])
        else:
            print("  概括: %s" % analysis.get("summary", "")[:80])
            for k in ("political", "economic", "cultural"):
                d = analysis.get(k, {})
                print("  %s: %d (%s)" % (k, d.get("score", 0), _score_label(d.get("score", 0))))

    # --- 报告 ---
    print("生成报告...")
    html = render_report(token, profile, answers, articles, top_answers,
                         list(keywords.items()), cloud_b64, follow, analysis, cfg)
    Path(out_path).write_text(html, encoding="utf-8")
    print("报告已保存: %s" % out_path)
    print("完成。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
