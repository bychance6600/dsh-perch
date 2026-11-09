/**
 * memory-page.js —— 记忆图谱的独立页面（/dsh-roost/memory）。
 *
 * 为什么单独一个文件：这个页面不走设置页那棵树，浏览器地址栏直接打开也能看。
 * 数据只从 /dsh-roost/api/memory 取；取不到（插件没开、被挡、断网）就给一句空态，
 * 不留白屏。页面上没有任何写操作。
 *
 * 约束：不引外部字体/脚本/图片，断网时除数据外整页可用。
 */

export const MEMORY_PAGE = String.raw`<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>记忆图谱 · dsh-roost</title>
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
#stage{position:relative;min-height:0;overflow:hidden}
#stage svg{display:block;width:100%;height:100%;cursor:grab}
#stage svg.dragging{cursor:grabbing}
.toolbar{position:absolute;left:12px;top:10px;right:12px;display:flex;gap:12px;align-items:center;pointer-events:none;z-index:4}
.toolbar>*{pointer-events:auto}
.slider{flex:1;max-width:420px;background:#111722cc;border:1px solid #202a38;border-radius:8px;padding:6px 10px;display:flex;gap:8px;align-items:center;font-size:12px;color:#93a1b5}
.slider input{flex:1;accent-color:#5ea0ff}
.legend{background:#111722cc;border:1px solid #202a38;border-radius:8px;padding:6px 10px;font-size:12px;color:#93a1b5;display:flex;gap:10px;flex-wrap:wrap}
.dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:4px;vertical-align:1px}
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
line.soft{stroke:#3a4a60;stroke-width:.6}
line.refuted{stroke:#ff6b5e;stroke-width:1.4;stroke-opacity:.9}
line.tension{stroke:#e0a44a;stroke-width:1;stroke-opacity:.55}
circle.node{cursor:pointer;stroke:#0b0e13;stroke-width:.7}
circle.node.sel{stroke:#fff;stroke-width:1.6}
circle.cluster-ring{fill:none;stroke:#2a3a50;stroke-width:1;stroke-dasharray:3 5;stroke-opacity:.55}
circle.cluster-core{fill:#24364d;stroke:#5f7fa6;stroke-width:1;stroke-opacity:.75}
text.day{fill:#6d7b8e;font-size:10px}
.hover{position:absolute;display:none;max-width:290px;background:#111722f2;border:1px solid #2b3b52;border-radius:8px;padding:9px 11px;font-size:12px;line-height:1.55;color:#d9e0ea;pointer-events:none;z-index:8;box-shadow:0 6px 24px #0008}
.hover .ht{font-size:13px;color:#e6edf6;margin-bottom:5px;word-break:break-word}
.hover .hm{color:#8b99ad}
.hover b{font-weight:500}
.status-active{color:#7fb2ff}
.status-refined{color:#e0a44a}
.status-refuted{color:#ff6b5e}
@media(max-width:820px){main{grid-template-columns:1fr}aside{position:absolute;right:0;bottom:0;width:100%;max-height:40%;border-left:0;border-top:1px solid #1d2430;background:#0d1118f2}.toolbar{flex-wrap:wrap}}
</style></head><body>
<header><h1>记忆图谱</h1><div class="sub" id="sub">正在读她的记忆…</div></header>
<main><div id="stage">
<div class="toolbar">
  <div class="slider"><span>看到</span><input id="when" type="range" min="0" max="100" value="100" disabled><b id="whenLabel">全部</b></div>
  <div class="legend"><span><i class="dot" style="background:#7fb2ff"></i>判断</span><span><i class="dot" style="background:#e0a44a"></i>改口</span><span><i class="dot" style="background:#ff6b5e"></i>被推翻</span><span><i class="dot" style="background:#d6b46a"></i>疤</span><span><i class="dot" style="background:#4a5a70"></i>相近</span></div>
</div>
<div class="hover" id="hover"></div>
<div class="empty" id="empty"><strong>读不到记忆</strong><div id="emptyWhy">插件没开、页面被挡，或者这会儿还没有数据。</div><button id="retry">再试一次</button></div>
</div>
<aside><h2>这一条</h2><div id="detail"><div class="meta">点一个点看她说的话。</div></div></aside>
</main>
<footer>只读 · 数据来自 /dsh-roost/api/memory · 不写盘</footer>
<script>
(function(){
  var API = "/dsh-roost/api/memory";
  var W = 1400, H = 900;
  var NS = "http://www.w3.org/2000/svg";
  var STATUS = {
    active: { label: "在生效", color: "#7fb2ff" },
    refined: { label: "改过口", color: "#e0a44a" },
    refuted: { label: "被推翻", color: "#ff6b5e" }
  };
  var SCAR = "#d6b46a";
  var stage = document.getElementById("stage");
  var empty = document.getElementById("empty");
  var why = document.getElementById("emptyWhy");
  var sub = document.getElementById("sub");
  var detail = document.getElementById("detail");
  var hover = document.getElementById("hover");
  var when = document.getElementById("when");
  var whenLabel = document.getElementById("whenLabel");
  var state = null, selected = null;

  function esc(s){ return String(s == null ? "" : s).replace(/[&<>"]/g, function(c){ return c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : "&quot;" }) }
  function dayOf(at){ if(!at) return ""; var d = new Date(at); return isNaN(d) ? "" : (d.getMonth()+1) + "-" + d.getDate() }
  function statusOf(n){ return n && STATUS[n.status] ? n.status : "active" }
  function statusLabel(s){ return (STATUS[s] || STATUS.active).label }
  function statusColor(s){ return (STATUS[s] || STATUS.active).color }
  function nodeColor(n){ return n.kind === "scar" ? SCAR : statusColor(n.status) }
  function radiusOf(n){ var m = Math.max(0, Number(n.mentions) || 0); return 3 + Math.min(5, Math.max(0, m - 1) * 0.8) }
  function bigrams(t){ var s = String(t||"").replace(/[\s\p{P}]/gu, ""); var m = new Map(); for(var i=0;i<s.length-1;i++){ var g = s.slice(i,i+2); m.set(g,(m.get(g)||0)+1) } return m }
  function dice(a,b){ if(!a.size||!b.size) return 0; var inter=0; a.forEach(function(v,k){ if(b.has(k)) inter += Math.min(v,b.get(k)) }); var ta=0,tb=0; a.forEach(function(v){ta+=v}); b.forEach(function(v){tb+=v}); return ta+tb ? 2*inter/(ta+tb) : 0 }
  function rndFor(seed){ return function(){ seed |= 0; seed = seed + 0x6D2B79F5 | 0; var t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296 } }

  function emptyState(text){
    why.textContent = text;
    empty.style.display = "flex";
    var old = stage.querySelector("svg"); if(old) old.remove();
    if(hover) hover.style.display = "none";
    stage.appendChild(empty);
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
    var nodes = data.nodes.map(function(n,i){
      return {
        id:String(n.id), kind:n.kind||"belief", text:n.text||"", at:n.at||"",
        conf:+n.conf||0.5, status:statusOf(n), mentions:Math.max(0, +n.mentions||0),
        x:0, y:0, bx:0, by:0, group:-1, i:i, deg:0
      };
    });
    var index = new Map(); nodes.forEach(function(n){ index.set(n.id,n) });
    var hard = (data.edges||[]).filter(function(e){ return (e.kind==="refuted"||e.kind==="tension") && index.has(e.s) && index.has(e.t) });
    nodes.forEach(function(n){ n.deg = 0 });
    hard.forEach(function(e){ index.get(e.s).deg++; index.get(e.t).deg++ });
    var soft = softEdges(nodes, hard);
    soft.forEach(function(e){ index.get(e.s).deg++; index.get(e.t).deg++ });
    data.__soft = soft; data.__hard = hard; data.__index = index;

    var st = data.stats || {};
    var beliefCount = Number(st.beliefs);
    if(!isFinite(beliefCount)) beliefCount = nodes.filter(function(n){ return n.kind==="belief" && n.status==="active" }).length;
    var refutedCount = Number(st.refuted);
    if(!isFinite(refutedCount)) refutedCount = nodes.filter(function(n){ return n.status==="refuted" }).length;
    var refinedCount = Number(st.refined);
    if(!isFinite(refinedCount)) refinedCount = nodes.filter(function(n){ return n.status==="refined" }).length;
    var ev = Number(data.events)||0;
    var stageText = data.stage != null ? "第 <b>" + esc(String(data.stage)) + "</b> 阶段" : "阶段";
    sub.innerHTML = stageText + (data.stageName ? " · <b>" + esc(data.stageName) + "</b>" : "") + " · 判断 <b>" + beliefCount + "</b> 条 · 被推翻 <b>" + refutedCount + "</b> 处 · 改口 <b>" + refinedCount + "</b> 处 · 相近 <b>" + soft.length + "</b> 对";
    if(!nodes.length){ emptyState("这张网还没有节点。等她先说出几句判断。"); return; }

    var times = nodes.map(function(n){ return Date.parse(n.at)||0 }).filter(function(t){ return t>0 });
    var minT = times.length ? Math.min.apply(null,times) : 0;
    var maxT = times.length ? Math.max.apply(null,times) : 0;
    when.disabled = !(maxT > minT);
    when.min = String(minT); when.max = String(maxT); when.value = String(maxT);
    whenLabel.textContent = "全部";

    layout(nodes, soft);
    draw(nodes);
    bind(nodes);
    startDrift(nodes);
    var h = location.hash.match(/^#n=(.+)$/);
    if(h && index.has(decodeURIComponent(h[1]))) select(index.get(decodeURIComponent(h[1])), nodes);
  }

  function layout(nodes, soft){
    var parent = new Int32Array(nodes.length);
    for(var i=0;i<nodes.length;i++) parent[i] = i;
    function find(x){ while(parent[x] !== x){ parent[x] = parent[parent[x]]; x = parent[x] } return x }
    soft.forEach(function(e){
      var a = nodes.findIndex(function(n){ return n.id === e.s });
      var b = nodes.findIndex(function(n){ return n.id === e.t });
      if(a < 0 || b < 0) return;
      a = find(a); b = find(b); if(a !== b) parent[b] = a;
    });
    var groups = new Map();
    for(var k=0;k<nodes.length;k++){
      var root = find(k); var arr = groups.get(root);
      if(!arr) groups.set(root, arr = []);
      arr.push(k);
    }
    var clusters = [], isolated = [];
    groups.forEach(function(members){ if(members.length >= 2) clusters.push(members); else isolated.push(members[0]) });
    clusters.sort(function(a,b){ return b.length - a.length });

    var g = clusters.length;
    var ring = g <= 1 ? 0 : Math.min(470, 120 + 16*g);
    var rx = ring, ry = ring * 0.62;
    var out = [];
    clusters.forEach(function(members, gi){
      var a = g <= 1 ? 0 : (-Math.PI/2 + gi*2*Math.PI/g);
      var cx = W/2 + Math.cos(a)*rx, cy = H/2 + Math.sin(a)*ry;
      var R = 14 + 8*Math.sqrt(members.length);
      var phase = (gi*1.7) % (Math.PI*2);
      var c = { gi:gi, cx:cx, cy:cy, bx:cx, by:cy, x:cx, y:cy, r:R, phase:phase, members:members };
      members.forEach(function(idx, m){
        var p = nodes[idx], ang = m*2.399963 + gi*1.3;
        var rr = R * Math.sqrt((m + 0.45) / members.length);
        p.bx = cx + Math.cos(ang)*rr; p.by = cy + Math.sin(ang)*rr;
        p.x = p.bx; p.y = p.by; p.group = gi;
      });
      out.push(c);
    });

    var rnd = rndFor(0x9e3779b9);
    isolated.forEach(function(idx){
      var p = nodes[idx], x = W/2, y = H/2, ok = false;
      for(var t=0;t<40 && !ok;t++){
        x = 56 + rnd()*(W-112); y = 56 + rnd()*(H-112); ok = true;
        for(var c=0;c<out.length;c++){
          var dx = x-out[c].cx, dy = y-out[c].cy, rr = out[c].r + 38;
          if(dx*dx + dy*dy < rr*rr){ ok = false; break }
        }
      }
      p.bx = x; p.by = y; p.x = x; p.y = y; p.group = -1;
    });

    state.__clusters = out;
    state.__isolated = isolated;
  }

  function draw(nodes){
    if(state.__raf){ cancelAnimationFrame(state.__raf); state.__raf = 0 }
    var old = stage.querySelector("svg"); if(old) old.remove();
    var svg = document.createElementNS(NS,"svg");
    svg.setAttribute("viewBox", "0 0 " + W + " " + H);
    svg.setAttribute("preserveAspectRatio","xMidYMid meet");
    var gEdge = document.createElementNS(NS,"g"), gGroup = document.createElementNS(NS,"g"), gNode = document.createElementNS(NS,"g");

    (state.__clusters||[]).forEach(function(c){
      var ring = document.createElementNS(NS,"circle");
      ring.setAttribute("class","cluster-ring");
      ring.setAttribute("cx", c.x.toFixed(2)); ring.setAttribute("cy", c.y.toFixed(2));
      ring.setAttribute("r", (c.r + 13).toFixed(2)); ring.dataset.gi = c.gi;
      var sz = c.members.length;
      // 大组要一眼看出来；两三个点的组只是连线关系，环压淡一点，免得铺满屏幕。
      ring.style.strokeOpacity = sz >= 6 ? ".9" : (sz >= 3 ? ".65" : ".26");
      if(sz >= 3){
        ring.style.fill = "#162234";
        ring.style.fillOpacity = sz >= 6 ? ".5" : ".32";
      }
      gGroup.appendChild(ring);
      var core = document.createElementNS(NS,"circle");
      core.setAttribute("class","cluster-core");
      core.setAttribute("cx", c.x.toFixed(2)); core.setAttribute("cy", c.y.toFixed(2));
      core.setAttribute("r", "4"); core.dataset.gi = c.gi;
      gGroup.appendChild(core);
    });

    (state.__soft||[]).forEach(function(e){
      var a=state.__index.get(e.s), b=state.__index.get(e.t);
      var l=document.createElementNS(NS,"line");
      l.setAttribute("class","soft"); l.setAttribute("x1",a.x);l.setAttribute("y1",a.y);l.setAttribute("x2",b.x);l.setAttribute("y2",b.y); l.__a=a.id; l.__b=b.id;
      l.setAttribute("stroke-opacity", (0.18 + Math.min(0.5, e.w*0.5)).toFixed(2));
      gEdge.appendChild(l);
    });
    (state.__hard||[]).forEach(function(e){
      var a=state.__index.get(e.s), b=state.__index.get(e.t);
      var l=document.createElementNS(NS,"line");
      l.setAttribute("class", e.kind === "refuted" ? "refuted" : "tension");
      l.setAttribute("x1",a.x);l.setAttribute("y1",a.y);l.setAttribute("x2",b.x);l.setAttribute("y2",b.y); l.__a=a.id; l.__b=b.id;
      gEdge.appendChild(l);
    });

    nodes.forEach(function(p){
      var c=document.createElementNS(NS,"circle");
      c.setAttribute("class","node");
      c.setAttribute("r", radiusOf(p).toFixed(2));
      c.setAttribute("cx", p.x.toFixed(2)); c.setAttribute("cy", p.y.toFixed(2));
      c.setAttribute("fill", nodeColor(p));
      c.setAttribute("fill-opacity", p.kind==="scar" ? ".85" : (.55 + Math.min(.4, (p.conf||0)*.4)).toFixed(2));
      c.dataset.id = p.id;
      c.addEventListener("mouseenter", function(ev){ showHover(p, ev) });
      c.addEventListener("mousemove", moveHover);
      c.addEventListener("mouseleave", hideHover);
      gNode.appendChild(c);
    });

    svg.appendChild(gEdge); svg.appendChild(gGroup); svg.appendChild(gNode);
    stage.appendChild(svg);
    svg.addEventListener("click", function(ev){ if(ev.target === svg) select(null, nodes) });
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

  function startDrift(nodes){
    if(state.__raf){ cancelAnimationFrame(state.__raf); state.__raf = 0 }
    var last = 0;
    function step(ts){
      if(ts - last > 55 && !document.hidden){
        last = ts;
        var t = ts / 1000;
        (state.__clusters||[]).forEach(function(c){
          c.x = c.bx + Math.sin(t*0.07 + c.phase) * 7;
          c.y = c.by + Math.cos(t*0.055 + c.phase*1.7) * 5;
          c.members.forEach(function(idx){ var p=nodes[idx]; p.x = p.bx + (c.x-c.bx); p.y = p.by + (c.y-c.by) });
        });
        var svg = stage.querySelector("svg");
        if(svg){
          var circles = svg.querySelectorAll("circle.node");
          for(var i=0;i<circles.length;i++){
            var p = state.__index.get(circles[i].dataset.id); if(!p) continue;
            circles[i].setAttribute("cx", p.x.toFixed(2)); circles[i].setAttribute("cy", p.y.toFixed(2));
          }
          var rings = svg.querySelectorAll(".cluster-ring,.cluster-core");
          for(var r=0;r<rings.length;r++){
            var c = state.__clusters[+rings[r].dataset.gi]; if(!c) continue;
            rings[r].setAttribute("cx", c.x.toFixed(2)); rings[r].setAttribute("cy", c.y.toFixed(2));
          }
          var lines = svg.querySelectorAll("line");
          for(var l=0;l<lines.length;l++){
            var a = state.__index.get(lines[l].__a), b = state.__index.get(lines[l].__b);
            if(!a || !b) continue;
            lines[l].setAttribute("x1", a.x.toFixed(2)); lines[l].setAttribute("y1", a.y.toFixed(2));
            lines[l].setAttribute("x2", b.x.toFixed(2)); lines[l].setAttribute("y2", b.y.toFixed(2));
          }
        }
      }
      state.__raf = requestAnimationFrame(step);
    }
    state.__raf = requestAnimationFrame(step);
  }

  function bind(nodes){
    var svg = stage.querySelector("svg"); if(!svg) return;
    svg.addEventListener("click", function(e){
      var id = e.target && e.target.dataset ? e.target.dataset.id : null;
      if(!id) return;
      select(state.__index.get(id), nodes);
    });
    var box = { x:0, y:0, vx:0, vy:0, down:false, sx:0, sy:0, cx:0, cy:0 };
    svg.addEventListener("pointerdown", function(e){
      if(e.target !== svg) return;
      box.down = true; box.sx = e.clientX; box.sy = e.clientY;
      var vb = svg.viewBox.baseVal; box.cx = vb.x; box.cy = vb.y;
      hideHover();
      svg.classList.add("dragging");
    });
    window.addEventListener("pointermove", function(e){
      if(!box.down) return;
      var vb = svg.viewBox.baseVal, rect = svg.getBoundingClientRect();
      var k = vb.width / Math.max(1, rect.width);
      vb.x = box.cx - (e.clientX - box.sx) * k;
      vb.y = box.cy - (e.clientY - box.sy) * k;
    });
    window.addEventListener("pointerup", function(){ box.down = false; svg.classList.remove("dragging") });
    svg.addEventListener("wheel", function(e){
      e.preventDefault();
      var vb = svg.viewBox.baseVal, rect = svg.getBoundingClientRect();
      var mx = vb.x + (e.clientX-rect.left)/rect.width*vb.width;
      var my = vb.y + (e.clientY-rect.top)/rect.height*vb.height;
      var f = e.deltaY > 0 ? 1.12 : 1/1.12;
      vb.width *= f; vb.height *= f;
      vb.x = mx - (mx-vb.x)*f; vb.y = my - (my-vb.y)*f;
    }, {passive:false});
  }

  function select(node, nodes){
    selected = node;
    hideHover();
    var marks = stage.querySelectorAll("circle.node.sel");
    for(var i=0;i<marks.length;i++) marks[i].classList.remove("sel");
    if(!node){ detail.innerHTML = "<div class=\"meta\">点一个点看她说的话。</div>"; history.replaceState(null,"",location.pathname+location.search); return; }
    var all = stage.querySelectorAll("circle.node");
    for(var ci=0;ci<all.length;ci++) if(all[ci].dataset.id === node.id) all[ci].classList.add("sel");
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
  }

  when && when.addEventListener("input", function(){
    var t = Number(when.value);
    var svg = stage.querySelector("svg"); if(!svg || !state) return;
    var vis = {};
    var circles = svg.querySelectorAll("circle.node");
    for(var i=0;i<circles.length;i++){
      var n = state.__index.get(circles[i].dataset.id);
      var at = n ? (Date.parse(n.at)||0) : 0;
      var on = !t || !at || at <= t;
      circles[i].style.display = on ? "" : "none";
      if(on) vis[circles[i].dataset.id] = 1;
    }
    var ls = svg.querySelectorAll("line");
    for(var j=0;j<ls.length;j++){
      var l = ls[j];
      l.style.display = (vis[l.__a] && vis[l.__b]) ? "" : "none";
    }
    whenLabel.textContent = t ? dayOf(new Date(t).toISOString()) : "全部";
  });

  document.getElementById("retry").addEventListener("click", load);
  load();
})();
</script></body></html>`;
