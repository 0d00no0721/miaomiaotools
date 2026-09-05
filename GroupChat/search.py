# -*- coding: utf-8 -*-
"""免费爬虫搜索：DuckDuckGo Lite + Bing HTML 降级。

不引入外部依赖（requests + 正则解析），失败返回空列表，引擎层优雅降级。
中文搜索引擎（百度/搜狗/知乎）反爬严重，DDG/Bing 是相对可行的免费选项。
"""
import re
from urllib.parse import quote_plus, unquote

import requests

_UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
       "AppleWebKit/537.36 (KHTML, like Gecko) "
       "Chrome/126.0 Safari/537.36")


def web_search(query, max_results=5, timeout=10):
    """搜索并返回结果列表。失败返回空列表（不抛异常）。

    返回 [{"title", "url", "snippet"}]
    """
    results = _search_ddg_lite(query, max_results, timeout)
    if results:
        return results
    return _search_bing(query, max_results, timeout)


def _search_ddg_lite(query, max_results, timeout):
    """DuckDuckGo Lite 版——HTML 简单、无 JS、反爬相对宽松。"""
    url = "https://lite.duckduckgo.com/lite/?q=%s" % quote_plus(query)
    try:
        resp = requests.get(url, timeout=timeout,
                            headers={"User-Agent": _UA})
    except requests.RequestException:
        return []
    if resp.status_code != 200 or len(resp.text) < 500:
        return []
    return _parse_ddg_lite(resp.text, max_results)


def _parse_ddg_lite(html, max_results):
    """解析 DDG Lite 结果页。

    Lite 页结果在 <a class="result-link" href="...">标题</a> 后跟
    <td class="result-snippet">摘要</td>。
    """
    results = []
    # 结果链接
    link_pattern = re.compile(
        r'<a[^>]*class="result-link"[^>]*href="([^"]+)"[^>]*>(.*?)</a>',
        re.S)
    # 摘要
    snippet_pattern = re.compile(
        r'<td[^>]*class="result-snippet"[^>]*>(.*?)</td>', re.S)

    links = link_pattern.findall(html)
    snippets = snippet_pattern.findall(html)

    for i, (raw_url, raw_title) in enumerate(links[:max_results]):
        title = _strip_tags(raw_title).strip()
        # DDG 有时会给重定向 URL（//duckduckgo.com/l/?uddg=...）
        if raw_url.startswith("//duckduckgo.com/l/?uddg="):
            raw_url = unquote(raw_url.split("uddg=")[-1].split("&")[0])
        if not raw_url.startswith("http"):
            continue
        snippet = _strip_tags(snippets[i]).strip() if i < len(snippets) else ""
        if title:
            results.append({"title": title, "url": raw_url, "snippet": snippet})
    return results


def _search_bing(query, max_results, timeout):
    """Bing HTML 版降级。记忆显示可能返回降级页，但值得尝试。"""
    url = "https://cn.bing.com/search?q=%s&setlang=zh-CN" % quote_plus(query)
    try:
        resp = requests.get(url, timeout=timeout,
                            headers={"User-Agent": _UA})
    except requests.RequestException:
        return []
    if resp.status_code != 200 or len(resp.text) < 2000:
        return []
    return _parse_bing(resp.text, max_results)


def _parse_bing(html, max_results):
    """解析 Bing 搜索结果页。

    Bing 结果在 <li class="b_algo"> 内：
    <h2><a href="...">标题</a></h2> + <p>摘要</p>
    """
    results = []
    blocks = re.findall(r'<li class="b_algo".*?</li>', html, re.S)
    for block in blocks[:max_results]:
        m = re.search(r'<a[^>]*href="([^"]+)"[^>]*>(.*?)</a>', block, re.S)
        if not m:
            continue
        raw_url, raw_title = m.group(1), m.group(2)
        title = _strip_tags(raw_title).strip()
        if not title or not raw_url.startswith("http"):
            continue
        s = re.search(r'<p[^>]*>(.*?)</p>', block, re.S)
        snippet = _strip_tags(s.group(1)).strip() if s else ""
        results.append({"title": title, "url": raw_url, "snippet": snippet})
    return results


def _strip_tags(html_text):
    """Strip HTML tags and decode entities."""
    import html as _html
    text = re.sub(r"<[^>]+>", "", html_text)
    return _html.unescape(text).strip()


def format_results(results):
    """Format search results as text readable by LLM."""
    if not results:
        return "（搜索未返回结果）"
    lines = []
    for i, r in enumerate(results, 1):
        lines.append("%d. %s" % (i, r["title"]))
        lines.append("   URL: %s" % r["url"])
        if r["snippet"]:
            lines.append("   摘要: %s" % r["snippet"][:200])
    return "\n".join(lines)
