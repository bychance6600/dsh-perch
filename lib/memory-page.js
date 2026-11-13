export function memoryCore() {
  var TYPE = {
    belief: { label: '判断', rgb: [126, 200, 255], alpha: 0.92, radius: 2.1 },
    utterance: { label: '她说过的话', rgb: [255, 120, 186], alpha: 0.85, radius: 1.9 },
    heard: { label: '听过的话', rgb: [152, 150, 172], alpha: 0.36, radius: 0.85 },
    scar: { label: '疤', rgb: [126, 200, 255], alpha: 0.95, radius: 2.2 }
  };
  var RING = { scar: [255, 233, 199], refined: [178, 130, 255], refuted: [255, 96, 96] };
  var LAYOUT = { R: 520, ATTR_RATIO: 0.8, INFLUENCE: 78, STEP: 10, ITERS: 180, SEEDS: 18, SEED: 1234567, GROW_CAP: 12000, DRAW_NEAR: 12000, DRAW_STEP: 4000 };
  var VIEW = { FOV: 950, DIST: 350, PITCH: 0.18, YAW: 0.35, PITCH_MAX: 1.2, DIST_MIN: 70, DIST_MAX: 900, ZOOM_K: 255 };
  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
  function rngFor(seed) {
    var s = seed >>> 0;
    return function () { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  }
  function normalizeKind(kind) {
    var k = String(kind == null ? '' : kind).toLowerCase();
    if (k === 'scar') return 'scar';
    if (k === 'heard' || k === 'listen' || k === 'listened') return 'heard';
    if (k === 'utterance' || k === 'said' || k === 'voice' || k === 'her') return 'utterance';
    return 'belief';
  }
  function typeKeyOf(node) { return node && node.kind === 'scar' ? 'belief' : (node && node.kind ? node.kind : 'belief'); }
  function isRevise(e){ return !!e && e.kind==="revise"; }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return c === '&' ? '&amp;' : (c === '<' ? '&lt;' : (c === '>' ? '&gt;' : '&quot;'));
    });
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
  function truncate(text, n) {
    var chars = Array.from(String(text == null ? '' : text));
    if (chars.length <= n) return chars.join('');
    return chars.slice(0, n).join('') + '…';
  }
  function grow3d(count, opts) {
    opts = opts || {};
    var want = Math.max(1, Math.floor(Number(count) || 0));
    var R = Number(opts.R) || LAYOUT.R;
    var STEP = Number(opts.STEP) || LAYOUT.STEP;
    var INFLUENCE = Number(opts.INFLUENCE) || LAYOUT.INFLUENCE;
    var ATTR_RATIO = opts.ATTR_RATIO == null ? LAYOUT.ATTR_RATIO : Number(opts.ATTR_RATIO);
    var ITERS = opts.ITERS == null ? LAYOUT.ITERS : Number(opts.ITERS);
    var SEEDS = opts.SEEDS == null ? LAYOUT.SEEDS : Number(opts.SEEDS);
    var seed = opts.seed == null ? LAYOUT.SEED : opts.seed;
    var growCap = opts.GROW_CAP == null ? LAYOUT.GROW_CAP : Number(opts.GROW_CAP);
    var rnd = rngFor(seed);
    function randDir() {
      var u = rnd() * 2 - 1;
      var t = rnd() * 6.2832;
      var r = Math.sqrt(1 - u * u);
      return { x: r * Math.cos(t), y: r * Math.sin(t), z: u };
    }
    var growN = Math.min(want, Math.max(SEEDS, growCap));
    var attrN = Math.max(1, Math.min(40000, Math.round(growN * ATTR_RATIO)));
    var ax = new Float64Array(attrN);
    var ay = new Float64Array(attrN);
    var az = new Float64Array(attrN);
    var alive = new Uint8Array(attrN);
    var i;
    for (i = 0; i < attrN; i++) {
      var d = randDir();
      var rr = Math.cbrt(rnd()) * R;
      ax[i] = d.x * rr; ay[i] = d.y * rr; az[i] = d.z * rr; alive[i] = 1;
    }
    var maxPts = Math.max(growN + 2000, Math.ceil(growN * 1.15));
    var px = new Float64Array(maxPts), py = new Float64Array(maxPts), pz = new Float64Array(maxPts);
    var pd = new Uint32Array(maxPts), pp = new Int32Array(maxPts);
    var np = 0;
    var CELL = INFLUENCE, OFF = 8, DIM = 16;
    var gridHead = new Int32Array(DIM * DIM * DIM);
    gridHead.fill(-1);
    var gridNext = new Int32Array(maxPts);
    function cellIndex(x, y, z) {
      return ((Math.floor(x / CELL) + OFF) * DIM + (Math.floor(y / CELL) + OFF)) * DIM + (Math.floor(z / CELL) + OFF);
    }
    function put(idx) {
      var k = cellIndex(px[idx], py[idx], pz[idx]);
      gridNext[idx] = gridHead[k];
      gridHead[k] = idx;
    }
    var k;
    for (k = 0; k < SEEDS; k++) {
      var sd = randDir();
      px[np] = sd.x * 2; py[np] = sd.y * 2; pz[np] = sd.z * 2;
      pd[np] = 0; pp[np] = -1; put(np); np++;
    }
    var groups = new Map();
    for (var it = 0; it < ITERS; it++) {
      groups.clear();
      for (var ai = 0; ai < attrN; ai++) {
        if (!alive[ai]) continue;
        var X = ax[ai], Y = ay[ai], Z = az[ai];
        var best = -1, bd = INFLUENCE * INFLUENCE;
        var cx = Math.floor(X / CELL) + OFF, cy = Math.floor(Y / CELL) + OFF, cz = Math.floor(Z / CELL) + OFF;
        for (var dx = -1; dx <= 1; dx++) {
          for (var dy = -1; dy <= 1; dy++) {
            for (var dz = -1; dz <= 1; dz++) {
              var gx = cx + dx, gy = cy + dy, gz = cz + dz;
              if (gx < 0 || gy < 0 || gz < 0 || gx >= DIM || gy >= DIM || gz >= DIM) continue;
              var head = gridHead[(gx * DIM + gy) * DIM + gz];
              if (head === -1) continue;
              var bx0 = (gx - OFF) * CELL, bx1 = bx0 + CELL;
              var by0 = (gy - OFF) * CELL, by1 = by0 + CELL;
              var bz0 = (gz - OFF) * CELL, bz1 = bz0 + CELL;
              var gapx = X < bx0 ? bx0 - X : (X > bx1 ? X - bx1 : 0);
              var gapy = Y < by0 ? by0 - Y : (Y > by1 ? Y - by1 : 0);
              var gapz = Z < bz0 ? bz0 - Z : (Z > bz1 ? Z - bz1 : 0);
              if (gapx * gapx + gapy * gapy + gapz * gapz >= bd) continue;
              for (var pi = head; pi !== -1; pi = gridNext[pi]) {
                var ddx = px[pi] - X, ddy = py[pi] - Y, ddz = pz[pi] - Z;
                var dd = ddx * ddx + ddy * ddy + ddz * ddz;
                if (dd < bd) { bd = dd; best = pi; }
              }
            }
          }
        }
        if (best >= 0) {
          var g = groups.get(best);
          if (!g) { g = []; groups.set(best, g); }
          g.push(ai);
        }
      }
      if (!groups.size) break;
      groups.forEach(function (arr2, idx) {
        var nx0 = px[idx], ny0 = py[idx], nz0 = pz[idx];
        var vx = 0, vy = 0, vz = 0;
        for (var q = 0; q < arr2.length; q++) {
          var a = arr2[q];
          var ux = ax[a] - nx0, uy = ay[a] - ny0, uz = az[a] - nz0;
          var L = Math.hypot(ux, uy, uz) || 1;
          vx += ux / L; vy += uy / L; vz += uz / L;
        }
        var LL = Math.hypot(vx, vy, vz) || 1;
        var nx = nx0 + vx / LL * STEP, ny = ny0 + vy / LL * STEP, nz = nz0 + vz / LL * STEP;
        if (Math.hypot(nx, ny, nz) > R) return;
        if (np >= maxPts) return;
        px[np] = nx; py[np] = ny; pz[np] = nz;
        pd[np] = pd[idx] + 1; pp[np] = idx; put(np); np++;
        for (var w = 0; w < arr2.length; w++) {
          var aa = arr2[w];
          if (Math.hypot(ax[aa] - nx, ay[aa] - ny, az[aa] - nz) < STEP * 1.25) alive[aa] = 0;
        }
      });
      if (np >= maxPts) break;
    }
    var guard = 0;
    while (np < want && guard < want * 30) {
      guard++;
      var parent = Math.floor(rnd() * np);
      var aidx = Math.floor(rnd() * attrN);
      var ox = px[parent], oy = py[parent], oz = pz[parent];
      var wx = ax[aidx] - ox, wy = ay[aidx] - oy, wz = az[aidx] - oz;
      var WL = Math.hypot(wx, wy, wz) || 1;
      var qx = ox + wx / WL * STEP, qy = oy + wy / WL * STEP, qz = oz + wz / WL * STEP;
      if (Math.hypot(qx, qy, qz) > R) continue;
      if (np >= maxPts) break;
      px[np] = qx; py[np] = qy; pz[np] = qz;
      pd[np] = pd[parent] + 1; pp[np] = parent; np++;
    }
    while (np < want) {
      var fallback = Math.floor(rnd() * np);
      px[np] = px[fallback] + (rnd() - 0.5) * STEP;
      py[np] = py[fallback] + (rnd() - 0.5) * STEP;
      pz[np] = pz[fallback] + (rnd() - 0.5) * STEP;
      pd[np] = pd[fallback] + 1; pp[np] = fallback; np++;
    }
    var points = new Array(np);
    for (var p = 0; p < np; p++) points[p] = { x: px[p], y: py[p], z: pz[p], parent: pp[p], depth: pd[p] };
    return { points: points, attractors: attrN, rnd: rnd };
  }
  function layout(nodes, opts) {
    opts = opts || {};
    var count = typeof nodes === 'number' ? nodes : (nodes && nodes.length ? nodes.length : 0);
    if (!count) return { tree: [], points: [], branches: 0, attractors: 0, steps: 0, R: LAYOUT.R };
    var grown = grow3d(count, {
      R: opts.R == null ? LAYOUT.R : opts.R,
      STEP: opts.STEP == null ? LAYOUT.STEP : opts.STEP,
      INFLUENCE: opts.INFLUENCE == null ? LAYOUT.INFLUENCE : opts.INFLUENCE,
      ATTR_RATIO: opts.ATTR_RATIO == null ? LAYOUT.ATTR_RATIO : opts.ATTR_RATIO,
      ITERS: opts.ITERS == null ? LAYOUT.ITERS : opts.ITERS,
      SEEDS: opts.SEEDS == null ? LAYOUT.SEEDS : opts.SEEDS,
      GROW_CAP: opts.GROW_CAP == null ? LAYOUT.GROW_CAP : opts.GROW_CAP,
      seed: opts.seed == null ? LAYOUT.SEED : opts.seed
    });
    var tree = grown.points;
    var order = new Array(tree.length);
    var i;
    for (i = 0; i < tree.length; i++) order[i] = i;
    order.sort(function (a, b) { return (tree[a].depth - tree[b].depth) || (a - b); });
    var rnd = grown.rnd;
    var points = [];
    for (i = 0; i < count; i++) {
      var src = tree[order[i % order.length]];
      points.push({ x: src.x + (rnd() - 0.5) * 6, y: src.y + (rnd() - 0.5) * 6, z: src.z + (rnd() - 0.5) * 6 });
    }
    // 归一化：把第 95 百分位的半径映射到固定视径，避免「点少就缩成一小团」
    var radii = tree.map(function (t) { return Math.hypot(t.x, t.y, t.z); }).sort(function (a, b) { return a - b; });
    var p95 = radii.length ? radii[Math.min(radii.length - 1, Math.floor(radii.length * 0.95))] : 0;
    if (p95 > 1) {
      var k = 520 / p95;
      tree.forEach(function (t) { t.x *= k; t.y *= k; t.z *= k; });
      points.forEach(function (q) { q.x *= k; q.y *= k; q.z *= k; });
    }
    return { tree: tree, points: points, branches: Math.max(0, tree.length - 1), attractors: grown.attractors, steps: tree.length, R: LAYOUT.R };
  }
  function buildModel(raw, opts) {
    opts = opts || {};
    var src = raw && Array.isArray(raw.nodes) ? raw.nodes : (Array.isArray(raw) ? raw : []);
    var nodes = src.map(function (n, i) {
      var kind = normalizeKind(n && n.kind);
      var status = n && (n.status === 'refuted' || n.status === 'refined') ? n.status : 'active';
      var text = String(n && n.text != null ? n.text : '').slice(0, 240);
      return {
        id: String(n && n.id != null ? n.id : ('n' + i)), kind: kind, typeKey: kind === 'scar' ? 'belief' : kind,
        text: text, at: String((n && (n.at || n.ts || n.when || n.day)) || ''),
        source: String((n && (n.source || n.origin || n.channel)) || ''), channel: String((n && n.channel) || ''),
        status: kind === 'scar' ? 'active' : status,
        supersededBy: n && n.supersededBy ? String(n.supersededBy) : '',
        mentions: Math.max(0, Number(n && n.mentions) || 0), conf: Number(n && n.conf) || 0.5, said: !!(n && n.said), saidOf: n && n.saidOf ? String(n.saidOf) : '', raw: n
      };
    });
    var lay = layout(nodes, { R: opts.R, STEP: opts.STEP, INFLUENCE: opts.INFLUENCE, ATTR_RATIO: opts.ATTR_RATIO, ITERS: opts.ITERS, SEEDS: opts.SEEDS, GROW_CAP: opts.GROW_CAP, seed: opts.seed });
    var byId = Object.create(null);
    for (var i = 0; i < nodes.length; i++) {
      nodes[i].x = lay.points[i].x; nodes[i].y = lay.points[i].y; nodes[i].z = lay.points[i].z; byId[nodes[i].id] = nodes[i];
    }
    // 「她说过的话」挂在对应判断旁边：按 id 派生一个固定方向，错开 8px，不重排布局
    for (var j = 0; j < nodes.length; j++) {
      var nd = nodes[j], host = nd.saidOf ? byId[nd.saidOf] : null;
      if (!host) continue;
      var h = 0, key = nd.id;
      for (var c = 0; c < key.length; c++) h = (h * 31 + key.charCodeAt(c)) >>> 0;
      var ang = (h % 628) / 100, rad = 8 + (h % 5);
      nd.x = host.x + Math.cos(ang) * rad;
      nd.y = host.y + Math.sin(ang) * rad * 0.7;
      nd.z = host.z + ((h % 2) ? 3 : -3);
    }
    var edges = [], seenEdge = Object.create(null);
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
      var kind = e.kind === 'refuted' ? 'refuted' : (isRevise(e) ? 'revise' : (e.kind === 'tension' ? 'tension' : ''));
      if (!kind) return;
      addEdge(String(e.s == null ? '' : e.s), String(e.t == null ? '' : e.t), kind, e.w == null ? 1 : e.w);
    });
    nodes.forEach(function (n) {
      if (n.supersededBy && byId[n.supersededBy]) addEdge(n.id, n.supersededBy, n.status === 'refuted' ? 'refuted' : 'revise', 1);
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
    return { nodes: nodes, byId: byId, edges: edges, layout: lay, stats: stats, metaCounts: metaCounts };
  }
  // 任意旋转：四元数轨道球（不再是 yaw/pitch 两轴，可以滚转、可以倒过来看）
  function qMul(a, b) {
    return [
      a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
      a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
      a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
      a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2]
    ];
  }
  function qNorm(q) {
    var n = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
    return [q[0] / n, q[1] / n, q[2] / n, q[3] / n];
  }
  function qAxis(ax, ay, az, ang) {
    var n = Math.hypot(ax, ay, az) || 1, h = ang / 2, s = Math.sin(h);
    return [ax / n * s, ay / n * s, az / n * s, Math.cos(h)];
  }
  function qDefault(view) {
    var yaw = view && view.yaw != null ? view.yaw : VIEW.YAW;
    var pitch = view && view.pitch != null ? view.pitch : VIEW.PITCH;
    return qNorm(qMul(qAxis(0, 1, 0, yaw), qAxis(1, 0, 0, pitch)));
  }
  var rotCache = { v: null, m: null };
  function matrixOf(view) {
    var q = (view && view.q) || qDefault(view);
    var v = (view && view.qVersion) || 0;
    if (rotCache.v === v && rotCache.q === q) return rotCache.m;
    var x = q[0], y = q[1], z = q[2], w = q[3];
    var m = [
      1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w),
      2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w),
      2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)
    ];
    rotCache = { v: v, q: q, m: m };
    return m;
  }
  function project(p, view, W, H) {
    var dist = view && view.dist != null ? view.dist : VIEW.DIST;
    var m = matrixOf(view);
    var x1 = m[0] * p.x + m[1] * p.y + m[2] * p.z;
    var y1 = m[3] * p.x + m[4] * p.y + m[5] * p.z;
    var z = m[6] * p.x + m[7] * p.y + m[8] * p.z;
    // 缩放 ∝ 1/dist（近处能一路放大），纵深用线性衰减近似透视，避免 z 接近相机时爆炸。
    var s = (VIEW.ZOOM_K / Math.max(60, dist)) * (1 - z / 1600);
    var panX = (view && view.panX) || 0, panY = (view && view.panY) || 0;
    return { x: W / 2 + panX + x1 * s, y: H / 2 + panY + y1 * s, s: s, z: z };
  }
  function projectAll(nodes, view, W, H) {
    var out = new Array(nodes.length);
    for (var i = 0; i < nodes.length; i++) {
      var p = project(nodes[i], view, W, H);
      p.id = nodes[i].id; p.kind = nodes[i].kind; p.node = nodes[i]; out[i] = p;
    }
    return out;
  }
  function pickNearest(projected, x, y, maxPx) {
    var limit = maxPx == null ? 12 : Number(maxPx);
    var bd = limit * limit;
    var best = null;
    for (var i = 0; i < projected.length; i++) {
      var p = projected[i];
      if (!p || p.hidden) continue;
      var dx = p.x - x, dy = p.y - y, d = dx * dx + dy * dy;
      if (d > bd) continue;
      if (!best || d < best.d || (d === best.d && p.z < best.p.z)) best = { p: p, d: d };
    }
    return best ? best.p : null;
  }
  function colorFor(kind, s) {
    var base = TYPE[kind] || TYPE.belief;
    var near = clamp((Number(s) - 0.45) / 0.35, 0, 1);
    var bright = 0.72 + 0.28 * near;
    return { r: Math.round(base.rgb[0] * bright), g: Math.round(base.rgb[1] * bright), b: Math.round(base.rgb[2] * bright), a: base.alpha * (0.55 + 0.45 * near), near: near };
  }
  function ringsFor(node, s) {
    var near = clamp((Number(s) - 0.45) / 0.35, 0, 1), out = [];
    if (node && node.kind === 'scar') out.push({ color: RING.scar, alpha: 0.92, width: 0.9, gap: 1.5 });
    if (node && node.status === 'refined') out.push({ color: RING.refined, alpha: 0.88, width: 0.9, gap: 2.3 });
    if (node && node.status === 'refuted') out.push({ color: RING.refuted, alpha: 0.90, width: 0.9, gap: 2.3 });
    for (var i = 0; i < out.length; i++) out[i].alpha *= (0.72 + 0.28 * near);
    return out;
  }
  function nodeStyle(node, s) {
    var kind = node && node.kind ? node.kind : 'belief';
    var base = TYPE[kind] || TYPE.belief;
    var near = clamp((Number(s) - 0.45) / 0.35, 0, 1);
    return { color: colorFor(kind, s), radius: Math.min(8.5, Math.max(0.7, base.radius * 1.5 * Number(s) * (0.7 + 0.6 * near))), rings: ringsFor(node, s) };
  }
  function hasText(node, needle) {
    if (!needle) return true;
    var q = String(needle).toLowerCase();
    if (String(node.text || '').toLowerCase().indexOf(q) >= 0) return true;
    if (String(node.source || '').toLowerCase().indexOf(q) >= 0) return true;
    if (String(node.channel || '').toLowerCase().indexOf(q) >= 0) return true;
    if (String(TYPE[node.kind] ? TYPE[node.kind].label : '').toLowerCase().indexOf(q) >= 0) return true;
    return false;
  }
  function matchNode(node, filter) {
    filter = filter || {};
    if (filter.types && filter.types[typeKeyOf(node)] === false) return false;
    if (filter.onlyCited && (node.mentions || 0) < 2) return false;
    return hasText(node, filter.q);
  }
  function nodeAlpha(node, filter) {
    if (!matchNode(node, filter)) return 0;
    var info = TYPE[node.kind] || TYPE.belief;
    return clamp(info.alpha, 0, 1);
  }
  function chainRows(node, model) {
    var out = [], seen = Object.create(null);
    function add(oldNode, freshNode) {
      if (!oldNode || !freshNode || oldNode.id === freshNode.id) return;
      var k = oldNode.id + '\u0000' + freshNode.id;
      if (seen[k]) return;
      seen[k] = 1; out.push({ old: oldNode, fresh: freshNode });
    }
    if (node.supersededBy && model.byId[node.supersededBy]) add(node, model.byId[node.supersededBy]);
    (model.edges || []).forEach(function (e) {
      if (e.kind !== 'revise' && e.kind !== 'refuted') return;
      if (e.s === node.id) add(model.byId[e.s], model.byId[e.t]);
      else if (e.t === node.id) add(model.byId[e.s], model.byId[e.t]);
    });
    return out;
  }
  function statusText(node) {
    if (!node) return '';
    if (node.kind === 'scar') return '疤';
    if (node.status === 'refined') return '改过';
    if (node.status === 'refuted') return '被推翻';
    return '还在';
  }
  function panelHtml(node, model) {
    if (!node) return '<div class="pempty">点一个点看她说的话。</div>';
    var info = TYPE[node.kind] || TYPE.belief;
    var rows = chainRows(node, model);
    var meta = '<span class="ptype">' + esc(info.label) + '</span><span>' + esc(dateText(node.at)) + '</span><span>' + esc(statusText(node)) + '</span><span>出处：' + esc(node.source || '账本') + '</span>';
    if (node.channel) meta += '<span>渠道：' + esc(node.channel) + '</span>';
    var html = '<div class="ptext">' + esc(node.text || '（没留下原话）') + '</div><div class="pmeta">' + meta + '</div>';
    if (rows.length || node.status === 'refined' || node.status === 'refuted') {
      html += '<div class="pchain"><div class="pchain-h">她改过这里</div><div class="pchain-flow">原话 → 改口 → 现话</div>';
      rows.slice(0, 8).forEach(function (r) {
        html += '<div class="pchain-row"><s>' + esc(r.old.text || '旧句') + '</s><span class="parrow">→</span><span>' + esc(r.fresh.text || '现话') + '</span></div>';
      });
      if (!rows.length) html += '<div class="pchain-row">这一条标着改过，账本里没留下旧句。</div>';
      html += '</div>';
    }
    return html;
  }
  function initialDrawLimit(total) { return total > LAYOUT.DRAW_NEAR ? LAYOUT.DRAW_NEAR : total; }
  function nextDrawLimit(limit, total, step) { return Math.min(total, (Number(limit) || 0) + (Number(step) || LAYOUT.DRAW_STEP)); }
  return { TYPE: TYPE, RING: RING, LAYOUT: LAYOUT, VIEW: VIEW, clamp: clamp, qMul: qMul, qNorm: qNorm, qAxis: qAxis, qDefault: qDefault, matrixOf: matrixOf, rngFor: rngFor, normalizeKind: normalizeKind, typeKeyOf: typeKeyOf, isRevise: isRevise, dateText: dateText, shortDate: shortDate, truncate: truncate, grow3d: grow3d, layout: layout, buildModel: buildModel, project: project, projectAll: projectAll, pickNearest: pickNearest, colorFor: colorFor, ringsFor: ringsFor, nodeStyle: nodeStyle, searchHit: hasText, matchNode: matchNode, nodeAlpha: nodeAlpha, chainRows: chainRows, statusText: statusText, panelHtml: panelHtml, initialDrawLimit: initialDrawLimit, nextDrawLimit: nextDrawLimit };
}

