// 通用数学与碰撞工具
const TAU = Math.PI * 2;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const rand = (a, b) => a + Math.random() * (b - a);
const lerp = (a, b, t) => a + (b - a) * t;

function norm(x, y) {
  const l = Math.hypot(x, y) || 1;
  return { x: x / l, y: y / l };
}

function weightedPick(items) {
  const total = items.reduce((s, it) => s + it.w, 0);
  let r = Math.random() * total;
  for (const it of items) { r -= it.w; if (r <= 0) return it; }
  return items[items.length - 1];
}

function pointInRect(x, y, r) {
  return x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;
}

// 圆与矩形相交：返回把圆推出去的法线和深度，不相交返回 null
function circleRect(cx, cy, cr, r) {
  const px = clamp(cx, r.x, r.x + r.w), py = clamp(cy, r.y, r.y + r.h);
  const dx = cx - px, dy = cy - py, d2 = dx * dx + dy * dy;
  if (d2 >= cr * cr) return null;
  if (d2 > 1e-9) {
    const d = Math.sqrt(d2);
    return { nx: dx / d, ny: dy / d, depth: cr - d };
  }
  // 圆心在矩形内部：沿最近的边推出
  const l = cx - r.x, rt = r.x + r.w - cx, t = cy - r.y, b = r.y + r.h - cy;
  const m = Math.min(l, rt, t, b);
  if (m === l) return { nx: -1, ny: 0, depth: l + cr };
  if (m === rt) return { nx: 1, ny: 0, depth: rt + cr };
  if (m === t) return { nx: 0, ny: -1, depth: t + cr };
  return { nx: 0, ny: 1, depth: b + cr };
}

function rectCircleDist(cx, cy, r) {
  const px = clamp(cx, r.x, r.x + r.w), py = clamp(cy, r.y, r.y + r.h);
  return Math.hypot(cx - px, cy - py);
}

// 射线与矩形（slab 法）：(dx, dy) 为单位向量，返回最近交点距离与表面法线
function rayRect(ox, oy, dx, dy, r) {
  let tmin = -Infinity, tmax = Infinity, nx = 0, ny = 0;
  if (Math.abs(dx) > 1e-9) {
    let t1 = (r.x - ox) / dx, t2 = (r.x + r.w - ox) / dx, n = -1;
    if (t1 > t2) { [t1, t2] = [t2, t1]; n = 1; }
    if (t1 > tmin) { tmin = t1; nx = n; ny = 0; }
    tmax = Math.min(tmax, t2);
  } else if (ox < r.x || ox > r.x + r.w) return null;
  if (Math.abs(dy) > 1e-9) {
    let t1 = (r.y - oy) / dy, t2 = (r.y + r.h - oy) / dy, n = -1;
    if (t1 > t2) { [t1, t2] = [t2, t1]; n = 1; }
    if (t1 > tmin) { tmin = t1; nx = 0; ny = n; }
    tmax = Math.min(tmax, t2);
  } else if (oy < r.y || oy > r.y + r.h) return null;
  if (tmin < 1e-6 || tmax < tmin) return null;
  return { t: tmin, nx, ny };
}

// 射线到场地边缘的距离
function edgeDist(ox, oy, dx, dy) {
  const tx = dx > 0 ? (W - ox) / dx : dx < 0 ? -ox / dx : Infinity;
  const ty = dy > 0 ? (H - oy) / dy : dy < 0 ? -oy / dy : Infinity;
  return Math.max(0, Math.min(tx, ty));
}

// 点到线段的距离
function segDist(px, py, ax, ay, bx, by) {
  const abx = bx - ax, aby = by - ay;
  const t = clamp(((px - ax) * abx + (py - ay) * aby) / (abx * abx + aby * aby || 1), 0, 1);
  return Math.hypot(px - (ax + abx * t), py - (ay + aby * t));
}

// 速度沿法线反射，e 为弹性系数（只在朝向表面运动时反射）
function reflect(o, nx, ny, e) {
  const d = o.vx * nx + o.vy * ny;
  if (d < 0) { o.vx -= (1 + e) * d * nx; o.vy -= (1 + e) * d * ny; }
}
