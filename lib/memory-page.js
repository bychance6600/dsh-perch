/**
 * memory-page.js —— 记忆图谱的独立页面（/dsh-perch/memory）。
 *
 * 为什么单独一个文件：这个页面不走设置页那棵树，浏览器地址栏直接打开也能看。
 * 数据只从 /dsh-perch/api/memory 取；取不到（插件没开、被挡、断网）就给一句空态，
 * 不留白屏。页面上没有任何写操作。
 *
 * 约束：不引外部字体/脚本/图片，断网时除数据外整页可用。
 */

export const MEMORY_PAGE = String.raw`<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>记忆图谱 · dsh-perch</title>
<style>
:root{color-scheme:dark}
*{box-sizing:border-box}
html,body{margin:0;height:100%;background:#0b0e13;color:#d9e0ea;font:14px/1.5 "Segoe UI","Microsoft YaHei",system-ui,sans-serif}
body{display:flex;flex-direction:column}
header{padding:14px 18px 8px;border-bottom:1px solid #1d2430}
h1{margin:0;font-size:17px;font-weight:600;letter-spacing:.5px}
.sub{color:#7f8b9c;font-size:12px;margin-top:4px}
.sub b{color:#aab6c6;font-weight:500}
main{flex:1;display:grid;grid-template-columns:1fr 300px;min-height:0}
#stage{position:relative;min-height:0;overflow:hidden;background:#0b0e13}
#stage canvas{position:absolute;inset:0;display:block;width:100%;height:100%;cursor:grab;touch-action:none}
#stage canvas.dragging{cursor:grabbing}
.toolbar{position:absolute;left:12px;top:10px;right:12px;display:flex;gap:8px;align-items:flex-start;flex-wrap:wrap;pointer-events:none;z-index:4}
.toolbar>*{pointer-events:auto}
.slider{flex:1 1 250px;max-width:330px;background:#111722cc;border:1px solid #202a38;border-radius:8px;padding:6px 10px;display:flex;gap:8px;align-items:center;font-size:12px;color:#93a1b5}
.slider input{flex:1;accent-color:#5ea0ff}
.modes{display:flex;background:#111722cc;border:1px solid #202a38;border-radius:8px;overflow:hidden}
.modes button{background:transparent;border:0;border-right:1px solid #202a38;color:#93a1b5;font:12px/1.4 "Segoe UI","Microsoft YaHei",system-ui,sans-serif;padding:6px 9px;cursor:pointer}
.modes button:last-child{border-right:0}
.modes button:hover{color:#dce9fb}
.modes button.on{background:#20324a;color:#e6edf6}
.clearAll{height:30px;padding:0 12px;border-radius:8px;border:1px solid #2b3b52;background:#111722cc;color:#aebdd2;font:12px "Segoe UI","Microsoft YaHei",system-ui,sans-serif;cursor:pointer;white-space:nowrap}
.clearAll:hover{background:#1b2940;color:#fff}
.clearAll.on{background:#31517a;border-color:#6b9bd6;color:#fff;box-shadow:0 0 0 1px #6b9bd655 inset}
.filters{display:flex;gap:8px;align-items:center;flex-wrap:wrap;background:#111722cc;border:1px solid #202a38;border-radius:8px;padding:5px 8px;font-size:12px;color:#93a1b5}
.filters label{display:flex;gap:4px;align-items:center;cursor:pointer;white-space:nowrap}
.filters input[type=checkbox]{accent-color:#5ea0ff}
.filters select,.filters input[type=search]{background:#0d131d;border:1px solid #263244;border-radius:5px;color:#c9d5e6;font:12px "Segoe UI","Microsoft YaHei",system-ui,sans-serif;padding:2px 5px;outline:none}
.filters input[type=search]{width:150px}
.legend{flex:1 1 100%;background:#111722cc;border:1px solid #202a38;border-radius:8px;padding:5px 9px;font-size:12px;color:#93a1b5;display:flex;gap:7px;flex-wrap:wrap;align-items:center}
.legend .lg{display:inline-flex;align-items:center;gap:4px;padding:2px 5px;border-radius:5px;cursor:pointer;white-space:nowrap}
.legend .lg:hover{background:#1a2433}
.legend .lg.on{background:#20324a;color:#e6edf6}
.legend .lg.static{cursor:default}
.legend .lg.static:hover{background:transparent}
.legend .grad{display:inline-block;width:130px;height:8px;border-radius:4px;background:linear-gradient(90deg,#59d7e6,#a78bfa,#ffe6c2);vertical-align:0}
.zoombox{position:absolute;right:14px;bottom:14px;display:flex;flex-direction:column;gap:5px;z-index:5}
.zoombox button{min-width:30px;height:30px;border-radius:7px;border:1px solid #2b3b52;background:#111722e6;color:#cfdcee;font:13px/1 "Segoe UI","Microsoft YaHei",system-ui,sans-serif;cursor:pointer;padding:0 7px}
.zoombox button:hover{background:#1b2940;color:#fff}
.dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:4px;vertical-align:1px;flex:0 0 auto}
aside{border-left:1px solid #1d2430;padding:14px;overflow:auto;background:#0d1118}
aside h2{font-size:13px;margin:0 0 8px;color:#9fb0c6;font-weight:600}
#detail .text{font-size:15px;line-height:1.7;color:#e6edf6;word-break:break-word}
#detail .meta{color:#7f8b9c;font-size:12px;margin-top:10px}
#detail .row{margin-top:6px;font-size:12px;color:#93a1b5;cursor:pointer}
#detail .row:hover{color:#cfe0f5}
.empty{position:absolute;inset:0;display:flex;flex-direction:column;gap:10px;align-items:center;justify-content:center;text-align:center;padding:30px;color:#93a1b5;z-index:6;background:#0b0e13}
.empty strong{color:#d9e0ea;font-size:15px;font-weight:500}
.empty button{background:#1a2637;color:#d9e0ea;border:1px solid #2b3b52;border-radius:6px;padding:6px 14px;cursor:pointer}
.empty button:hover{background:#213149}
footer{padding:6px 18px;border-top:1px solid #1d2430;color:#5f6c7d;font-size:11px}
.hover{position:absolute;display:none;max-width:290px;background:#111722f2;border:1px solid #2b3b52;border-radius:8px;padding:9px 11px;font-size:12px;line-height:1.55;color:#d9e0ea;pointer-events:none;z-index:8;box-shadow:0 6px 24px #0008}
.hover .ht{font-size:13px;color:#e6edf6;margin-bottom:5px;word-break:break-word}
.hover .hm{color:#8b99ad}
.hover b{font-weight:500}
.status-active{color:#7fb2ff}
.status-refined{color:#f5c46b}
.status-refuted{color:#ff6b5e}
@media(max-width:820px){main{grid-template-columns:1fr}aside{position:absolute;right:0;bottom:0;width:100%;max-height:40%;border-left:0;border-top:1px solid #1d2430;background:#0d1118f2}.toolbar{flex-wrap:wrap}}
</style></head><body>
<header><h1>记忆图谱</h1><div class="sub" id="sub">正在读她的记忆…</div></header>
<main><div id="stage">
<div class="toolbar">
  <button type="button" id="clearAll" class="clearAll" title="清空所有筛选">全部</button>
  <div class="slider"><span>看到</span><input id="when" type="range" min="0" max="100" value="100" disabled><b id="whenLabel">全部</b></div>
  <div class="modes" id="modes"><button type="button" data-mode="status" class="on">状态</button><button type="button" data-mode="group">分组</button><button type="button" data-mode="time">时间</button></div>
  <div class="filters">
    <label><input id="onlyCited" type="checkbox">只看被引用过</label>
    <label>最近 <select id="recent"><option value="0">全部</option><option value="7">7 天</option><option value="30">30 天</option></select></label>
    <input id="search" type="search" placeholder="搜原话…" autocomplete="off">
  </div>
  <div class="legend" id="legend"></div>
</div>
<div class="hover" id="hover"></div>
<div class="zoombox"><button type="button" id="zoomIn" title="放大">＋</button><button type="button" id="zoomOut" title="缩小">－</button><button type="button" id="zoomReset" title="归位">归位</button></div>
<div class="empty" id="empty"><strong>读不到记忆</strong><div id="emptyWhy">插件没开、页面被挡，或者这会儿还没有数据。</div><button id="retry">再试一次</button></div>
</div>
<aside><h2>这一条</h2><div id="detail"><div class="meta">点一个点看她说的话。</div></div></aside>
</main>
<footer>只读 · 左键拖动旋转 · 右键拖动平移 · 滚轮缩放 · 数据来自 /dsh-perch/api/memory · 不写盘</footer>
<script>
(function(){
  "use strict";
  var API = "/dsh-perch/api/memory";
  var W = 1400, H = 900;
  var F = 700, CAM_Z = 350, SPHERE = 430;
  var PITCH0 = -12 * Math.PI / 180;
  var FILL = 1.136, GRAPH_W = 964, GRAPH_H = 706, SHIFT_Y = 22;
  var TIME_A = "#59d7e6", TIME_M = "#a78bfa", TIME_B = "#ffe6c2";
  var GROUP_HUES = [174, 42, 266, 334, 88, 200, 22, 316];
  var GROUP_S = .70, GROUP_L = .60;
  var ZOOM_STEP = Math.pow(3, 1/20);
  var STATUS = {
    active: { label: "在生效", color: "#7fb2ff" },
    refined: { label: "改过口", color: "#f5c46b" },
    refuted: { label: "被推翻", color: "#ff6b5e" }
  };
  var SCAR = "#d6b46a";
  var colorMode = "status", zoom = 1, panX = 0, panY = 0;
  var legendEl = document.getElementById("legend"), countEl = null;
  var clearAllBtn = document.getElementById("clearAll");
  var stage = document.getElementById("stage");
  var empty = document.getElementById("empty");
  var why = document.getElementById("emptyWhy");
  var sub = document.getElementById("sub");
  var detail = document.getElementById("detail");
  var hover = document.getElementById("hover");
  var when = document.getElementById("when");
  var whenLabel = document.getElementById("whenLabel");
  var onlyCited = document.getElementById("onlyCited");
  var recentSel = document.getElementById("recent");
  var searchBox = document.getElementById("search");
  var state = null, selected = null, hoverNode = null;
  var canvas = null, c2d = null;
  var view = { scale:1, base:1, ox:0, oy:0, cssW:W, cssH:H, dpr:1 };
  var yaw = 0.42, pitch = PITCH0;
  var drag = null, reduced = false, needsDraw = true, zoomHoldUntil = 0;
  var pointers = new Map(), pinch = null;
  var media = window.matchMedia ? window.matchMedia("(prefers-reduced-motion: reduce)") : null;
  if(media) reduced = !!media.matches;

  function esc(s){ return String(s == null ? "" : s).replace(/[&<>"]/g, function(c){ return c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : "&quot;" }) }
  function dayOf(at){ if(!at) return ""; var d = new Date(at); return isNaN(d) ? "" : (d.getMonth()+1) + "-" + d.getDate() }
  function statusOf(n){ return n && STATUS[n.status] ? n.status : "active" }
  function statusLabel(s){ return (STATUS[s] || STATUS.active).label }
  function statusColor(s){ return (STATUS[s] || STATUS.active).color }
  function hslToRgb(h,s,l){
    h = ((h % 360) + 360) % 360;
    var a = s * Math.min(l, 1-l);
    function f(n){ var k = (n + h/30) % 12; var c = l - a * Math.max(-1, Math.min(k-3, Math.min(9-k, 1))); return Math.round(255*c) }
    return "rgb(" + f(0) + "," + f(8) + "," + f(4) + ")";
  }
  function groupColor(gi){
    if(gi < 0) return hslToRgb(210, .18, .56);
    return hslToRgb(GROUP_HUES[gi % GROUP_HUES.length], GROUP_S, GROUP_L);
  }
  function parseHex(s){ var m = /^#?([0-9a-f]{6})$/i.exec(String(s)); if(!m) return [255,255,255]; var v=parseInt(m[1],16); return [v>>16&255, v>>8&255, v&255] }
  function mixHex(a,b,u){
    var p=parseHex(a), q=parseHex(b); u=clamp(u,0,1);
    return "rgb(" + Math.round(p[0]+(q[0]-p[0])*u) + "," + Math.round(p[1]+(q[1]-p[1])*u) + "," + Math.round(p[2]+(q[2]-p[2])*u) + ")";
  }
  function timeColor(t){
    if(!state || !state.__minT || !state.__maxT || state.__maxT <= state.__minT || !t) return "#a9bacd";
    var u = (t - state.__minT) / (state.__maxT - state.__minT);
    return u < .5 ? mixHex(TIME_A, TIME_M, u * 2) : mixHex(TIME_M, TIME_B, (u - .5) * 2);
  }
  function nodeColor(n){
    if(colorMode === "group") return groupColor(n.group);
    if(colorMode === "time") return timeColor(n.t);
    return n.kind === "scar" ? SCAR : statusColor(n.status);
  }
  function radiusOf(n){ var m = Math.max(0, Number(n.mentions) || 0); return 3 + Math.min(5, Math.max(0, m - 1) * 0.8) }
  function bigrams(t){ var s = String(t||"").replace(/[\s\p{P}]/gu, ""); var m = new Map(); for(var i=0;i<s.length-1;i++){ var g = s.slice(i,i+2); m.set(g,(m.get(g)||0)+1) } return m }
  function dice(a,b){ if(!a.size||!b.size) return 0; var inter=0; a.forEach(function(v,k){ if(b.has(k)) inter += Math.min(v,b.get(k)) }); var ta=0,tb=0; a.forEach(function(v){ta+=v}); b.forEach(function(v){tb+=v}); return ta+tb ? 2*inter/(ta+tb) : 0 }
  function rndFor(seed){ return function(){ seed |= 0; seed = seed + 0x6D2B79F5 | 0; var t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296 } }
  function clamp(v,a,b){ return v < a ? a : v > b ? b : v }
  function rgba(r,g,b,a){ return "rgba(" + r + "," + g + "," + b + "," + a.toFixed(3) + ")" }

  function emptyState(text){
    why.textContent = text;
    empty.style.display = "flex";
    stopLoop();
    if(canvas){ canvas.remove(); canvas = null; c2d = null }
    if(hover) hover.style.display = "none";
    sub.textContent = "没有读到数据";
  }

  function load(){
    empty.style.display = "none";
    sub.textContent = "正在读她的记忆…";
    var ctl = window.AbortController ? new AbortController() : null;
    var timer = setTimeout(function(){ if(ctl) ctl.abort() }, 8000);
    fetch(API, { cache: "no-store", signal: ctl ? ctl.signal : undefined }).then(function(r){
      if(!r.ok) throw new Error("HTTP " + r.status);
      return r.json();
    }).then(function(data){
      clearTimeout(timer);
      if(!data || !Array.isArray(data.nodes)) throw new Error("数据形状不对");
      paint(data);
    }).catch(function(err){
      clearTimeout(timer);
      emptyState("插件没开、页面被挡，或者网络断了。（" + (err && err.message ? err.message : "读不到") + "）");
    });
  }

  function softEdges(nodes, hard){
    var grams = nodes.map(function(n){ return bigrams(n.text) });
    var byGram = new Map();
    grams.forEach(function(g,i){ g.forEach(function(_,k){ var a=byGram.get(k); if(!a) byGram.set(k,a=[]); a.push(i) }) });
    var seenPair = new Set(), soft = [];
    var hardKey = new Set(); hard.forEach(function(e){ hardKey.add(e.s+"\u0000"+e.t); hardKey.add(e.t+"\u0000"+e.s) });
    byGram.forEach(function(list){
      if(list.length < 2 || list.length > 40) return;
      for(var a=0;a<list.length;a++) for(var b=a+1;b<list.length;b++){
        var i = list[a], j = list[b], k = i+"_" + j;
        if(seenPair.has(k)) continue; seenPair.add(k);
        var ni = nodes[i], nj = nodes[j];
        if(hardKey.has(ni.id+"\u0000"+nj.id)) continue;
        var s = dice(grams[i], grams[j]);
        if(s >= 0.34) soft.push({ s:ni.id, t:nj.id, w:s });
      }
    });
    if(soft.length > 900){ soft.sort(function(a,b){ return b.w-a.w }); soft = soft.slice(0,900) }
    return soft;
  }

  function paint(data){
    state = data;
    state.filter = { status:null, group:null, cited:false, recent:0, search:"", q:"" };
    colorMode = "status"; zoom = 1; panX = 0; panY = 0; yaw = 0.42; pitch = PITCH0;
    if(onlyCited) onlyCited.checked = false;
    if(recentSel) recentSel.value = "0";
    if(searchBox) searchBox.value = "";
    var nodes = data.nodes.map(function(n,i){
      return {
        id:String(n.id), kind:n.kind||"belief", text:n.text||"", at:n.at||"",
        conf:+n.conf||0.5, status:statusOf(n), mentions:Math.max(0, +n.mentions||0),
        x:0, y:0, z:0, group:-1, i:i, deg:0, t:Date.parse(n.at)||0,
        depth:.8, match:true,
        alpha:n.kind === "scar" ? .85 : (.55 + Math.min(.4, (+n.conf||0.5)*.4))
      };
    });
    var index = new Map(); nodes.forEach(function(n){ index.set(n.id,n) });
    var hard = (data.edges||[]).filter(function(e){ return (e.kind==="refuted"||e.kind==="tension") && index.has(e.s) && index.has(e.t) });
    nodes.forEach(function(n){ n.deg = 0 });
    hard.forEach(function(e){ index.get(e.s).deg++; index.get(e.t).deg++ });
    var soft = softEdges(nodes, hard);
    soft.forEach(function(e){ index.get(e.s).deg++; index.get(e.t).deg++ });
    data.__soft = soft; data.__hard = hard; data.__index = index; data.__nodes = nodes;

    var st = data.stats || {};
    var beliefCount = Number(st.beliefs);
    if(!isFinite(beliefCount)) beliefCount = nodes.filter(function(n){ return n.kind==="belief" && n.status==="active" }).length;
    var refutedCount = Number(st.refuted);
    if(!isFinite(refutedCount)) refutedCount = nodes.filter(function(n){ return n.status==="refuted" }).length;
    var refinedCount = Number(st.refined);
    if(!isFinite(refinedCount)) refinedCount = nodes.filter(function(n){ return n.status==="refined" }).length;
    var stageText = data.stage != null ? "第 <b>" + esc(String(data.stage)) + "</b> 阶段" : "阶段";
    sub.innerHTML = stageText + (data.stageName ? " · <b>" + esc(data.stageName) + "</b>" : "") + " · 判断 <b>" + beliefCount + "</b> 条 · 被推翻 <b>" + refutedCount + "</b> 处 · 改口 <b>" + refinedCount + "</b> 处 · 相近 <b>" + soft.length + "</b> 对 · 显示 <b id=\"count\">" + nodes.length + " / " + nodes.length + "</b>";
    countEl = document.getElementById("count");
    if(!nodes.length){ emptyState("这张网还没有节点。等她先说出几句判断。"); return; }

    var times = nodes.map(function(n){ return n.t }).filter(function(t){ return t>0 });
    var minT = times.length ? Math.min.apply(null,times) : 0;
    var maxT = times.length ? Math.max.apply(null,times) : 0;
    when.disabled = !(maxT > minT);
    when.min = String(minT); when.max = String(maxT); when.value = String(maxT);
    whenLabel.textContent = "全部";
    state.filterT = 0;
    state.__minT = minT; state.__maxT = maxT;

    layout3d(nodes, soft);
    state.__fit = fitCenter(nodes);
    syncModeButtons();
    renderLegend();
    ensureCanvas();
    needsDraw = true;
    draw();
    startLoop();
    var h = location.hash.match(/^#n=(.+)$/);
    if(h){
      var id = null;
      try { id = decodeURIComponent(h[1]) } catch(e) { id = null }
      if(id && index.has(id)) select(index.get(id), nodes);
    }
    window.__memoryGraph = {
      stats: function(){
        var vis = nodes.filter(function(n){ return n.visible !== false });
        var zs = vis.map(function(n){ return n.z }).sort(function(a,b){ return a-b });
        var zmin = zs.length ? zs[0] : 0, zmax = zs.length ? zs[zs.length-1] : 0;
        var lo = zmin + (zmax - zmin) / 3, hi = zmin + (zmax - zmin) * 2 / 3;
        function axis(fn){
          var vs = vis.map(fn), mn = vs.length ? Math.min.apply(null, vs) : 0, mx = vs.length ? Math.max.apply(null, vs) : 0;
          return { min:mn, max:mx, span:mx-mn };
        }
        return {
          nodes:nodes.length, visible:vis.length, matched:nodes.filter(function(n){ return !!n.match }).length,
          groups:(state.__clusters||[]).length,
          groupSizes:(state.__clusters||[]).map(function(g){ return g.members.length }).sort(function(a,b){ return a-b }),
          free:(state.__nodes||[]).filter(function(n){ return n.group < 0 }).length,
          softCross:state.__softCross || 0,
          soft:(state.__soft||[]).length, refuted:(state.__hard||[]).filter(function(e){ return e.kind === "refuted" }).length,
          tension:(state.__hard||[]).filter(function(e){ return e.kind === "tension" }).length,
          yaw:yaw, pitch:pitch, zoom:zoom, mode:colorMode, perspective:F,
          view:{ zoom:zoom, panX:panX, panY:panY, base:view.base, scale:view.scale },
          axes:{ x:axis(function(n){ return n.wx }), y:axis(function(n){ return n.wy }), z:axis(function(n){ return n.wz }) },
          filter:{ status:state.filter.status, group:state.filter.group, cited:state.filter.cited, recent:state.filter.recent, search:state.filter.search },
          reduced:reduced, dragging:!!drag,
          depthBands:{ near:vis.filter(function(n){ return n.z <= lo }).length, mid:vis.filter(function(n){ return n.z > lo && n.z <= hi }).length, far:vis.filter(function(n){ return n.z > hi }).length },
          depthRange:{ min:zmin, max:zmax }
        };
      },
      clientOf: function(i){
        var n = nodes[i]; if(!n || !canvas) return null;
        var r = canvas.getBoundingClientRect();
        return { x:r.left + view.ox + n.px*view.scale, y:r.top + view.oy + n.py*view.scale, id:n.id };
      },
      colorOf: function(i){ var n = nodes[i]; return n ? nodeColor(n) : null },
      labels: function(){
        if(!canvas) return [];
        var r = canvas.getBoundingClientRect();
        return (state.__labels||[]).map(function(l){ return { gi:l.gi, x:r.left + view.ox + l.x*view.scale, y:r.top + view.oy + l.y*view.scale, w:l.w*view.scale, h:l.h*view.scale } });
      },
      setMode: function(m){ setMode(m) },
      resetView: function(){ resetView() },
      zoomTo: function(z){ zoom = clamp(+z || 1, .5, 3); panX = 0; panY = 0; syncCanvas(); needsDraw = true; draw() }
    };
  }

  function layout3d(nodes, soft){
    var n = nodes.length;
    if(!n){ state.__clusters = []; state.__isolated = []; state.__softCross = 0; state.__nodes = nodes; return }
    // 按时间排队，切成大小不一的片段：大部分 2–3 个点，少部分 8–15 个点。
    var order = nodes.map(function(_,i){ return i }).sort(function(a,b){
      return (nodes[a].t - nodes[b].t) || (a-b);
    });
    var freeCount = Math.min(n, Math.max(10, Math.min(20, Math.round(n * .024))));
    var free = new Set();
    for(var f=0; f<freeCount; f++) free.add(order[Math.floor((f + .5) * n / freeCount)]);
    var pool = order.filter(function(i){ return !free.has(i) });
    var rnd = rndFor(0x51ed270b);
    var chunks = [];
    while(pool.length){
      var rem = pool.length, target;
      if(rem <= 15) target = rem;
      else {
        target = rnd() < .78 ? 2 + Math.floor(rnd()*2) : 8 + Math.floor(rnd()*8);
        if(target > rem) target = rem;
        if(rem - target === 1) target = target > 2 ? target - 1 : rem;
      }
      if(target < 2 && rem > 1) target = 2;
      chunks.push(pool.splice(0, target));
    }
    chunks.sort(function(a,b){ return b.length - a.length });

    var g = chunks.length, out = [];
    var rndC = rndFor(0x9e3779b9);
    chunks.forEach(function(members, gi){
      // 组心放在球体内部，半径 0.15–1.0 按立方根撒；大组靠内，外面越来越稀。
      var u = g > 1 ? gi / (g - 1) : 0;
      u = Math.pow(u, 1.35);
      var rad = SPHERE * (.15 + .85 * Math.cbrt(u));
      // 随机方向 + 低频噪声推拉，允许两组贴得很近，也允许一侧更密。
      var uu = 2*rndC() - 1, aa = rndC() * Math.PI * 2;
      var ss = Math.sqrt(Math.max(0, 1 - uu*uu));
      var cx = Math.cos(aa) * ss * rad;
      var cy = uu * rad;
      var cz = Math.sin(aa) * ss * rad;
      cx += (rndC()*2 - 1)*26 + Math.sin(gi*.73 + 1.2)*18;
      cy += (rndC()*2 - 1)*20 + Math.cos(gi*.41 + 2.2)*14;
      cz += (rndC()*2 - 1)*26 + Math.sin(gi*.57 + .4)*16;
      cy *= .86; cx *= 1.03; cz *= .94;
      var len = Math.sqrt(cx*cx + cy*cy + cz*cz);
      if(len > SPHERE*1.02){ var k = SPHERE*1.02/len; cx*=k; cy*=k; cz*=k }
      var R = 8 + 2.4 * Math.sqrt(members.length);
      var ax = R*(.72 + .5*rndC()), ay = R*(.52 + .5*rndC()), az = R*(.72 + .5*rndC());
      var rot = rndC() * Math.PI * 2, ca = Math.cos(rot), sa = Math.sin(rot);
      var c = { gi:gi, wx:cx, wy:cy, wz:cz, r:R, members:members, phase:(gi*1.7)%(Math.PI*2), visibleCount:0 };
      members.forEach(function(idx, m){
        var p = nodes[idx];
        // 第一颗贴组心，其余在一个有厚度的椭球里散开；大组留一个外沿点。
        var rr = m === 0 ? .08 : .32 + .68*Math.cbrt(rndC());
        if(members.length >= 8 && m === members.length - 1) rr = 1.18;
        var v = 2*rndC() - 1, ang = rndC() * Math.PI * 2;
        var s = Math.sqrt(Math.max(0, 1 - v*v));
        var ox = Math.cos(ang) * s * rr * ax;
        var oy = v * rr * ay;
        var oz = Math.sin(ang) * s * rr * az;
        p.wx = cx + ox*ca - oz*sa;
        p.wy = cy + oy;
        p.wz = cz + ox*sa + oz*ca;
        p.group = gi;
        p.free = false;
      });
      out.push(c);
    });

    // 10–20 个游离点不归组，哪里离组远就放哪里。
    var freeNodes = Array.from(free);
    freeNodes.forEach(function(idx){
      var p = nodes[idx], best = null, bestGap = -1e9;
      for(var a=0;a<90;a++){
        var v = 2*rndC() - 1, ang = rndC() * Math.PI * 2;
        var s = Math.sqrt(Math.max(0, 1 - v*v));
        var rad2 = SPHERE * (.2 + .72*Math.cbrt(rndC()));
        var x = Math.cos(ang) * s * rad2;
        var y = v * rad2 * .86;
        var z = Math.sin(ang) * s * rad2 * .94;
        var gap = 1e9;
        out.forEach(function(c){
          var d = Math.sqrt((x-c.wx)*(x-c.wx) + (y-c.wy)*(y-c.wy) + (z-c.wz)*(z-c.wz)) - c.r;
          if(d < gap) gap = d;
        });
        if(gap > bestGap){ bestGap = gap; best = { x:x, y:y, z:z } }
      }
      p.wx = best.x; p.wy = best.y; p.wz = best.z;
      p.group = -1; p.free = true;
    });

    state.__clusters = out;
    state.__isolated = freeNodes;
    state.__softCross = soft.filter(function(e){
      var a = state.__index.get(e.s), b = state.__index.get(e.t);
      return a && b && a.group !== b.group;
    }).length;
    state.__nodes = nodes;
  }

  function ensureCanvas(){
    if(!canvas){
      canvas = document.createElement("canvas");
      canvas.setAttribute("aria-label", "记忆图谱");
      stage.insertBefore(canvas, stage.firstChild);
      c2d = canvas.getContext("2d");
      bindCanvas();
    }
    syncCanvas();
  }

  function layoutView(){
    var s = (view.base || 1) * zoom;
    var fx = state && state.__fit ? state.__fit.cx : W/2;
    var fy = state && state.__fit ? state.__fit.cy : H/2;
    view.scale = s;
    view.ox = view.cssW/2 - fx*s + panX;
    view.oy = view.cssH/2 - fy*s + panY;
  }

  function fitCenter(nodes){
    var cy = Math.cos(yaw), sy = Math.sin(yaw), cp = Math.cos(pitch), sp = Math.sin(pitch);
    var minX = 1e9, maxX = -1e9, minY = 1e9, maxY = -1e9;
    (nodes || []).forEach(function(n){
      projectPoint(n, cy, sy, cp, sp);
      if(n.px < minX) minX = n.px;
      if(n.px > maxX) maxX = n.px;
      if(n.py < minY) minY = n.py;
      if(n.py > maxY) maxY = n.py;
    });
    if(minX > maxX) return { cx:W/2, cy:H/2 };
    return { cx:(minX+maxX)/2, cy:(minY+maxY)/2 };
  }

  function syncCanvas(){
    if(!canvas) return;
    var r = stage.getBoundingClientRect();
    var cw = Math.max(1, Math.round(r.width)), ch = Math.max(1, Math.round(r.height));
    var d = Math.min(2, window.devicePixelRatio || 1);
    if(canvas.width !== Math.round(cw*d) || canvas.height !== Math.round(ch*d)){
      canvas.width = Math.round(cw*d); canvas.height = Math.round(ch*d);
    }
    view.dpr = d; view.cssW = cw; view.cssH = ch;
    // 构图按球体投影的包围盒铺开；x/y/z 同尺度，不再沿某个轴单独拉伸。
    view.base = Math.min(cw*FILL/GRAPH_W, ch*FILL/GRAPH_H);
    layoutView();
  }

  function projectPoint(p, cy, sy, cp, sp){
    var x1 = p.wx*cy + p.wz*sy;
    var z1 = -p.wx*sy + p.wz*cy;
    var y1 = p.wy*cp - z1*sp;
    var z2 = p.wy*sp + z1*cp;
    var zz = z2 + CAM_Z;
    var s = F/(F+zz);
    if(!isFinite(s) || s < .2) s = .2;
    p.s = s;
    p.z = zz;
    p.v = clamp(s, .45, 1);
    p.depth = clamp(s, .60, 1);
    p.px = W/2 + x1*s;
    p.py = H/2 + y1*s + SHIFT_Y;
  }

  function prepare(){
    var cy = Math.cos(yaw), sy = Math.sin(yaw);
    var cp = Math.cos(pitch), sp = Math.sin(pitch);
    var ft = state.filterT || 0;
    (state.__nodes||[]).forEach(function(n){
      projectPoint(n, cy, sy, cp, sp);
      n.visible = !ft || !n.t || n.t <= ft;
    });
    (state.__clusters||[]).forEach(function(c){
      projectPoint(c, cy, sy, cp, sp);
      c.visibleCount = 0;
      c.members.forEach(function(idx){ if(state.__nodes[idx].visible) c.visibleCount++ });
    });
    markMatches();
  }

  function matchNode(n, f){
    if(!n.visible) return false;
    if(f.status){
      if(f.status === "scar"){ if(n.kind !== "scar") return false }
      else if(n.kind === "scar" || n.status !== f.status) return false;
    }
    if(f.group != null && n.group !== f.group) return false;
    if(f.cited && n.mentions < 2) return false;
    if(f.recent && (!n.t || n.t < Date.now() - f.recent*86400000)) return false;
    if(f.q && n.text.toLowerCase().indexOf(f.q) < 0) return false;
    return true;
  }

  function markMatches(){
    var f = state.filter || {};
    var has = !!(f.status || f.group != null || f.cited || f.recent || f.q);
    state.__hasFilter = has;
    var count = 0;
    (state.__nodes||[]).forEach(function(n){
      n.match = matchNode(n, f);
      if(n.match) count++;
    });
    state.__matchCount = count;
    updateCount(count, (state.__nodes||[]).length);
    updateClearButton();
  }

  function filtersActive(){
    if(!state || !state.filter) return false;
    var f = state.filter;
    return !!(f.status || f.group != null || f.cited || f.recent || f.q || state.filterT);
  }

  function updateClearButton(){
    if(clearAllBtn) clearAllBtn.classList.toggle("on", filtersActive());
  }

  function clearAllFilters(){
    if(!state) return;
    state.filter = { status:null, group:null, cited:false, recent:0, search:"", q:"" };
    state.filterT = 0;
    if(when){ when.value = Number(when.max) > Number(when.min) ? when.max : "100" }
    if(whenLabel) whenLabel.textContent = "全部";
    if(onlyCited) onlyCited.checked = false;
    if(recentSel) recentSel.value = "0";
    if(searchBox) searchBox.value = "";
    renderLegend();
    updateClearButton();
    needsDraw = true;
    draw();
  }

  function updateCount(matched, total){
    if(!countEl) countEl = document.getElementById("count");
    if(!countEl) return;
    var text = matched + " / " + total;
    if(countEl.textContent !== text) countEl.textContent = text;
  }

  function dimOf(n){
    if(!state.__hasFilter || n.match) return 1;
    return state.filter.search ? .2 : .1;
  }

  function groupDim(g){
    if(state.filter.group != null && g.gi !== state.filter.group) return .1;
    if(state.__hasFilter && !g.members.some(function(idx){ return state.__nodes[idx].match })) return state.filter.search ? .2 : .1;
    return 1;
  }

  function syncModeButtons(){
    var btns = document.querySelectorAll("#modes button");
    for(var i=0;i<btns.length;i++) btns[i].classList.toggle("on", btns[i].getAttribute("data-mode") === colorMode);
  }

  function renderLegend(){
    if(!legendEl || !state) return;
    var f = state.filter;
    if(colorMode === "status"){
      var items = [["active","判断"],["refined","改口"],["refuted","被推翻"],["scar","疤"]];
      legendEl.innerHTML = items.map(function(it){
        return '<span class="lg' + (f.status === it[0] ? " on" : "") + '" data-status="' + it[0] + '"><i class="dot" style="background:' + (it[0] === "scar" ? SCAR : statusColor(it[0])) + '"></i>' + it[1] + '</span>';
      }).join("") + '<span class="lg static"><i class="dot" style="background:#4a5a70"></i>相近</span>';
    } else if(colorMode === "group"){
      var gs = (state.__clusters || []).slice().sort(function(a,b){ return b.members.length - a.members.length });
      legendEl.innerHTML = '<span class="lg static">同组同色 · ' + gs.length + ' 组 · 点 ×N 只看一组</span>' + gs.slice(0,8).map(function(g){
        return '<span class="lg' + (f.group === g.gi ? " on" : "") + '" data-group="' + g.gi + '"><i class="dot" style="background:' + groupColor(g.gi) + '"></i>组' + (g.gi+1) + ' ×' + g.members.length + '</span>';
      }).join("");
    } else {
      legendEl.innerHTML = '<span class="lg static">颜色 = 时间</span><span class="lg static"><i class="grad"></i></span><span class="lg static">最早 · 青</span><span class="lg static">中段 · 紫</span><span class="lg static">最近 · 暖白</span>';
    }
    updateClearButton();
  }

  function setMode(m){
    if(m !== "status" && m !== "group" && m !== "time") return;
    if(colorMode !== m && m !== "status" && state) state.filter.status = null;
    colorMode = m;
    syncModeButtons();
    renderLegend();
    needsDraw = true;
    draw();
  }

  function toggleStatus(kind){
    if(!state) return;
    if(state.filter.status === kind) state.filter.status = null;
    else { state.filter.status = kind; state.filter.group = null }
    renderLegend();
    updateClearButton();
    needsDraw = true;
    draw();
  }

  function toggleGroup(gi){
    if(!state) return;
    if(state.filter.group === gi) state.filter.group = null;
    else { state.filter.group = gi; state.filter.status = null }
    renderLegend();
    updateClearButton();
    needsDraw = true;
    draw();
  }

  function draw(){
    if(!state || !canvas || !c2d) return;
    syncCanvas();
    prepare();
    var c = c2d;
    c.setTransform(view.dpr, 0, 0, view.dpr, 0, 0);
    c.clearRect(0, 0, view.cssW, view.cssH);
    var bg = c.createRadialGradient(view.cssW*.52, view.cssH*.44, view.cssH*.05, view.cssW*.52, view.cssH*.46, Math.max(view.cssW, view.cssH)*.74);
    bg.addColorStop(0, "#111a27");
    bg.addColorStop(.55, "#0d131d");
    bg.addColorStop(1, "#0b0e13");
    c.fillStyle = bg;
    c.fillRect(0, 0, view.cssW, view.cssH);
    c.save();
    c.translate(view.ox, view.oy);
    c.scale(view.scale, view.scale);
    drawGroups(c);
    drawSoft(c);
    drawHard(c);
    drawNodes(c);
    drawLabels(c);
    c.restore();
  }

  function avgTime(g){
    var sum = 0, n = 0;
    g.members.forEach(function(idx){ var t = state.__nodes[idx].t; if(t){ sum += t; n++ } });
    return n ? sum/n : 0;
  }

  function coreColor(g){
    if(colorMode === "group") return groupColor(g.gi);
    if(colorMode === "time") return timeColor(avgTime(g));
    return "#cfe2ff";
  }

  function drawGroups(c){
    var list = (state.__clusters||[]).filter(function(g){ return g.visibleCount > 0 }).sort(function(a,b){ return b.z-a.z });
    list.forEach(function(g){
      var dim = groupDim(g);
      var R = Math.max(4, g.r * g.s * 1.12);
      var glow = c.createRadialGradient(g.px, g.py, 0, g.px, g.py, R*1.95);
      var peak = (g.members.length >= 6 ? .32 : .2) * g.v * dim;
      glow.addColorStop(0, rgba(74, 126, 190, peak));
      glow.addColorStop(.62, rgba(42, 82, 138, peak*.42));
      glow.addColorStop(1, rgba(24, 42, 68, 0));
      c.globalAlpha = 1;
      c.fillStyle = glow;
      c.beginPath(); c.arc(g.px, g.py, R*1.95, 0, Math.PI*2); c.fill();
      if(g.members.length >= 6){
        c.globalAlpha = .42 * g.v * dim;
        c.strokeStyle = "rgba(96,130,174,.55)";
        c.lineWidth = .9;
        c.setLineDash([3, 5]);
        c.beginPath(); c.arc(g.px, g.py, R, 0, Math.PI*2); c.stroke();
        c.setLineDash([]);
      }
      // 组心比成员亮 1.2 倍：先铺一层光，再压一颗近白的核心。
      var cc = coreColor(g), cr = Math.max(1.7, R*.062);
      c.globalAlpha = Math.min(1, .36 * g.v * dim);
      c.fillStyle = cc;
      c.beginPath(); c.arc(g.px, g.py, cr*2.7, 0, Math.PI*2); c.fill();
      c.globalAlpha = Math.min(1, .78 * g.v * dim * 1.2);
      c.fillStyle = cc;
      c.beginPath(); c.arc(g.px, g.py, cr, 0, Math.PI*2); c.fill();
    });
  }

  function drawSoft(c){
    // 只拉跨组的软边：组内已经挤成一团，再画线只会糊掉；跨组的细丝才看得出关系。
    var list = (state.__soft||[]).map(function(e){
      var a = state.__index.get(e.s), b = state.__index.get(e.t);
      return { e:e, a:a, b:b, z:(a.z+b.z)/2 };
    }).filter(function(x){
      return x.a.visible && x.b.visible && x.a.group !== x.b.group;
    }).sort(function(a,b){ return b.z-a.z });
    c.lineWidth = .62;
    c.strokeStyle = "#7893b0";
    c.setLineDash([2, 4]);
    list.forEach(function(x){
      c.globalAlpha = (0.14 + Math.min(.26, x.e.w*.26)) * (x.a.v + x.b.v) / 2 * (dimOf(x.a) + dimOf(x.b)) / 2;
      c.beginPath(); c.moveTo(x.a.px, x.a.py); c.lineTo(x.b.px, x.b.py); c.stroke();
    });
    c.setLineDash([]);
  }

  function drawHard(c){
    var list = (state.__hard||[]).map(function(e){
      var a = state.__index.get(e.s), b = state.__index.get(e.t);
      return { e:e, a:a, b:b, z:(a.z+b.z)/2 };
    }).filter(function(x){ return x.a.visible && x.b.visible }).sort(function(a,b){ return b.z-a.z });
    list.forEach(function(x){
      var color = x.e.kind === "refuted" ? "#ff6b5e" : "#e0a44a";
      var vis = (x.a.v + x.b.v) / 2 * (dimOf(x.a) + dimOf(x.b)) / 2;
      c.lineCap = "round";
      if(x.e.kind === "refuted"){
        c.globalAlpha = .16 * vis;
        c.strokeStyle = color;
        c.lineWidth = 7;
        c.beginPath(); c.moveTo(x.a.px, x.a.py); c.lineTo(x.b.px, x.b.py); c.stroke();
      }
      c.globalAlpha = (x.e.kind === "refuted" ? .9 : .55) * vis;
      c.strokeStyle = color;
      c.lineWidth = x.e.kind === "refuted" ? 1.4 : 1;
      c.beginPath(); c.moveTo(x.a.px, x.a.py); c.lineTo(x.b.px, x.b.py); c.stroke();
      if(x.e.kind === "refuted"){
        [x.a, x.b].forEach(function(p){
          var r = 13 * p.v;
          var halo = c.createRadialGradient(p.px, p.py, 0, p.px, p.py, r);
          halo.addColorStop(0, rgba(255, 107, 94, .42 * p.v));
          halo.addColorStop(.45, rgba(255, 107, 94, .16 * p.v));
          halo.addColorStop(1, rgba(255, 107, 94, 0));
          c.globalAlpha = 1;
          c.fillStyle = halo;
          c.beginPath(); c.arc(p.px, p.py, r, 0, Math.PI*2); c.fill();
        });
      }
    });
  }

  function drawNodes(c){
    var list = (state.__nodes||[]).filter(function(n){ return n.visible }).sort(function(a,b){ return b.z-a.z });
    list.forEach(function(n){
      var r = Math.max(.7, radiusOf(n) * n.v);
      var a = n.alpha * (n.depth || 1) * (n.group < 0 ? .45 : 1) * dimOf(n);
      c.globalAlpha = a;
      c.fillStyle = nodeColor(n);
      c.beginPath(); c.arc(n.px, n.py, r, 0, Math.PI*2); c.fill();
      if(state.filter.search && n.match){
        c.globalAlpha = Math.min(1, a + .18);
        c.strokeStyle = "rgba(214,232,255,.62)";
        c.lineWidth = .9;
        c.beginPath(); c.arc(n.px, n.py, r + 1.5, 0, Math.PI*2); c.stroke();
      }
      if(selected && selected.id === n.id){
        c.globalAlpha = Math.min(1, a + .35);
        c.strokeStyle = "#fff";
        c.lineWidth = 1.6;
        c.beginPath(); c.arc(n.px, n.py, r + 2.2, 0, Math.PI*2); c.stroke();
      } else if(hoverNode && hoverNode.id === n.id){
        c.globalAlpha = Math.min(1, a + .2);
        c.strokeStyle = "rgba(255,255,255,.7)";
        c.lineWidth = 1;
        c.beginPath(); c.arc(n.px, n.py, r + 1.6, 0, Math.PI*2); c.stroke();
      }
    });
  }

  function drawLabels(c){
    c.textAlign = "center";
    c.textBaseline = "top";
    c.font = '10px "Segoe UI","Microsoft YaHei",system-ui,sans-serif';
    state.__labels = [];
    var list = (state.__clusters||[]).filter(function(g){ return g.visibleCount > 0 && g.members.length >= 6 })
      .sort(function(a,b){ return b.members.length - a.members.length }).slice(0, 8)
      .sort(function(a,b){ return a.z-b.z });
    list.forEach(function(g){
      var dim = groupDim(g);
      var R = Math.max(4, g.r * g.s * 1.12);
      var y = g.py + R + 7;
      var txt = "×" + g.members.length;
      var tw = c.measureText(txt).width;
      // 只标最大的十来组，且避开已放下的标签，不然中间会糊成一片。
      var hit = state.__labels.some(function(l){
        return Math.abs(l.x - g.px) < (l.w + tw + 18)/2 && Math.abs(l.y - y) < 18;
      });
      if(hit) return;
      state.__labels.push({ gi:g.gi, x:g.px, y:y-2, w:tw+12, h:15 });
      c.globalAlpha = .62 * g.v * dim;
      c.fillStyle = colorMode === "group" ? groupColor(g.gi) : "rgb(172,194,220)";
      c.fillText(txt, g.px, y);
    });
  }

  function pickNode(ev){
    if(!canvas || !state) return null;
    var rect = canvas.getBoundingClientRect();
    var x = (ev.clientX - rect.left - view.ox) / view.scale;
    var y = (ev.clientY - rect.top - view.oy) / view.scale;
    var best = null, bd = 8 / Math.max(.2, view.scale);
    (state.__nodes||[]).forEach(function(n){
      if(!n.visible) return;
      var d = Math.hypot(n.px - x, n.py - y);
      if(d < bd){ bd = d; best = n }
    });
    return best;
  }

  function pickLabel(ev){
    if(!canvas || !state || !state.__labels) return null;
    var rect = canvas.getBoundingClientRect();
    var x = (ev.clientX - rect.left - view.ox) / view.scale;
    var y = (ev.clientY - rect.top - view.oy) / view.scale;
    for(var i=state.__labels.length-1;i>=0;i--){
      var l = state.__labels[i];
      if(Math.abs(x - l.x) <= l.w/2 && y >= l.y-2 && y <= l.y+l.h) return l;
    }
    return null;
  }

  // 缩放只有一个变量 zoom：视图始终按 base * zoom 重算，不在上一帧结果上再乘。
  // 锚点是视图中心，所以只改 zoom，panX/panY 不动，中心点不会跑。
  function setZoom(next){
    var prev = zoom;
    zoom = clamp(next, .5, 3);
    // 平移是屏幕像素，跟着缩放一起收放，视图中心那个点才会原地不动。
    if(prev > 0){ var ratio = zoom / prev; panX *= ratio; panY *= ratio }
    zoomHoldUntil = Date.now() + 240;
    layoutView();
    needsDraw = true;
    draw();
  }

  function zoomStep(f){ setZoom(zoom * f) }

  function resetView(){
    zoom = 1; panX = 0; panY = 0; yaw = 0.42; pitch = PITCH0;
    if(state && state.__nodes) state.__fit = fitCenter(state.__nodes);
    zoomHoldUntil = Date.now() + 240;
    syncCanvas();
    needsDraw = true;
    draw();
  }

  function bindCanvas(){
    canvas.addEventListener("pointerdown", function(ev){
      if(ev.pointerType === "mouse" && ev.button !== 0 && ev.button !== 2) return;
      ev.preventDefault();
      pointers.set(ev.pointerId, { x:ev.clientX, y:ev.clientY });
      try { canvas.setPointerCapture(ev.pointerId) } catch(e) {}
      if(pointers.size >= 2){
        var pts = Array.from(pointers.values());
        pinch = { dist:Math.max(1, Math.hypot(pts[0].x-pts[1].x, pts[0].y-pts[1].y)), zoom:zoom, cx:(pts[0].x+pts[1].x)/2, cy:(pts[0].y+pts[1].y)/2 };
        drag = null; hoverNode = null; hideHover();
        canvas.classList.remove("dragging");
        return;
      }
      var isPan = ev.pointerType === "mouse" && ev.button === 2;
      drag = { id:ev.pointerId, mode:isPan ? "pan" : "rotate", x:ev.clientX, y:ev.clientY, yaw:yaw, pitch:pitch, panX:panX, panY:panY, moved:false };
      hoverNode = null; hideHover();
      canvas.classList.add("dragging");
    });
    canvas.addEventListener("contextmenu", function(ev){ ev.preventDefault() });
    canvas.addEventListener("pointermove", function(ev){
      if(pointers.has(ev.pointerId)) pointers.set(ev.pointerId, { x:ev.clientX, y:ev.clientY });
      if(pinch && pointers.size >= 2){
        var pts = Array.from(pointers.values());
        var d = Math.max(1, Math.hypot(pts[0].x-pts[1].x, pts[0].y-pts[1].y));
        setZoom(pinch.zoom * d / pinch.dist);
        return;
      }
      if(drag && drag.id === ev.pointerId){
        var dx = ev.clientX - drag.x, dy = ev.clientY - drag.y;
        if(Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
        if(drag.mode === "pan"){
          panX = drag.panX + dx;
          panY = drag.panY + dy;
        } else {
          yaw = drag.yaw + dx * .006;
          pitch = clamp(drag.pitch + dy * .004, -1, 1);
        }
        needsDraw = true;
        draw();
        return;
      }
      var lab = pickLabel(ev);
      if(lab){ canvas.style.cursor = "pointer"; hideHover(); return }
      var n = pickNode(ev);
      if(n !== hoverNode){ hoverNode = n; draw() }
      if(n){ showHover(n, ev); canvas.style.cursor = "pointer" }
      else { hideHover(); canvas.style.cursor = "grab" }
    });
    function endDrag(ev, cancelled){
      pointers.delete(ev.pointerId);
      if(pinch){ if(pointers.size < 2) pinch = null; return }
      if(!drag || drag.id !== ev.pointerId) return;
      var moved = drag.moved, wasPan = drag.mode === "pan";
      drag = null;
      canvas.classList.remove("dragging");
      try { canvas.releasePointerCapture(ev.pointerId) } catch(e) {}
      if(moved || cancelled || wasPan) return;
      var lab = pickLabel(ev);
      if(lab) toggleGroup(lab.gi);
      else select(pickNode(ev), state.__nodes);
    }
    canvas.addEventListener("pointerup", function(ev){ endDrag(ev, false) });
    canvas.addEventListener("pointercancel", function(ev){ endDrag(ev, true) });
    canvas.addEventListener("pointerleave", function(){
      if(drag || pinch) return;
      if(hoverNode){ hoverNode = null; draw() }
      hideHover();
      canvas.style.cursor = "grab";
    });
    canvas.addEventListener("wheel", function(ev){
      ev.preventDefault();
      setZoom(zoom * Math.exp(-ev.deltaY * .0015));
    }, { passive:false });
    canvas.addEventListener("dblclick", function(ev){ ev.preventDefault(); resetView() });
  }

  function startLoop(){
    stopLoop();
    var prev = 0;
    function step(ts){
      if(!state || !canvas){ state.__raf = 0; return }
      var dt = prev ? Math.min(.1, (ts - prev) / 1000) : 0;
      prev = ts;
      if(!document.hidden){
        if(!drag && !pinch && Date.now() > zoomHoldUntil && !reduced && dt > 0){
          yaw += .02 * dt;
          needsDraw = true;
        }
        if(needsDraw){
          needsDraw = false;
          draw();
        }
      }
      state.__raf = requestAnimationFrame(step);
    }
    state.__raf = requestAnimationFrame(step);
  }

  function stopLoop(){
    if(state && state.__raf){ cancelAnimationFrame(state.__raf); state.__raf = 0 }
  }

  function showHover(n, ev){
    if(!hover || !n) return;
    var s = statusOf(n);
    hover.innerHTML = '<div class="ht">' + esc(n.text || "（没留下原话）") + '</div>' +
      '<div class="hm"><span class="status-' + s + '">' + esc(statusLabel(s)) + '</span> · 被引用 ' + (Number(n.mentions)||0) + ' 次 · ' + esc(dayOf(n.at) || "时间不明") + '</div>';
    hover.style.display = "block";
    moveHover(ev);
  }
  function moveHover(ev){
    if(!hover || hover.style.display === "none") return;
    var rect = stage.getBoundingClientRect();
    var x = ev.clientX - rect.left + 14, y = ev.clientY - rect.top + 14;
    if(x + hover.offsetWidth + 10 > rect.width) x = ev.clientX - rect.left - hover.offsetWidth - 14;
    if(y + hover.offsetHeight + 10 > rect.height) y = ev.clientY - rect.top - hover.offsetHeight - 14;
    hover.style.left = Math.max(6, x) + "px";
    hover.style.top = Math.max(6, y) + "px";
  }
  function hideHover(){ if(hover) hover.style.display = "none" }

  function select(node, nodes){
    selected = node || null;
    hideHover();
    if(!node){ detail.innerHTML = "<div class=\"meta\">点一个点看她说的话。</div>"; history.replaceState(null,"",location.pathname+location.search); draw(); return; }
    var nb = [];
    (state.__hard||[]).forEach(function(e){
      if(e.s===node.id) nb.push([e.t, e.kind === "refuted" ? "被推翻" : "对不上"]);
      else if(e.t===node.id) nb.push([e.s, e.kind === "refuted" ? "被推翻" : "对不上"]);
    });
    (state.__soft||[]).filter(function(e){ return e.s===node.id||e.t===node.id }).sort(function(a,b){return b.w-a.w}).slice(0,8).forEach(function(e){ nb.push([e.s===node.id?e.t:e.s, "相近 " + e.w.toFixed(2)]) });
    var s = statusOf(node);
    var html = "<div class=\"text\">" + esc(node.text) + "</div>" +
      "<div class=\"meta\">" + (node.kind==="scar" ? "疤" : "判断") + " · <span class=\"status-" + s + "\">" + esc(statusLabel(s)) + "</span> · " + esc(dayOf(node.at)) + " · 被引用 " + (Number(node.mentions)||0) + " 次 · 把握 " + Math.round(node.conf*100) + "% · " + node.deg + " 条连线</div>";
    if(nb.length){
      html += "<h2 style=\"margin-top:16px\">连着的</h2>";
      nb.slice(0,10).forEach(function(x){
        var n2 = state.__index.get(x[0]); if(!n2) return;
        html += "<div class=\"row\" data-go=\"" + esc(n2.id) + "\">" + esc((n2.text||"").slice(0,26)) + " · " + esc(x[1]) + "</div>";
      });
    }
    detail.innerHTML = html;
    var rows = detail.querySelectorAll("[data-go]");
    for(var r=0;r<rows.length;r++) rows[r].addEventListener("click", function(){
      var n2 = state.__index.get(this.getAttribute("data-go")); if(n2) select(n2, nodes);
    });
    history.replaceState(null,"", "#n=" + encodeURIComponent(node.id));
    draw();
  }

  when && when.addEventListener("input", function(){
    if(!state) return;
    var t = Number(when.value), max = Number(when.max);
    state.filterT = t && !(max > 0 && t >= max) ? t : 0;
    whenLabel.textContent = state.filterT ? dayOf(new Date(state.filterT).toISOString()) : "全部";
    updateClearButton();
    draw();
  });

  var modesEl = document.getElementById("modes");
  if(modesEl) modesEl.addEventListener("click", function(ev){
    var btn = ev.target && ev.target.closest ? ev.target.closest("[data-mode]") : null;
    if(btn) setMode(btn.getAttribute("data-mode"));
  });

  if(legendEl) legendEl.addEventListener("click", function(ev){
    var el = ev.target && ev.target.closest ? ev.target.closest("[data-status],[data-group]") : null;
    if(!el) return;
    var s = el.getAttribute("data-status"), g = el.getAttribute("data-group");
    if(s) toggleStatus(s);
    else if(g != null) toggleGroup(Number(g));
  });

  if(onlyCited) onlyCited.addEventListener("change", function(){
    if(!state) return;
    state.filter.cited = !!onlyCited.checked;
    draw();
  });
  if(recentSel) recentSel.addEventListener("change", function(){
    if(!state) return;
    state.filter.recent = Math.max(0, Number(recentSel.value) || 0);
    draw();
  });
  if(searchBox) searchBox.addEventListener("input", function(){
    if(!state) return;
    state.filter.search = searchBox.value;
    state.filter.q = searchBox.value.trim().toLowerCase();
    draw();
  });

  if(clearAllBtn) clearAllBtn.addEventListener("click", clearAllFilters);

  document.getElementById("zoomIn").addEventListener("click", function(){ zoomStep(ZOOM_STEP) });
  document.getElementById("zoomOut").addEventListener("click", function(){ zoomStep(1/ZOOM_STEP) });
  document.getElementById("zoomReset").addEventListener("click", resetView);

  if(media && media.addEventListener){
    media.addEventListener("change", function(e){ reduced = !!e.matches });
  }
  window.addEventListener("resize", function(){ if(canvas) draw() });

  document.getElementById("retry").addEventListener("click", load);
  load();
})();
</script></body></html>`;