const coreSrc = memoryCore.toString();

export const MEMORY_PAGE = String.raw`<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>记忆图谱 · dsh-perch</title>
<style>
:root{color-scheme:dark}
*{box-sizing:border-box}
html,body{margin:0;height:100%;background:#070b11;color:#d9e0ea;font:14px/1.5 "Segoe UI","PingFang SC","Microsoft YaHei",system-ui,sans-serif}
body{display:flex;flex-direction:column;overflow:hidden}
header{padding:13px 20px 10px;border-bottom:1px solid #172231;background:#080d15;flex:none}
h1{margin:0;font-size:17px;font-weight:600;letter-spacing:.5px}
.sub{color:#77869a;font-size:12px;margin-top:4px;min-height:18px}
.sub b{color:#b8c7da;font-weight:500}
main{position:relative;flex:1;min-height:0;overflow:hidden}
#stage{position:absolute;inset:0;overflow:hidden;background:radial-gradient(ellipse at 52% 46%,#101b2a 0%,#0a1019 45%,#070b11 100%);transition:right .22s ease}
main.panel-open #stage{right:340px}
#graph{position:absolute;inset:0;display:block;width:100%;height:100%;cursor:grab;touch-action:none}
#graph.dragging{cursor:grabbing}
.toolbar{position:absolute;left:16px;top:14px;right:16px;display:flex;gap:8px;align-items:center;flex-wrap:wrap;z-index:4;pointer-events:none}
.toolbar>*{pointer-events:auto}
.types{display:flex;gap:3px;background:#0d1622e6;border:1px solid #1e2d40;border-radius:9px;padding:3px;box-shadow:0 6px 22px #0004}
.type{border:0;background:transparent;color:#b7c5d7;font:12px/1.3 "Segoe UI","PingFang SC","Microsoft YaHei",system-ui,sans-serif;padding:6px 9px;border-radius:6px;cursor:pointer;display:flex;align-items:center;gap:5px;white-space:nowrap}
.type:hover{background:#162438;color:#eef6ff}
.type.off{opacity:.34}
.type i{width:7px;height:7px;border-radius:50%;display:inline-block;box-shadow:0 0 9px currentColor}
.search{display:flex;align-items:center;background:#0d1622e6;border:1px solid #1e2d40;border-radius:9px;padding:0 9px;height:32px;box-shadow:0 6px 22px #0004}
.search input{width:164px;background:transparent;border:0;outline:0;color:#d9e6f6;font:12px "Segoe UI","PingFang SC","Microsoft YaHei",system-ui,sans-serif;padding:0}
.search input::placeholder{color:#5e6f83}
.cited{display:flex;align-items:center;gap:5px;height:32px;padding:0 10px;background:#0d1622e6;border:1px solid #1e2d40;border-radius:9px;color:#a9b9cc;font-size:12px;cursor:pointer;white-space:nowrap}
.cited input{accent-color:#7ec8ff}
.clearAll{height:32px;padding:0 12px;border-radius:9px;border:1px solid #24364b;background:#0d1622e6;color:#aebdd2;font:12px "Segoe UI","PingFang SC","Microsoft YaHei",system-ui,sans-serif;cursor:pointer;white-space:nowrap}
.clearAll:hover{background:#17263a;color:#fff}
.zoom{position:absolute;right:16px;bottom:16px;display:flex;gap:6px;z-index:5}
.zoom button{height:30px;border-radius:7px;border:1px solid #26384e;background:#0c1420e6;color:#cfdcee;font:12px/1 "Segoe UI","PingFang SC","Microsoft YaHei",system-ui,sans-serif;cursor:pointer;padding:0 10px}
.zoom button:hover{background:#17263a;color:#fff}
.hud{position:absolute;left:18px;bottom:18px;z-index:3;color:#73839a;font-size:12px;line-height:1.8;pointer-events:none;text-shadow:0 1px 3px #000}
.hud b{color:#a9bdd4;font-weight:500}
.hud .note{color:#5f7289}
.hover{position:absolute;display:none;max-width:320px;background:#0b1420f4;border:1px solid #29405a;border-radius:9px;padding:9px 11px;font-size:12px;line-height:1.55;color:#d9e0ea;pointer-events:none;z-index:8;box-shadow:0 10px 30px #0008}
.hover .ht{font-size:13px;color:#eef6ff;margin-bottom:4px;word-break:break-word}
.hover .hm{color:#8b99ad}
.empty{position:absolute;inset:0;display:flex;flex-direction:column;gap:10px;align-items:center;justify-content:center;text-align:center;padding:30px;color:#93a1b5;z-index:6;background:#070b11}
.empty strong{color:#d9e0ea;font-size:15px;font-weight:500}
.empty button{background:#16263a;color:#d9e0ea;border:1px solid #2b3b52;border-radius:6px;padding:6px 14px;cursor:pointer}
.panel{position:absolute;top:0;right:0;bottom:0;width:340px;background:#0a111bfa;border-left:1px solid #1e2d40;z-index:9;transform:translateX(100%);transition:transform .22s ease;display:flex;flex-direction:column;box-shadow:-12px 0 30px #0005}
.panel.open{transform:translateX(0)}
.panel-tab{position:absolute;left:-38px;top:50%;transform:translateY(-50%);width:38px;height:118px;border:1px solid #29405a;border-right:0;border-radius:9px 0 0 9px;background:#0d1724f2;color:#b9cbe0;font:12px/1.25 "Segoe UI","PingFang SC","Microsoft YaHei",system-ui,sans-serif;cursor:pointer;writing-mode:vertical-rl;letter-spacing:2px;padding:8px 0}
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
footer{padding:6px 20px;border-top:1px solid #172231;color:#5f6c7d;font-size:11px;background:#080d15;flex:none}
@media(max-width:820px){
  header{padding:11px 14px 8px}
  .toolbar{left:10px;right:10px;top:10px;gap:6px}
  .search input{width:118px}
  .type{padding:6px 7px}
  .panel{top:auto;bottom:0;width:100%;height:58%;border-left:0;border-top:1px solid #1e2d40;transform:translateY(100%);box-shadow:0 -12px 30px #0006}
  .panel.open{transform:translateY(0)}
  main.panel-open #stage{right:0}
  .panel-tab{left:auto;right:14px;top:-34px;width:auto;height:34px;border:1px solid #29405a;border-bottom:0;border-radius:9px 9px 0 0;writing-mode:horizontal-tb;padding:0 12px;letter-spacing:0}
}
</style></head><body>
<header><h1>记忆图谱</h1><div class="sub" id="sub">正在读她的记忆…</div></header>
<main id="main"><div id="stage">
<canvas id="graph" aria-label="记忆图谱" role="img"></canvas>
<div class="toolbar">
  <div class="types" id="types">
    <button type="button" class="type" data-kind="belief"><i style="background:#7ec8ff;color:#7ec8ff"></i>判断 <b data-count="belief">0</b></button>
    <button type="button" class="type off" data-kind="utterance"><i style="background:#ce90ff;color:#ce90ff"></i>她说过的话 <b data-count="utterance">0</b></button>
    <button type="button" class="type" data-kind="heard"><i style="background:#56708f;color:#56708f"></i>听过的话 <b data-count="heard">0</b></button>
  </div>
  <label class="search"><input id="search" type="search" placeholder="搜原话、出处…" autocomplete="off"></label>
  <label class="cited"><input id="onlyCited" type="checkbox">只看被引用过</label>
  <button type="button" id="clearAll" class="clearAll">全部</button>
</div>
<div class="hud" id="hud"></div>
<div class="hover" id="hover"></div>
<div class="zoom"><button type="button" id="zoomReset" title="归位">归位</button></div>
<div class="empty" id="empty"><strong>读不到记忆</strong><div id="emptyWhy">插件没开、页面被挡，或者这会儿还没有数据。</div><button id="retry">再试一次</button></div>
<aside id="panel" class="panel" aria-hidden="true">
  <button type="button" id="panelTab" class="panel-tab" aria-expanded="false">这一条 ◀</button>
  <div class="panel-body"><div class="panel-head"><h2>这一条</h2><button type="button" id="panelClose" class="panel-close">收起</button></div><div id="detail"><div class="pempty">点一个点看她说的话。</div></div></div>
</aside>
</div></main>
<footer>只看不写 · 拖动转视角 · 滚轮推拉 · 颜色是事件的种类，枝干是生长顺序，不是论断之间的关系 · 数据来自 /dsh-perch/api/memory</footer>
<script>
(function(){
  "use strict";
  var CORE = (${coreSrc})();
  var API = "/dsh-perch/api/memory";
  var stage = document.getElementById("stage");
  var main = document.getElementById("main");
  var canvas = document.getElementById("graph");
  if(!canvas || typeof canvas.getContext !== "function"){
    var fallbackCanvas = document.createElement("canvas");
    fallbackCanvas.id = "graph";
    stage.insertBefore(fallbackCanvas, stage.firstChild);
    canvas = fallbackCanvas;
  }
  var ctx = canvas.getContext("2d");
  var sub = document.getElementById("sub");
  var hud = document.getElementById("hud");
  var empty = document.getElementById("empty");
  var why = document.getElementById("emptyWhy");
  var hover = document.getElementById("hover");
  var panel = document.getElementById("panel");
  var panelTab = document.getElementById("panelTab");
  var detail = document.getElementById("detail");
  var model = null;
  var projected = [];
  var pickList = [];
  var selectedId = null;
  var hoverId = null;
  var panelOpen = false;
  var W = 900, H = 600, DPR = 1;
  var layoutMs = 0;
  var drawLimit = 0;
  var fillTimer = null;
  var fillTick = null;
  var view = { yaw: CORE.VIEW.YAW, pitch: CORE.VIEW.PITCH, dist: CORE.VIEW.DIST };
  var filter = { types: { belief: true, utterance: false, heard: true }, onlyCited: false, q: "" };
  var drag = null;
  var lastPointer = null;

  function $(id){ return document.getElementById(id) }
  function q(sel){ var list = document.querySelectorAll(sel); return list && list.length ? list[0] : null }
  function clamp(v,a,b){ return v < a ? a : (v > b ? b : v) }

  function syncSize(){
    var r = stage.getBoundingClientRect();
    W = Math.max(1, Math.round(r.width));
    H = Math.max(1, Math.round(r.height));
    DPR = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
    canvas.width = Math.round(W * DPR);
    canvas.height = Math.round(H * DPR);
    canvas.style.width = W + "px";
    canvas.style.height = H + "px";
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  }

  function updateCount(){
    if(!model) return;
    var c = model.stats;
    var list = ["belief","utterance","heard"];
    for(var i=0;i<list.length;i++){
      var el = q('[data-count="' + list[i] + '"]');
      if(el) el.textContent = String(c[list[i]] || 0);
    }
    var mc = model.metaCounts;
    var parts = [];
    if(mc){
      parts.push("判断 <b>" + (mc.belief || 0) + "</b>");
      var ut = "她说过的话 <b>" + (mc.utterance || 0) + "</b> 条";
      if((mc.utterance || 0) > (c.utterance || 0)){
        ut += ' <span class="note">（图上 ' + (c.utterance || 0) + ' 句，其余已长成判断）</span>';
      }
      parts.push(ut);
      parts.push("听过的话 <b>" + (mc.heard || 0) + "</b> 条");
    }else{
      parts.push("判断 <b>" + (c.belief || 0) + "</b>");
      parts.push("她说过的话 <b>" + (c.utterance || 0) + "</b> 条");
      parts.push("听过的话 <b>" + (c.heard || 0) + "</b> 条");
    }
    parts.push("共 <b>" + c.nodes + "</b> 点");
    hud.innerHTML = parts.join(" · ");
  }

  function updateSub(){
    if(!model){ sub.textContent = "正在读她的记忆…"; return }
    sub.innerHTML = "共 <b>" + model.stats.nodes + "</b> 点 · 布局 <b>" + Math.round(layoutMs) + "ms</b> · 拖动转视角，滚轮推拉";
  }

  function resetView(){
    view.yaw = CORE.VIEW.YAW;
    view.pitch = CORE.VIEW.PITCH;
    view.dist = CORE.VIEW.DIST;
    view.q = null; view.qVersion = (view.qVersion || 0) + 1;
    view.panX = 0; view.panY = 0;
    draw();
  }

  function visible(node){ return CORE.matchNode(node, filter) }

  function syncDebug(){
    if(!model) return;
    var matched = 0;
    for(var i=0;i<projected.length;i++){ if(projected[i] && visible(projected[i].node)) matched++ }
    var graph = {
      stats: function(){
        var out = {};
        for(var k in model.stats) out[k] = model.stats[k];
        out.matched = matched;
        out.axes = [view.yaw, view.pitch, view.dist];
        return out;
      },
      coords: function(){
        return projected.map(function(p){ return { id: p.id, x: p.x, y: p.y, z: p.z } });
      },
      node: function(i){
        var p = projected[i];
        return p ? { id: p.id, x: p.x, y: p.y, z: p.z } : null;
      },
      clientOf: function(i){ return graph.node(i) },
      setKindFilter: function(kind, on){ filter.types[kind] = !!on; draw() },
      toggleKind: function(kind){ filter.types[kind] = filter.types[kind] === false; draw() },
      filter: function(next){
        if(next && next.types){ for(var k in next.types) filter.types[k] = !!next.types[k] }
        if(next && next.q != null) filter.q = String(next.q).toLowerCase();
        if(next && next.onlyCited != null) filter.onlyCited = !!next.onlyCited;
        draw();
      },
      layout: model.layout
    };
    try { window.__memoryGrowth = graph } catch(e) {}
  }

  function draw(){
    if(!model || !ctx) return;
    ctx.clearRect(0, 0, W, H);
    var tree = model.layout && model.layout.tree ? model.layout.tree : null;
    if (tree && tree.length > 1) {
      var tp = new Array(tree.length);
      for (var ti = 0; ti < tree.length; ti++) tp[ti] = CORE.project(tree[ti], view, W, H);
      ctx.globalAlpha = 0.055;
      ctx.strokeStyle = "rgb(120,150,190)";
      ctx.lineWidth = 0.6;
      ctx.beginPath();
      for (var bi = 1; bi < tree.length; bi++) {
        var par = tree[bi].parent;
        if (par == null || par < 0) continue;
        ctx.moveTo(tp[par].x, tp[par].y);
        ctx.lineTo(tp[bi].x, tp[bi].y);
      }
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
    var all = CORE.projectAll(model.nodes, view, W, H);
    projected = all;
    var drawN = Math.min(drawLimit || model.nodes.length, model.nodes.length);
    var order = [];
    for(var i=0;i<drawN;i++) order.push(all[i]);
    order.sort(function(a,b){ return b.z - a.z });
    var byIndex = new Map();
    for(var j=0;j<all.length;j++) byIndex.set(all[j].id, all[j]);

    ctx.save();
    for(var e=0;e<model.edges.length;e++){
      var ed = model.edges[e];
      var a = byIndex.get(ed.s), b = byIndex.get(ed.t);
      if(!a || !b) continue;
      if(!visible(a.node) && !visible(b.node)) continue;
      var midz = (a.z + b.z) / 2;
      var behind = midz > 0;
      var alpha = behind ? 0.35 : 0.7;
      ctx.globalAlpha = alpha;
      ctx.lineWidth = CORE.isRevise(ed) ? 1.1 : 1;
      if(ed.kind === "refuted"){ ctx.strokeStyle = "rgba(255,96,96,0.9)"; ctx.setLineDash([]) }
      else if(CORE.isRevise(ed)){ ctx.strokeStyle = "rgba(178,130,255,0.95)"; ctx.setLineDash(behind ? [5,5] : []) }
      else { ctx.strokeStyle = "rgba(150,130,190,0.42)"; ctx.setLineDash([2,4]) }
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      if(CORE.isRevise(ed)){
        var mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
        var dx = b.x - a.x, dy = b.y - a.y;
        var len = Math.hypot(dx, dy) || 1;
        var curve = clamp(len * 0.28, 12, 70);
        ctx.quadraticCurveTo(mx - dy / len * curve, my + dx / len * curve, b.x, b.y);
      }else{
        ctx.lineTo(b.x, b.y);
      }
      ctx.stroke();
      ctx.setLineDash([]);
    }
    ctx.restore();

    var hoverNode = hoverId ? model.byId[hoverId] : null;
    pickList = [];
    for(var k=0;k<order.length;k++){
      var p = order[k];
      if(!visible(p.node)) continue;
      var style = CORE.nodeStyle(p.node, p.s);
      var alpha = style.color.a;
      if(alpha <= 0.02) continue;
      if(p.node.id === hoverId) alpha = Math.min(1, alpha + 0.2);
      ctx.globalAlpha = alpha;
      var rad = style.radius;
      if(p.node.id === hoverId) rad *= 1.3;
      var fill = "rgb(" + style.color.r + "," + style.color.g + "," + style.color.b + ")";
      if(p.node.kind === "belief" && rad > 1.2 && p.s < 1.7){
        ctx.globalAlpha = alpha * 0.14;
        ctx.fillStyle = fill;
        ctx.beginPath(); ctx.arc(p.x, p.y, rad * 2.4, 0, Math.PI * 2); ctx.fill();
        ctx.globalAlpha = alpha;
      }
      ctx.fillStyle = fill;
      ctx.beginPath(); ctx.arc(p.x, p.y, rad, 0, Math.PI * 2); ctx.fill();
      if(style.rings.length){
        for(var r=0;r<style.rings.length;r++){
          var ring = style.rings[r];
          ctx.globalAlpha = ring.alpha * (visible(p.node) ? 1 : 0);
          ctx.strokeStyle = "rgb(" + ring.color[0] + "," + ring.color[1] + "," + ring.color[2] + ")";
          ctx.lineWidth = ring.width;
          ctx.beginPath(); ctx.arc(p.x, p.y, rad + ring.gap, 0, Math.PI * 2); ctx.stroke();
        }
      }
      if(p.node.id === selectedId){
        ctx.globalAlpha = 0.95;
        ctx.strokeStyle = "rgba(235,245,255,0.95)";
        ctx.lineWidth = 1.2;
        ctx.beginPath(); ctx.arc(p.x, p.y, rad + 5, 0, Math.PI * 2); ctx.stroke();
      }
      if(k < drawN) pickList.push(p);
      ctx.globalAlpha = 1;
    }
    drawLimit = drawN;
    syncDebug();
    if(drawN < model.nodes.length && !drag) scheduleFill();
  }

  function scheduleFill(){
    if(fillTimer || fillTick) return;
    fillTimer = setTimeout(function(){
      fillTimer = null;
      if(!model) return;
      if(drawLimit >= model.nodes.length) return;
      function step(){
        if(!model){ fillTick = null; return }
        drawLimit = CORE.nextDrawLimit(drawLimit, model.nodes.length, CORE.LAYOUT.DRAW_STEP);
        draw();
        if(drawLimit < model.nodes.length) fillTick = setTimeout(step, 16);
        else fillTick = null;
      }
      step();
    }, 200);
  }

  function stopFill(){
    if(fillTimer){ clearTimeout(fillTimer); fillTimer = null }
    if(fillTick){ clearTimeout(fillTick); fillTick = null }
  }

  function selectNode(node){
    if(!node) return;
    selectedId = node.id;
    detail.innerHTML = CORE.panelHtml(node, model);
    setPanel(true);
    draw();
  }

  function setPanel(open){
    panelOpen = !!open;
    panel.classList.toggle("open", panelOpen);
    main.classList.toggle("panel-open", panelOpen);
    panel.setAttribute("aria-hidden", panelOpen ? "false" : "true");
    panelTab.setAttribute("aria-expanded", panelOpen ? "true" : "false");
    panelTab.textContent = panelOpen ? "收起 ▶" : "这一条 ◀";
    syncSize();
    if(model) draw();
    setTimeout(function(){ syncSize(); if(model) draw() }, 240);
  }

  function pickAt(x, y){
    if(!model) return null;
    var candidates = [];
    for(var i=0;i<pickList.length;i++){
      var p = pickList[i];
      if(!p) continue;
      if(!visible(p.node)) continue;
      var dx = p.x - x, dy = p.y - y, d = dx * dx + dy * dy;
      if(d <= 144) candidates.push({ p: p, d: d });
    }
    if(!candidates.length) return null;
    candidates.sort(function(a,b){ return (a.d - b.d) || (a.p.z - b.p.z) });
    return candidates[0].p.node;
  }

  function showHover(node, x, y){
    if(!node){ hover.style.display = "none"; hoverId = null; return }
    hoverId = node.id;
    var label = CORE.TYPE[node.kind] ? CORE.TYPE[node.kind].label : "判断";
    hover.innerHTML = '<div class="ht">' + escapeHtml(CORE.truncate(node.text || "（没留下原话）", 40)) + '</div><div class="hm">' + escapeHtml(label) + " · " + escapeHtml(CORE.dateText(node.at)) + " · " + escapeHtml(CORE.statusText(node)) + '</div>';
    hover.style.display = "block";
    var left = Math.max(12, W - 336);
    hover.style.left = left + "px";
    hover.style.top = "64px";
  }

  function escapeHtml(s){
    return String(s == null ? "" : s).replace(/[&<>"]/g, function(c){
      return c === "&" ? "&amp;" : (c === "<" ? "&lt;" : (c === ">" ? "&gt;" : "&quot;"));
    });
  }

  function load(){
    empty.style.display = "none";
    fetch(API, { cache: "no-store" }).then(function(r){
      if(!r.ok) throw new Error("HTTP " + r.status);
      return r.json();
    }).then(function(data){
      var nodes = data && Array.isArray(data.nodes) ? data.nodes : [];
      if(!nodes.length){
        model = null;
        empty.style.display = "flex";
        why.textContent = "账本里还没有能画成图的点。等她先说出几句判断。";
        return;
      }
      var t0 = performance.now();
      model = CORE.buildModel(data);
      layoutMs = performance.now() - t0;
      drawLimit = CORE.initialDrawLimit(model.nodes.length);
      stopFill();
      updateCount();
      updateSub();
      syncSize();
      draw();
      if(drawLimit < model.nodes.length) scheduleFill();
    }).catch(function(err){
      empty.style.display = "flex";
      why.textContent = "插件没开、页面被挡，或者网络断了。（" + (err && err.message ? err.message : "读不到") + "）";
    });
  }

  canvas.addEventListener("pointerdown", function(ev){
    if(ev.button !== 0) return;
    var r = stage.getBoundingClientRect();
    lastPointer = { x: ev.clientX - r.left, y: ev.clientY - r.top };
    drag = { id: ev.pointerId, x: ev.clientX, y: ev.clientY, q: (view.q || CORE.qDefault(view)).slice(), qVersion: view.qVersion || 0, moved: false, pan: !!ev.shiftKey, panX: view.panX || 0, panY: view.panY || 0 };
    canvas.setPointerCapture(ev.pointerId);
    canvas.classList.add("dragging");
    stopFill();
    if(model && model.nodes.length > CORE.LAYOUT.DRAW_NEAR){ drawLimit = CORE.initialDrawLimit(model.nodes.length) }
    hover.style.display = "none";
    hoverId = null;
  });

  canvas.addEventListener("pointermove", function(ev){
    var r = stage.getBoundingClientRect();
    var x = ev.clientX - r.left, y = ev.clientY - r.top;
    lastPointer = { x: x, y: y };
    if(drag && drag.id === ev.pointerId){
      var dx = ev.clientX - drag.x, dy = ev.clientY - drag.y;
      if(Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
      if (drag.pan) {
        view.panX = drag.panX + dx; view.panY = drag.panY + dy;
        draw();
        return;
      }
      var len = Math.hypot(dx, dy);
      if (len > 0.5) {
        var dq = CORE.qAxis(-dy, dx, 0, len * 0.0055);
        view.q = CORE.qNorm(CORE.qMul(dq, drag.q || CORE.qDefault(view)));
        view.qVersion = (drag.qVersion || 0) + 1;
      }
      draw();
      return;
    }
    if(!model) return;
    var node = pickAt(x, y);
    if(node && hoverId !== node.id){
      showHover(node, x, y);
      draw();
    }else if(!node && hoverId){
      hoverId = null;
      hover.style.display = "none";
      draw();
    }
  });

  function endDrag(ev){
    if(!drag || (ev && drag.id !== ev.pointerId)) return;
    var moved = drag.moved;
    drag = null;
    canvas.classList.remove("dragging");
    if(ev && ev.pointerId != null && canvas.hasPointerCapture && canvas.hasPointerCapture(ev.pointerId)) canvas.releasePointerCapture(ev.pointerId);
    if(!moved && lastPointer){
      var node = pickAt(lastPointer.x, lastPointer.y);
      if(node) selectNode(node);
    }
    if(model && drawLimit < model.nodes.length) scheduleFill();
  }

  canvas.addEventListener("pointerup", endDrag);
  canvas.addEventListener("pointercancel", endDrag);
  canvas.addEventListener("pointerleave", function(){
    if(drag) return;
    hover.style.display = "none";
    if(hoverId){ hoverId = null; draw() }
  });

  canvas.addEventListener("wheel", function(ev){
    ev.preventDefault();
    stopFill();
    if(model && model.nodes.length > CORE.LAYOUT.DRAW_NEAR){ drawLimit = CORE.initialDrawLimit(model.nodes.length) }
    var stepK = Math.max(0.08, view.dist / CORE.VIEW.DIST) * 0.5;
    view.dist = clamp(view.dist + ev.deltaY * stepK, CORE.VIEW.DIST_MIN, CORE.VIEW.DIST_MAX);
    draw();
    if(model && drawLimit < model.nodes.length) scheduleFill();
  }, { passive: false });

  canvas.addEventListener("dblclick", function(ev){
    var r = stage.getBoundingClientRect();
    var node = pickAt(ev.clientX - r.left, ev.clientY - r.top);
    if(!node) resetView();
  });

  document.getElementById("types").addEventListener("click", function(ev){
    var btn = ev.target && ev.target.closest ? ev.target.closest("[data-kind]") : null;
    if(!btn) return;
    var kind = btn.getAttribute("data-kind");
    filter.types[kind] = filter.types[kind] === false;
    btn.classList.toggle("off", filter.types[kind] === false);
    draw();
  });

  document.getElementById("search").addEventListener("input", function(){
    filter.q = this.value.trim().toLowerCase();
    draw();
  });

  document.getElementById("onlyCited").addEventListener("change", function(){
    filter.onlyCited = !!this.checked;
    draw();
  });

  document.getElementById("clearAll").addEventListener("click", function(){
    filter = { types: { belief: true, utterance: false, heard: true }, onlyCited: false, q: "" };
    document.getElementById("search").value = "";
    document.getElementById("onlyCited").checked = false;
    var btns = document.querySelectorAll("[data-kind]");
    for(var i=0;i<btns.length;i++){
      var k = btns[i].getAttribute("data-kind");
      btns[i].classList.toggle("off", filter.types[k] === false);
    }
    resetView();
  });

  document.getElementById("zoomReset").addEventListener("click", resetView);
  panelTab.addEventListener("click", function(){ setPanel(!panelOpen) });
  document.getElementById("panelClose").addEventListener("click", function(){ setPanel(false) });
  document.getElementById("retry").addEventListener("click", load);

  document.addEventListener("keydown", function(ev){
    if(ev.key === "Escape") setPanel(false);
  });

  window.addEventListener("resize", function(){
    syncSize();
    if(model) draw();
  });

  syncSize();
  load();
})();
</script></body></html>`;
