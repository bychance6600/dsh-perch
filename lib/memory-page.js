/**
 * memory-page.js —— 记忆图谱（神经生长）。
 *
 * 页面不走设置页那棵树，浏览器直接打开 /dsh-perch/memory 也能看。
 * 数据只读 /dsh-perch/api/memory；不写盘、不调宿主 API、不引外部脚本/字体/图片。
 *
 * 布局与派生都是纯函数（memoryCore），页面用它内联一份字符串，
 * 这样测试与浏览器看到的是同一套坐标与排序。
 */
export function memoryCore() {
  var TYPE_ORDER = ['belief', 'utterance', 'heard'];
  var TYPE = {
    belief: { label: '判断', color: '#7ec8ff', alpha: 1, radius: 2.8 },
    utterance: { label: '她说过的话', color: '#ce90ff', alpha: 0.95, radius: 2.4 },
    heard: { label: '听过的话', color: '#56708f', alpha: 0.45, radius: 1.45 },
    scar: { label: '疤', color: '#ffe9c7', alpha: 0.95, radius: 3.2 }
  };

  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }

  function rngFor(seed) {
    var s = seed >>> 0;
    return function () {
      s = (s + 0x6D2B79F5) >>> 0;
      var t = s;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function normalizeKind(kind) {
    var k = String(kind == null ? '' : kind).toLowerCase();
    if (k === 'scar') return 'scar';
    if (k === 'heard' || k === 'listen' || k === 'listened') return 'heard';
    if (k === 'utterance' || k === 'said' || k === 'voice' || k === 'her') return 'utterance';
    return 'belief';
  }

  function typeKeyOf(node) {
    return node && node.kind === 'scar' ? 'belief' : (node && node.kind ? node.kind : 'belief');
  }

  function dateText(at) {
    if (!at) return '日期不明';
    var d = new Date(at);
    if (isNaN(d)) return String(at).slice(0, 10);
    function p(n) { return n < 10 ? '0' + n : String(n); }
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  }

  function shortDate(at) {
    if (!at) return '';
    var d = new Date(at);
    if (isNaN(d)) return String(at).slice(0, 10);
    return (d.getMonth() + 1) + '-' + d.getDate();
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return c === '&' ? '&amp;' : (c === '<' ? '&lt;' : (c === '>' ? '&gt;' : '&quot;'));
    });
  }

  function fitEllipse(x, y, rx, ry) {
    var q = (x / rx) * (x / rx) + (y / ry) * (y / ry);
    if (q > 1) {
      var f = 1 / Math.sqrt(q);
      return { x: x * f, y: y * f };
    }
    return { x: x, y: y };
  }

  function layout(nodes, opts) {
    opts = opts || {};
    var count = nodes ? nodes.length : 0;
    if (!count) return { points: [], branches: [], attractors: 0, steps: 0, rx: 0, ry: 0 };
    var W = Number(opts.width) || 1440;
    var H = Number(opts.height) || 900;
    var RX = W * 0.42;
    var RY = H * 0.40;
    var STEP = 7;
    var INFLUENCE = 42;
    var KILL = STEP * 1.25;
    var rnd = rngFor((opts.seed == null ? 0x9e3779b9 : opts.seed) >>> 0);
    var attractorCount = Math.max(1, Math.round(count * 0.55));
    var att = [];
    var i, j;
    for (i = 0; i < attractorCount; i++) {
      var ang = rnd() * Math.PI * 2;
      var rad = Math.sqrt(rnd());
      att.push({ x: Math.cos(ang) * rad * RX, y: Math.sin(ang) * rad * RY, alive: true });
    }

    var points = [{ x: 0, y: 0, parent: -1, depth: 0 }];
    var branches = [];
    var cell = INFLUENCE;
    var grid = Object.create(null);

    function key(ix, iy) { return ix + ',' + iy; }

    function addGrid(idx) {
      var p = points[idx];
      var ix = Math.floor(p.x / cell);
      var iy = Math.floor(p.y / cell);
      var k = key(ix, iy);
      if (!grid[k]) grid[k] = [];
      grid[k].push(idx);
    }
    addGrid(0);

    function stepToward(parentIdx, target) {
      var p = points[parentIdx];
      var dx = target.x - p.x;
      var dy = target.y - p.y;
      var len = Math.sqrt(dx * dx + dy * dy) || 1;
      var curl = (rnd() - 0.5) * 0.18;
      var ang = Math.atan2(dy, dx) + curl;
      var nx = p.x + Math.cos(ang) * STEP;
      var ny = p.y + Math.sin(ang) * STEP;
      var q = (nx / (RX * 0.985)) * (nx / (RX * 0.985)) + (ny / (RY * 0.985)) * (ny / (RY * 0.985));
      if (q > 1) {
        var f = 1 / Math.sqrt(q);
        nx *= f;
        ny *= f;
      }
      return { x: nx, y: ny };
    }

    function pushPoint(parentIdx, target) {
      var pos = stepToward(parentIdx, target);
      var idx = points.length;
      points.push({ x: pos.x, y: pos.y, parent: parentIdx, depth: points[parentIdx].depth + 1 });
      branches.push({ s: parentIdx, t: idx });
      addGrid(idx);
      if (Math.sqrt((target.x - pos.x) * (target.x - pos.x) + (target.y - pos.y) * (target.y - pos.y)) < KILL) {
        target.alive = false;
      }
      return idx;
    }

    var guard = 0;
    while (points.length < count && guard++ < count * 20) {
      var targetDist = [];
      var targetAtt = [];
      for (var ai = 0; ai < att.length; ai++) {
        var at = att[ai];
        if (!at.alive) continue;
        var ix = Math.floor(at.x / cell);
        var iy = Math.floor(at.y / cell);
        var best = -1;
        var bestD = INFLUENCE * INFLUENCE;
        for (var gx = -1; gx <= 1; gx++) {
          for (var gy = -1; gy <= 1; gy++) {
            var bucket = grid[key(ix + gx, iy + gy)];
            if (!bucket) continue;
            for (var bi = 0; bi < bucket.length; bi++) {
              var pi = bucket[bi];
              var pp = points[pi];
              var dd = (pp.x - at.x) * (pp.x - at.x) + (pp.y - at.y) * (pp.y - at.y);
              if (dd < bestD) { bestD = dd; best = pi; }
            }
          }
        }
        if (best >= 0 && (targetDist[best] === undefined || bestD < targetDist[best])) {
          targetDist[best] = bestD;
          targetAtt[best] = ai;
        }
      }

      var keys = [];
      for (i = 0; i < points.length; i++) if (targetDist[i] !== undefined) keys.push(i);

      if (!keys.length) {
        var pickAi = -1;
        var offset = Math.floor(rnd() * att.length);
        for (j = 0; j < att.length; j++) {
          var cand = (offset + j) % att.length;
          if (att[cand].alive) { pickAi = cand; break; }
        }
        if (pickAi < 0) break;
        var seedTarget = att[pickAi];
        var near = 0;
        var nearD = Infinity;
        for (i = 0; i < points.length; i++) {
          var pp2 = points[i];
          var d2 = (pp2.x - seedTarget.x) * (pp2.x - seedTarget.x) + (pp2.y - seedTarget.y) * (pp2.y - seedTarget.y);
          if (d2 < nearD) { nearD = d2; near = i; }
        }
        pushPoint(near, seedTarget);
        continue;
      }

      for (i = keys.length - 1; i > 0; i--) {
        j = Math.floor(rnd() * (i + 1));
        var swap = keys[i]; keys[i] = keys[j]; keys[j] = swap;
      }

      var added = 0;
      for (var ki = 0; ki < keys.length && points.length < count; ki++) {
        var parentIdx = keys[ki];
        var ai2 = targetAtt[parentIdx];
        var target = att[ai2];
        if (!target.alive) continue;
        pushPoint(parentIdx, target);
        added++;
      }
      if (!added) break;
    }

    while (points.length < count) {
      var last = points[points.length - 1];
      var fall = Math.atan2(last.y, last.x) + 0.42;
      var nx2 = last.x + Math.cos(fall) * STEP;
      var ny2 = last.y + Math.sin(fall) * STEP;
      var q2 = (nx2 / (RX * 0.985)) * (nx2 / (RX * 0.985)) + (ny2 / (RY * 0.985)) * (ny2 / (RY * 0.985));
      if (q2 > 1) {
        var f2 = 1 / Math.sqrt(q2);
        nx2 *= f2;
        ny2 *= f2;
      }
      var idx2 = points.length;
      points.push({ x: nx2, y: ny2, parent: idx2 - 1, depth: last.depth + 1 });
      branches.push({ s: idx2 - 1, t: idx2 });
    }

    return { points: points, branches: branches, attractors: attractorCount, steps: points.length - 1, rx: RX, ry: RY };
  }

  function buildModel(raw, opts) {
    opts = opts || {};
    var src = raw && Array.isArray(raw.nodes) ? raw.nodes : (Array.isArray(raw) ? raw : []);
    var nodes = src.map(function (n, i) {
      var kind = normalizeKind(n && n.kind);
      var status = n && (n.status === 'refuted' || n.status === 'refined') ? n.status : 'active';
      var text = String(n && n.text != null ? n.text : '').slice(0, 240);
      return {
        id: String(n && n.id != null ? n.id : ('n' + i)),
        kind: kind,
        typeKey: kind === 'scar' ? 'belief' : kind,
        text: text,
        at: String((n && (n.at || n.ts || n.when || n.day)) || ''),
        source: String((n && (n.source || n.origin || n.channel)) || ''),
        status: kind === 'scar' ? 'active' : status,
        supersededBy: n && n.supersededBy ? String(n.supersededBy) : '',
        mentions: Math.max(0, Number(n && n.mentions) || 0),
        conf: Number(n && n.conf) || 0.5,
        raw: n
      };
    });
    var lay = layout(nodes, opts);
    var byId = Object.create(null);
    var i;
    for (i = 0; i < nodes.length; i++) {
      nodes[i].x = lay.points[i].x;
      nodes[i].y = lay.points[i].y;
      nodes[i].depth = lay.points[i].depth;
      byId[nodes[i].id] = nodes[i];
    }

    var edges = [];
    var seenEdge = Object.create(null);
    function addEdge(s, t, kind, w) {
      if (!byId[s] || !byId[t] || s === t) return;
      var k = String(s) + '\u0000' + String(t) + '\u0000' + kind;
      if (seenEdge[k]) return;
      seenEdge[k] = 1;
      edges.push({ s: String(s), t: String(t), kind: kind, w: Number(w) || 1 });
    }
    var rawEdges = raw && Array.isArray(raw.edges) ? raw.edges : [];
    rawEdges.forEach(function (e) {
      if (!e) return;
      var kind = e.kind === 'refuted' ? 'refuted' : (e.kind === 'revise' ? 'revise' : (e.kind === 'tension' ? 'tension' : ''));
      if (!kind) return;
      addEdge(String(e.s == null ? '' : e.s), String(e.t == null ? '' : e.t), kind, e.w == null ? 1 : e.w);
    });
    nodes.forEach(function (n) {
      if (n.supersededBy && byId[n.supersededBy]) {
        addEdge(n.id, n.supersededBy, n.status === 'refuted' ? 'refuted' : 'revise', 1);
      }
    });

    var stats = {
      nodes: nodes.length,
      belief: nodes.filter(function (n) { return n.kind === 'belief'; }).length,
      utterance: nodes.filter(function (n) { return n.kind === 'utterance'; }).length,
      heard: nodes.filter(function (n) { return n.kind === 'heard'; }).length,
      scar: nodes.filter(function (n) { return n.kind === 'scar'; }).length,
      refuted: nodes.filter(function (n) { return n.status === 'refuted'; }).length,
      refined: nodes.filter(function (n) { return n.status === 'refined'; }).length,
      cited: nodes.filter(function (n) { return n.mentions >= 2; }).length,
      revise: edges.filter(function (e) { return e.kind === 'revise'; }).length
    };

    var metaCounts = raw && raw.meta && raw.meta.counts ? raw.meta.counts : null;
    return { nodes: nodes, byId: byId, edges: edges, branches: lay.branches, layout: lay, stats: stats, metaCounts: metaCounts };
  }

  function searchHit(node, q) {
    if (!q) return true;
    var needle = String(q).toLowerCase();
    if (!needle) return true;
    if (String(node.text || '').toLowerCase().indexOf(needle) >= 0) return true;
    if (String(node.source || '').toLowerCase().indexOf(needle) >= 0) return true;
    if (String(TYPE[node.kind] ? TYPE[node.kind].label : '').toLowerCase().indexOf(needle) >= 0) return true;
    return false;
  }

  function matchNode(node, filter) {
    filter = filter || {};
    if (filter.types && filter.types[typeKeyOf(node)] === false) return false;
    if (filter.onlyCited && (node.mentions || 0) < 2) return false;
    if (!searchHit(node, filter.q)) return false;
    return true;
  }

  function nodeAlpha(node, filter) {
    if (!matchNode(node, filter)) return 0;
    var info = TYPE[node.kind] || TYPE.belief;
    var a = info.alpha;
    if (filter && filter.q && !searchHit(node, filter.q)) a *= 0.12;
    return clamp(a, 0, 1);
  }

  function chainRows(node, model) {
    var out = [];
    var seen = Object.create(null);
    function add(oldNode, freshNode) {
      if (!oldNode || !freshNode || oldNode.id === freshNode.id) return;
      var k = oldNode.id + '\u0000' + freshNode.id;
      if (seen[k]) return;
      seen[k] = 1;
      out.push({ old: oldNode, fresh: freshNode });
    }
    if (node.supersededBy && model.byId[node.supersededBy]) add(node, model.byId[node.supersededBy]);
    (model.edges || []).forEach(function (e) {
      if (e.kind !== 'revise' && e.kind !== 'refuted') return;
      if (e.s === node.id) add(model.byId[e.s], model.byId[e.t]);
      else if (e.t === node.id) add(model.byId[e.s], model.byId[e.t]);
    });
    return out;
  }

  function panelHtml(node, model) {
    if (!node) return '<div class="pempty">点一个点看她说的话。</div>';
    var info = TYPE[node.kind] || TYPE.belief;
    var rows = chainRows(node, model);
    var html = '<div class="ptext">' + esc(node.text || '（没留下原话）') + '</div>' +
      '<div class="pmeta"><span class="ptype">' + esc(info.label) + '</span><span>' + esc(dateText(node.at)) + '</span><span>出处：' + esc(node.source || '账本') + '</span></div>';
    if (rows.length) {
      html += '<div class="pchain"><div class="pchain-h">她改过这里</div><div class="pchain-flow">原话 → 改口 → 现话</div>';
      rows.slice(0, 8).forEach(function (r) {
        html += '<div class="pchain-row"><s>' + esc(r.old.text || '旧句') + '</s><span class="parrow">→</span><span>' + esc(r.fresh.text || '现话') + '</span></div>';
      });
      html += '</div>';
    }
    return html;
  }

  return {
    TYPE: TYPE,
    TYPE_ORDER: TYPE_ORDER,
    clamp: clamp,
    rngFor: rngFor,
    normalizeKind: normalizeKind,
    typeKeyOf: typeKeyOf,
    dateText: dateText,
    shortDate: shortDate,
    layout: layout,
    buildModel: buildModel,
    searchHit: searchHit,
    matchNode: matchNode,
    nodeAlpha: nodeAlpha,
    chainRows: chainRows,
    panelHtml: panelHtml
  };
}

const coreSrc = memoryCore.toString();

export const MEMORY_PAGE = String.raw`<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>记忆图谱 · dsh-perch</title>
<style>
:root{color-scheme:dark}
*{box-sizing:border-box}
html,body{margin:0;height:100%;background:#070b11;color:#d9e0ea;font:14px/1.5 "Segoe UI","Microsoft YaHei",system-ui,sans-serif}
body{display:flex;flex-direction:column;overflow:hidden}
header{padding:13px 20px 10px;border-bottom:1px solid #172231;background:#080d15}
h1{margin:0;font-size:17px;font-weight:600;letter-spacing:.5px}
.sub{color:#77869a;font-size:12px;margin-top:4px;min-height:18px}
.sub b{color:#b8c7da;font-weight:500}
main{position:relative;flex:1;min-height:0;overflow:hidden}
#stage{position:absolute;inset:0;overflow:hidden;background:radial-gradient(ellipse at 52% 46%,#101b2a 0%,#0a1019 45%,#070b11 100%)}
#stage canvas{position:absolute;inset:0;display:block;width:100%;height:100%;cursor:grab;touch-action:none}
#stage canvas.dragging{cursor:grabbing}
.toolbar{position:absolute;left:16px;top:14px;right:16px;display:flex;gap:8px;align-items:center;flex-wrap:wrap;z-index:4;pointer-events:none}
.toolbar>*{pointer-events:auto}
.types{display:flex;gap:3px;background:#0d1622e6;border:1px solid #1e2d40;border-radius:9px;padding:3px;box-shadow:0 6px 22px #0004}
.type{border:0;background:transparent;color:#b7c5d7;font:12px/1.3 "Segoe UI","Microsoft YaHei",system-ui,sans-serif;padding:6px 9px;border-radius:6px;cursor:pointer;display:flex;align-items:center;gap:5px;white-space:nowrap}
.type:hover{background:#162438;color:#eef6ff}
.type.off{opacity:.34}
.type i{width:7px;height:7px;border-radius:50%;display:inline-block;box-shadow:0 0 9px currentColor}
.search{display:flex;align-items:center;background:#0d1622e6;border:1px solid #1e2d40;border-radius:9px;padding:0 9px;height:32px;box-shadow:0 6px 22px #0004}
.search input{width:164px;background:transparent;border:0;outline:0;color:#d9e6f6;font:12px "Segoe UI","Microsoft YaHei",system-ui,sans-serif;padding:0}
.search input::placeholder{color:#5e6f83}
.cited{display:flex;align-items:center;gap:5px;height:32px;padding:0 10px;background:#0d1622e6;border:1px solid #1e2d40;border-radius:9px;color:#a9b9cc;font-size:12px;cursor:pointer;white-space:nowrap}
.cited input{accent-color:#7ec8ff}
.clearAll{height:32px;padding:0 12px;border-radius:9px;border:1px solid #24364b;background:#0d1622e6;color:#aebdd2;font:12px "Segoe UI","Microsoft YaHei",system-ui,sans-serif;cursor:pointer;white-space:nowrap}
.clearAll:hover{background:#17263a;color:#fff}
.clearAll.on{background:#244266;border-color:#6b9bd6;color:#fff}
.zoombox{position:absolute;right:16px;bottom:16px;display:flex;flex-direction:column;gap:5px;z-index:5}
.zoombox button{min-width:30px;height:30px;border-radius:7px;border:1px solid #26384e;background:#0c1420e6;color:#cfdcee;font:13px/1 "Segoe UI","Microsoft YaHei",system-ui,sans-serif;cursor:pointer;padding:0 7px}
.zoombox button:hover{background:#17263a;color:#fff}
.empty{position:absolute;inset:0;display:flex;flex-direction:column;gap:10px;align-items:center;justify-content:center;text-align:center;padding:30px;color:#93a1b5;z-index:6;background:#070b11}
.empty strong{color:#d9e0ea;font-size:15px;font-weight:500}
.empty button{background:#16263a;color:#d9e0ea;border:1px solid #2b3b52;border-radius:6px;padding:6px 14px;cursor:pointer}
.empty button:hover{background:#203149}
.hover{position:absolute;display:none;max-width:310px;background:#0b1420f4;border:1px solid #29405a;border-radius:9px;padding:10px 12px;font-size:12px;line-height:1.55;color:#d9e0ea;pointer-events:none;z-index:8;box-shadow:0 10px 30px #0008}
.hover .ht{font-size:13px;color:#eef6ff;margin-bottom:5px;word-break:break-word}
.hover .hm{color:#8b99ad;word-break:break-word}
.panel{position:absolute;top:0;right:0;bottom:0;width:340px;background:#0a111bfa;border-left:1px solid #1e2d40;z-index:9;transform:translateX(100%);transition:transform .22s ease;display:flex;flex-direction:column;box-shadow:-12px 0 30px #0005}
.panel.open{transform:translateX(0)}
.panel-tab{position:absolute;left:-38px;top:50%;transform:translateY(-50%);width:38px;height:118px;border:1px solid #29405a;border-right:0;border-radius:9px 0 0 9px;background:#0d1724f2;color:#b9cbe0;font:12px/1.25 "Segoe UI","Microsoft YaHei",system-ui,sans-serif;cursor:pointer;writing-mode:vertical-rl;letter-spacing:2px;padding:8px 0}
.panel-tab:hover{background:#16263a;color:#fff}
.panel-body{display:flex;flex-direction:column;min-height:0;height:100%}
.panel-head{display:flex;align-items:center;justify-content:space-between;padding:15px 16px 10px;border-bottom:1px solid #172331}
.panel-head h2{font-size:13px;margin:0;color:#a9bdd4;font-weight:600}
.panel-close{border:0;background:transparent;color:#72849a;font-size:12px;cursor:pointer;padding:4px}
.panel-close:hover{color:#dbe8f7}
#detail{padding:16px;overflow:auto;min-height:0}
.ptext{font-size:15px;line-height:1.7;color:#eef6ff;word-break:break-word}
.pmeta{display:flex;flex-wrap:wrap;gap:6px;color:#7f8fa3;font-size:12px;margin-top:12px;line-height:1.5}
.pmeta span{padding:2px 6px;border-radius:4px;background:#101b29;border:1px solid #1b2a3b}
.ptype{color:#9fc9ee}
.pchain{margin-top:18px;border-top:1px solid #172331;padding-top:14px}
.pchain-h{font-size:12px;color:#bda1ff;letter-spacing:.5px}
.pchain-flow{font-size:11px;color:#5f7289;margin:4px 0 10px}
.pchain-row{font-size:13px;line-height:1.6;color:#dce9f8;margin-top:8px;word-break:break-word}
.pchain-row s{color:#75879d;text-decoration-color:#a26bff;text-decoration-thickness:1px}
.parrow{color:#b58cff;margin:0 7px}
.pempty{color:#7f8fa3;font-size:12px}
footer{padding:6px 20px;border-top:1px solid #172231;color:#5f6c7d;font-size:11px;background:#080d15}
@media(max-width:820px){
  header{padding:11px 14px 8px}
  .toolbar{left:10px;right:10px;top:10px;gap:6px}
  .search input{width:118px}
  .type{padding:6px 7px}
  .panel{top:auto;bottom:0;width:100%;height:58%;border-left:0;border-top:1px solid #1e2d40;transform:translateY(100%);box-shadow:0 -12px 30px #0006}
  .panel.open{transform:translateY(0)}
  .panel-tab{left:auto;right:14px;top:-34px;width:auto;height:34px;border:1px solid #29405a;border-bottom:0;border-radius:9px 9px 0 0;writing-mode:horizontal-tb;padding:0 12px;letter-spacing:0}
}
</style></head><body>
<header><h1>记忆图谱</h1><div class="sub" id="sub">正在读她的记忆…</div></header>
<main><div id="stage">
<div class="toolbar">
  <div class="types" id="types">
    <button type="button" class="type" data-kind="belief"><i style="background:#7ec8ff;color:#7ec8ff"></i>判断</button>
    <button type="button" class="type" data-kind="utterance"><i style="background:#ce90ff;color:#ce90ff"></i>她说过的话</button>
    <button type="button" class="type" data-kind="heard"><i style="background:#56708f;color:#56708f"></i>听过的话</button>
  </div>
  <label class="search"><input id="search" type="search" placeholder="搜原话、出处…" autocomplete="off"></label>
  <label class="cited"><input id="onlyCited" type="checkbox">只看被引用过</label>
  <button type="button" id="clearAll" class="clearAll">全部</button>
</div>
<div class="hover" id="hover"></div>
<div class="zoombox"><button type="button" id="zoomIn" title="放大">＋</button><button type="button" id="zoomOut" title="缩小">－</button><button type="button" id="zoomReset" title="归位">归位</button></div>
<div class="empty" id="empty"><strong>读不到记忆</strong><div id="emptyWhy">插件没开、页面被挡，或者这会儿还没有数据。</div><button id="retry">再试一次</button></div>
<aside id="panel" class="panel" aria-hidden="true">
  <button type="button" id="panelTab" class="panel-tab" aria-expanded="false">这一条 ◀</button>
  <div class="panel-body"><div class="panel-head"><h2>这一条</h2><button type="button" id="panelClose" class="panel-close">收起</button></div><div id="detail"><div class="pempty">点一个点看她说的话。</div></div></div>
</aside>
</div></main>
<footer>只读 · 左键拖动平移 · 滚轮缩放 · 颜色是事件的种类，枝干是生长顺序，不是论断之间的关系 · 数据来自 /dsh-perch/api/memory · 不写盘</footer>
<script>
(function(){
  "use strict";
  var CORE = (${coreSrc})();
  var API = "/dsh-perch/api/memory";
  var W = 1440, H = 900;
  var stage = document.getElementById("stage");
  var sub = document.getElementById("sub");
  var empty = document.getElementById("empty");
  var why = document.getElementById("emptyWhy");
  var canvas = null, ctx = null;
  var model = null;
  var selectedId = null;
  var hoverId = null;
  var panelOpen = false;
  var filter = { types: { belief: true, utterance: true, heard: true }, onlyCited: false, q: "" };
  var view = { cssW: W, cssH: H, dpr: 1, base: 1, zoom: 1, panX: 0, panY: 0 };
  var pointers = new Map();
  var drag = null, pinch = null;
  var hover = document.getElementById("hover");
  var panel = document.getElementById("panel");
  var panelTab = document.getElementById("panelTab");
  var detail = document.getElementById("detail");

  function $(id){ return document.getElementById(id) }
  function esc(s){ return String(s == null ? "" : s).replace(/[&<>"]/g, function(c){ return c === "&" ? "&amp;" : (c === "<" ? "&lt;" : (c === ">" ? "&gt;" : "&quot;")) }) }
  function clamp(v,a,b){ return v < a ? a : (v > b ? b : v) }

  function ensureCanvas(){
    if(canvas) return;
    canvas = document.createElement("canvas");
    canvas.setAttribute("aria-label", "记忆图谱");
    canvas.setAttribute("role", "img");
    stage.insertBefore(canvas, stage.firstChild);
    ctx = canvas.getContext("2d");
    bindCanvas();
  }

  function syncSize(){
    ensureCanvas();
    var r = stage.getBoundingClientRect();
    var cw = Math.max(1, Math.round(r.width));
    var ch = Math.max(1, Math.round(r.height));
    var dpr = Math.min(2, window.devicePixelRatio || 1);
    if(canvas.width !== Math.round(cw * dpr) || canvas.height !== Math.round(ch * dpr)){
      canvas.width = Math.round(cw * dpr);
      canvas.height = Math.round(ch * dpr);
    }
    view.cssW = cw; view.cssH = ch; view.dpr = dpr;
    view.base = Math.min(cw / W, ch / H);
  }

  function toWorld(clientX, clientY){
    var r = canvas.getBoundingClientRect();
    var s = view.base * view.zoom;
    return {
      x: (clientX - r.left - view.cssW / 2 - view.panX) / s,
      y: (clientY - r.top - view.cssH / 2 - view.panY) / s
    };
  }

  function pick(clientX, clientY){
    if(!model) return null;
    var p = toWorld(clientX, clientY);
    var best = null;
    var bd = 8 / Math.max(0.2, view.base * view.zoom);
    for(var i=0;i<model.nodes.length;i++){
      var n = model.nodes[i];
      if(!CORE.matchNode(n, filter)) continue;
      var d = Math.sqrt((n.x - p.x) * (n.x - p.x) + (n.y - p.y) * (n.y - p.y));
      if(d < bd){ bd = d; best = n }
    }
    return best;
  }

  function typeOn(n){ return filter.types[n.typeKey] !== false }

  function countMatched(){
    if(!model) return 0;
    var c = 0;
    for(var i=0;i<model.nodes.length;i++) if(CORE.matchNode(model.nodes[i], filter)) c++;
    return c;
  }

  function updateCount(){
    var total = model ? model.nodes.length : 0;
    var matched = countMatched();
    var el = document.getElementById("count");
    if(el) el.textContent = matched + " / " + total;
    var clear = document.getElementById("clearAll");
    if(clear){
      var on = !!filter.q || filter.onlyCited || filter.types.belief === false || filter.types.utterance === false || filter.types.heard === false;
      clear.classList.toggle("on", on);
    }
    var btns = document.querySelectorAll("#types [data-kind]");
    for(var i=0;i<btns.length;i++) btns[i].classList.toggle("off", filter.types[btns[i].getAttribute("data-kind")] === false);
  }

  function renderSub(){
    if(!model) return;
    var st = model.stats;
    sub.innerHTML = (model.stage != null ? "第 <b>" + esc(String(model.stage)) + "</b> 阶段" : "她的账本")
      + (model.stageName ? " · <b>" + esc(model.stageName) + "</b>" : "")
      + " · 判断 <b>" + st.belief + "</b> 条"
      + " · 她说过的话 <b>" + (model.metaCounts && model.metaCounts.utterance != null ? model.metaCounts.utterance : st.utterance) + "</b> 条"
      + (model.metaCounts && model.metaCounts.utterance > st.utterance ? "（图上 " + st.utterance + " 句，其余已长成判断）" : "")
      + " · 听过的话 <b>" + (model.metaCounts && model.metaCounts.heard != null ? model.metaCounts.heard : st.heard) + "</b> 条"
      + " · 显示 <b id=\"count\">" + countMatched() + " / " + model.nodes.length + "</b>";
  }

  function draw(){
    if(!model || !ctx) return;
    syncSize();
    var c = ctx;
    var cw = view.cssW, ch = view.cssH;
    c.setTransform(view.dpr, 0, 0, view.dpr, 0, 0);
    c.clearRect(0, 0, cw, ch);
    var bg = c.createRadialGradient(cw * 0.5, ch * 0.44, 0, cw * 0.5, ch * 0.48, Math.max(cw, ch) * 0.76);
    bg.addColorStop(0, "#101b2a");
    bg.addColorStop(0.5, "#0a1019");
    bg.addColorStop(1, "#070b11");
    c.fillStyle = bg;
    c.fillRect(0, 0, cw, ch);

    c.save();
    c.translate(cw / 2 + view.panX, ch / 2 + view.panY);
    var s = view.base * view.zoom;
    c.scale(s, s);
    drawBranches(c);
    drawHard(c);
    drawNodes(c);
    c.restore();
  }

  function drawBranches(c){
    if(!model || !model.branches.length) return;
    var on = [];
    var dim = [];
    for(var i=0;i<model.branches.length;i++){
      var b = model.branches[i];
      var a = model.nodes[b.s], z = model.nodes[b.t];
      if(!a || !z) continue;
      var av = typeOn(a), zv = typeOn(z);
      if(!av && !zv) continue;
      (av && zv ? on : dim).push(b);
    }
    function strokeList(list, color, width, alpha){
      if(!list.length) return;
      c.globalAlpha = alpha;
      c.strokeStyle = color;
      c.lineWidth = width;
      c.lineCap = "round";
      c.beginPath();
      for(var i=0;i<list.length;i++){
        var b = list[i], a = model.nodes[b.s], z = model.nodes[b.t];
        c.moveTo(a.x, a.y);
        c.lineTo(z.x, z.y);
      }
      c.stroke();
    }
    c.setLineDash([]);
    strokeList(dim, "rgba(88,116,158,0.05)", 0.8, 1);
    strokeList(on, "rgba(88,116,158,0.16)", 0.8, 1);
    c.globalAlpha = 1;
  }

  function drawHard(c){
    if(!model) return;
    var list = [];
    for(var i=0;i<model.edges.length;i++){
      var e = model.edges[i];
      var a = model.byId[e.s];
      var z = model.byId[e.t];
      if(!a || !z) continue;
      if(!typeOn(a) || !typeOn(z)) continue;
      list.push({ e:e, a:a, z:z });
    }
    list.sort(function(p,q){ return p.a.x + p.z.x - (q.a.x + q.z.x) });
    for(var k=0;k<list.length;k++){
      var x = list[k], e = x.e;
      var isRevise = e.kind==="revise";
      var isRefuted = e.kind === "refuted";
      c.lineCap = "round";
      c.setLineDash([]);
      if(isRefuted){
        c.globalAlpha = 0.12;
        c.strokeStyle = "#ff6b5e";
        c.lineWidth = 7;
        c.beginPath(); c.moveTo(x.a.x, x.a.y); c.lineTo(x.z.x, x.z.y); c.stroke();
        c.globalAlpha = 0.82;
        c.strokeStyle = "#ff6b5e";
        c.lineWidth = 1.25;
        c.beginPath(); c.moveTo(x.a.x, x.a.y); c.lineTo(x.z.x, x.z.y); c.stroke();
      } else if(isRevise){
        var mx = (x.a.x + x.z.x) / 2;
        var my = (x.a.y + x.z.y) / 2;
        var dx = x.z.x - x.a.x, dy = x.z.y - x.a.y;
        var len = Math.sqrt(dx * dx + dy * dy) || 1;
        var bend = Math.min(34, len * 0.16);
        var cx = mx - dy / len * bend;
        var cy = my + dx / len * bend;
        c.globalAlpha = 0.16;
        c.strokeStyle = "#b58cff";
        c.lineWidth = 5;
        c.beginPath(); c.moveTo(x.a.x, x.a.y); c.quadraticCurveTo(cx, cy, x.z.x, x.z.y); c.stroke();
        c.globalAlpha = 0.9;
        c.strokeStyle = "#c9a6ff";
        c.lineWidth = 1.15;
        c.beginPath(); c.moveTo(x.a.x, x.a.y); c.quadraticCurveTo(cx, cy, x.z.x, x.z.y); c.stroke();
        var ang = Math.atan2(x.z.y - cy, x.z.x - cx);
        var tipX = x.z.x - Math.cos(ang) * 4;
        var tipY = x.z.y - Math.sin(ang) * 4;
        c.globalAlpha = 0.9;
        c.fillStyle = "#c9a6ff";
        c.beginPath();
        c.moveTo(tipX, tipY);
        c.lineTo(tipX - Math.cos(ang - 0.45) * 4, tipY - Math.sin(ang - 0.45) * 4);
        c.lineTo(tipX - Math.cos(ang + 0.45) * 4, tipY - Math.sin(ang + 0.45) * 4);
        c.closePath(); c.fill();
      } else {
        c.globalAlpha = 0.3;
        c.strokeStyle = "#e0a44a";
        c.lineWidth = 0.9;
        c.setLineDash([3, 5]);
        c.beginPath(); c.moveTo(x.a.x, x.a.y); c.lineTo(x.z.x, x.z.y); c.stroke();
        c.setLineDash([]);
      }
    }
    c.globalAlpha = 1;
  }

  function nodeAlpha(n){
    if(!CORE.matchNode(n, filter)) return 0;
    var a = CORE.nodeAlpha(n, filter);
    if(selectedId && selectedId !== n.id) a *= 0.62;
    return a;
  }

  function drawNodes(c){
    var order = [];
    var kinds = { heard: 0, belief: 1, utterance: 2, scar: 3 };
    for(var i=0;i<model.nodes.length;i++){
      var n = model.nodes[i];
      if(!CORE.matchNode(n, filter) && !selectedId) continue;
      order.push(n);
    }
    order.sort(function(a,b){ return (kinds[a.kind] || 0) - (kinds[b.kind] || 0) });
    for(var k=0;k<order.length;k++){
      var node = order[k];
      if(selectedId && node.id === selectedId) continue;
      drawNode(c, node, nodeAlpha(node), false);
    }
    if(selectedId && model.byId[selectedId]) drawNode(c, model.byId[selectedId], 1, true);
  }

  function drawNode(c, n, alpha, selected){
    if(alpha <= 0) return;
    var info = CORE.TYPE[n.kind] || CORE.TYPE.belief;
    var r = info.radius + Math.min(2.1, (n.mentions || 0) * 0.24);
    if(n.kind === "heard") r = Math.min(r, 1.8);
    c.globalAlpha = alpha;
    if(n.kind === "belief" || n.kind === "utterance" || n.kind === "scar"){
      c.globalAlpha = alpha * 0.12;
      c.fillStyle = info.color;
      c.beginPath(); c.arc(n.x, n.y, r * 3.1, 0, Math.PI * 2); c.fill();
      c.globalAlpha = alpha;
    }
    c.fillStyle = info.color;
    c.beginPath(); c.arc(n.x, n.y, r, 0, Math.PI * 2); c.fill();

    if(n.status === "refuted" || n.status === "refined"){
      c.globalAlpha = Math.min(1, alpha + 0.15);
      c.strokeStyle = n.status === "refuted" ? "#ff6b5e" : "#b58cff";
      c.lineWidth = 1.15;
      c.beginPath(); c.arc(n.x, n.y, r + 2.1, 0, Math.PI * 2); c.stroke();
    }
    if(filter.q && CORE.matchNode(n, filter)){
      c.globalAlpha = Math.min(1, alpha + 0.2);
      c.strokeStyle = "rgba(229,242,255,.78)";
      c.lineWidth = 0.9;
      c.beginPath(); c.arc(n.x, n.y, r + 1.8, 0, Math.PI * 2); c.stroke();
    }
    if(selected || hoverId === n.id){
      c.globalAlpha = 1;
      c.strokeStyle = "#ffffff";
      c.lineWidth = selected ? 1.7 : 1.1;
      c.beginPath(); c.arc(n.x, n.y, r + (selected ? 3.3 : 2.4), 0, Math.PI * 2); c.stroke();
      if(selected){
        c.globalAlpha = 0.18;
        c.fillStyle = "#ffffff";
        c.beginPath(); c.arc(n.x, n.y, r + 8, 0, Math.PI * 2); c.fill();
      }
    }
    c.globalAlpha = 1;
  }

  function showHover(n, ev){
    if(!n){ hover.style.display = "none"; hoverId = null; return }
    var info = CORE.TYPE[n.kind] || CORE.TYPE.belief;
    hoverId = n.id;
    hover.innerHTML = '<div class="ht">' + esc(n.text || "（没留下原话）") + '</div>'
      + '<div class="hm">' + esc(info.label) + ' · ' + esc(CORE.dateText(n.at)) + ' · 被引用 ' + (n.mentions || 0) + ' 次' + (n.source ? ' · 出处 ' + esc(n.source) : '') + '</div>';
    hover.style.display = "block";
    var rect = stage.getBoundingClientRect();
    var x = ev.clientX - rect.left + 14;
    var y = ev.clientY - rect.top + 14;
    if(x + hover.offsetWidth + 10 > rect.width) x = ev.clientX - rect.left - hover.offsetWidth - 14;
    if(y + hover.offsetHeight + 10 > rect.height) y = ev.clientY - rect.top - hover.offsetHeight - 14;
    hover.style.left = Math.max(8, x) + "px";
    hover.style.top = Math.max(8, y) + "px";
  }

  function hideHover(){ hover.style.display = "none"; if(hoverId){ hoverId = null; if(model) draw() } }

  function setPanel(open){
    panelOpen = !!open;
    panel.classList.toggle("open", panelOpen);
    panel.setAttribute("aria-hidden", panelOpen ? "false" : "true");
    panelTab.setAttribute("aria-expanded", panelOpen ? "true" : "false");
    panelTab.textContent = panelOpen ? "这一条 ▶" : "这一条 ◀";
  }

  function selectNode(id){
    if(!model || !model.byId[id]) return;
    selectedId = id;
    detail.innerHTML = CORE.panelHtml(model.byId[id], model);
    setPanel(true);
    if(history.replaceState) history.replaceState(null, "", "#n=" + encodeURIComponent(id));
    draw();
  }

  function clearSelection(){
    selectedId = null;
    detail.innerHTML = '<div class="pempty">点一个点看她说的话。</div>';
    if(history.replaceState) history.replaceState(null, "", location.pathname + location.search);
    draw();
  }

  function zoomAt(sx, sy, factor){
    var oldS = view.base * view.zoom;
    var wx = (sx - view.cssW / 2 - view.panX) / oldS;
    var wy = (sy - view.cssH / 2 - view.panY) / oldS;
    view.zoom = clamp(view.zoom * factor, 0.45, 5);
    var newS = view.base * view.zoom;
    view.panX = sx - view.cssW / 2 - wx * newS;
    view.panY = sy - view.cssH / 2 - wy * newS;
    draw();
  }

  function resetView(){ view.zoom = 1; view.panX = 0; view.panY = 0; draw() }

  function bindCanvas(){
    ensureCanvas();
    canvas.addEventListener("contextmenu", function(ev){ ev.preventDefault() });
    canvas.addEventListener("pointerdown", function(ev){
      if(ev.pointerType === "mouse" && ev.button !== 0) return;
      ev.preventDefault();
      pointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
      try{ canvas.setPointerCapture(ev.pointerId) }catch(e){}
      if(pointers.size >= 2){
        var pts = Array.from(pointers.values());
        pinch = { dist: Math.max(1, Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y)), zoom: view.zoom, cx: (pts[0].x + pts[1].x) / 2, cy: (pts[0].y + pts[1].y) / 2 };
        drag = null;
        canvas.classList.remove("dragging");
        return;
      }
      drag = { id: ev.pointerId, x: ev.clientX, y: ev.clientY, panX: view.panX, panY: view.panY, moved: false };
      hideHover();
      canvas.classList.add("dragging");
    });
    canvas.addEventListener("pointermove", function(ev){
      if(pointers.has(ev.pointerId)) pointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
      if(pinch && pointers.size >= 2){
        var pts = Array.from(pointers.values());
        var d = Math.max(1, Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y));
        view.zoom = clamp(pinch.zoom * d / pinch.dist, 0.45, 5);
        draw();
        return;
      }
      if(drag && drag.id === ev.pointerId){
        var dx = ev.clientX - drag.x, dy = ev.clientY - drag.y;
        if(Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
        view.panX = drag.panX + dx;
        view.panY = drag.panY + dy;
        draw();
        return;
      }
      var n = pick(ev.clientX, ev.clientY);
      if(n !== (hoverId ? model.byId[hoverId] : null)){
        if(n) showHover(n, ev); else hideHover();
        draw();
      } else if(n){ showHover(n, ev) }
      canvas.style.cursor = n ? "pointer" : "grab";
    });
    function end(ev, cancelled){
      pointers.delete(ev.pointerId);
      if(pinch){ if(pointers.size < 2) pinch = null; return }
      if(!drag || drag.id !== ev.pointerId) return;
      var moved = drag.moved;
      drag = null;
      canvas.classList.remove("dragging");
      try{ canvas.releasePointerCapture(ev.pointerId) }catch(e){}
      if(moved || cancelled) return;
      var n = pick(ev.clientX, ev.clientY);
      if(n) selectNode(n.id); else clearSelection();
    }
    canvas.addEventListener("pointerup", function(ev){ end(ev, false) });
    canvas.addEventListener("pointercancel", function(ev){ end(ev, true) });
    canvas.addEventListener("pointerleave", function(){ if(!drag && !pinch) hideHover() });
    canvas.addEventListener("wheel", function(ev){
      ev.preventDefault();
      var r = canvas.getBoundingClientRect();
      zoomAt(ev.clientX - r.left, ev.clientY - r.top, Math.exp(-ev.deltaY * 0.0015));
    }, { passive: false });
    canvas.addEventListener("dblclick", function(ev){ ev.preventDefault(); resetView() });
  }

  function render(data){
    model = CORE.buildModel(data, { width: W, height: H, seed: 0x51ed270b });
    model.stage = data && data.stage != null ? data.stage : null;
    model.stageName = data && data.stageName ? String(data.stageName) : "";
    filter = { types: { belief: true, utterance: true, heard: true }, onlyCited: false, q: "" };
    var search = $("search"); if(search) search.value = "";
    var cited = $("onlyCited"); if(cited) cited.checked = false;
    selectedId = null;
    setPanel(false);
    empty.style.display = "none";
    renderSub();
    updateCount();
    syncSize();
    draw();
    var h = location.hash.match(/^#n=(.+)$/);
    if(h){
      try{ selectNode(decodeURIComponent(h[1])) }catch(e){}
    }
    window.__memoryGrowth = {
      stats: function(){ return { nodes: model.nodes.length, matched: countMatched(), stats: model.stats, layout: { rx: model.layout.rx, ry: model.layout.ry, attractors: model.layout.attractors } } },
      select: selectNode,
      reset: resetView,
      setPanel: setPanel,
      filter: function(f){ if(f && f.types) filter.types = f.types; if(f && f.q != null) filter.q = String(f.q); if(f) filter.onlyCited = !!f.onlyCited; updateCount(); draw() },
      node: function(i){ var n = model.nodes[i]; return n ? { x: n.x, y: n.y, id: n.id, kind: n.kind, status: n.status } : null },
      coords: function(){ return model.nodes.map(function(n){ return { x: n.x, y: n.y, id: n.id, kind: n.kind } }) }
    };
  }

  function load(){
    empty.style.display = "flex";
    why.textContent = "正在读她的记忆…";
    fetch(API, { cache: "no-store" }).then(function(r){
      if(!r.ok) throw new Error("HTTP " + r.status);
      return r.json();
    }).then(function(data){
      if(!data || !Array.isArray(data.nodes)) throw new Error("数据形状不对");
      if(!data.nodes.length){
        empty.style.display = "flex";
        why.textContent = "这张网还没有节点。等她先说出几句判断。";
        return;
      }
      render(data);
    }).catch(function(err){
      empty.style.display = "flex";
      why.textContent = "插件没开、页面被挡，或者网络断了。（" + (err && err.message ? err.message : "读不到") + "）";
    });
  }

  $("types").addEventListener("click", function(ev){
    var btn = ev.target && ev.target.closest ? ev.target.closest("[data-kind]") : null;
    if(!btn) return;
    var kind = btn.getAttribute("data-kind");
    filter.types[kind] = filter.types[kind] === false;
    updateCount();
    draw();
  });
  $("search").addEventListener("input", function(){
    filter.q = this.value.trim().toLowerCase();
    updateCount();
    draw();
  });
  $("onlyCited").addEventListener("change", function(){
    filter.onlyCited = !!this.checked;
    updateCount();
    draw();
  });
  $("clearAll").addEventListener("click", function(){
    filter = { types: { belief: true, utterance: true, heard: true }, onlyCited: false, q: "" };
    $("search").value = "";
    $("onlyCited").checked = false;
    updateCount();
    draw();
  });
  $("zoomIn").addEventListener("click", function(){ zoomAt(view.cssW / 2, view.cssH / 2, 1.2) });
  $("zoomOut").addEventListener("click", function(){ zoomAt(view.cssW / 2, view.cssH / 2, 1 / 1.2) });
  $("zoomReset").addEventListener("click", resetView);
  panelTab.addEventListener("click", function(){ setPanel(!panelOpen); if(panelOpen && !selectedId) detail.innerHTML = '<div class="pempty">点一个点看她说的话。</div>' });
  $("panelClose").addEventListener("click", function(){ setPanel(false) });
  $("retry").addEventListener("click", load);
  document.addEventListener("keydown", function(ev){ if(ev.key === "Escape") setPanel(false) });
  window.addEventListener("resize", function(){ if(model) draw() });
  load();
})();
</script></body></html>`;
