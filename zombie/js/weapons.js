// 武器系统
// FIRE[type]：开火时调用，负责生成飞行物或直接结算（激光）。
// PROJECTILES[kind]：飞行物每帧更新，设置 p.dead = true 即移除。
// 新增武器类型：在两个表里各加一个函数，再到 config.js 的 WEAPONS 里加配置。

const GRAVITY = 900;

const FIRE = {
  bullet(g, def, o) {
    const a = Math.atan2(o.dy, o.dx) + rand(-def.spread, def.spread);
    g.projectiles.push({
      kind: 'bullet', def, x: o.x, y: o.y, z: CONFIG.gunHeight,
      vx: Math.cos(a) * def.speed, vy: Math.sin(a) * def.speed,
      life: 1.6, pierce: (def.pierce || 0) + g.player.pierce, hit: new Set(),
    });
  },

  // 激光瞬间命中：沿射线穿透所有丧尸，碰到障碍物反射
  laser(g, def, o) {
    const pts = laserPath(g, o.x, o.y, o.dx, o.dy, def.range, def.bounces);
    const hit = new Set();
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1], b = pts[i];
      const d = norm(b.x - a.x, b.y - a.y);
      for (const z of g.zombies) {
        if (z.dead || hit.has(z)) continue;
        if (segDist(z.x, z.y, a.x, a.y, b.x, b.y) < z.r + 4) {
          hit.add(z);
          g.damageZombie(z, def.dmg, d.x, d.y, def.knock);
        }
      }
      if (b.obs) {
        g.damageObstacle(b.obs, def.dmg * 0.5);
        g.sparks(b.x, b.y, CONFIG.gunHeight, def.color, 2);
      }
    }
    g.beams.push({ pts, life: 0.08, max: 0.08, color: def.color });
  },

  grenade(g, def, o) {
    g.projectiles.push({
      kind: 'grenade', def, x: o.x, y: o.y, z: CONFIG.gunHeight, vz: def.lift,
      vx: o.dx * def.speed, vy: o.dy * def.speed, t: 0, hitCd: 0, spin: 0,
    });
  },

  rocket(g, def, o) {
    g.projectiles.push({
      kind: 'rocket', def, x: o.x, y: o.y, z: CONFIG.gunHeight,
      dx: o.dx, dy: o.dy, speed: def.speed0, t: 0,
    });
  },
};

// 计算激光折线：每段找最近的障碍物，按表面法线反射
function laserPath(g, x, y, dx, dy, range, bounces) {
  const pts = [{ x, y }];
  let left = range;
  for (let i = 0; i <= bounces && left > 0; i++) {
    let t = Math.min(edgeDist(x, y, dx, dy), left), n = null, obs = null;
    for (const o of g.obstacles) {
      if (o.dead) continue;
      const h = rayRect(x, y, dx, dy, o);
      if (h && h.t < t) { t = h.t; n = h; obs = o; }
    }
    x += dx * t; y += dy * t; left -= t;
    pts.push({ x, y, obs });
    if (!n) break;
    const d = dx * n.nx + dy * n.ny;
    dx -= 2 * d * n.nx; dy -= 2 * d * n.ny;
    x += dx * 0.5; y += dy * 0.5;   // 离开表面，避免下一段立刻再次命中
  }
  return pts;
}

// 鸟：把速度方向朝前方锥形范围内最近的丧尸转动（turn 为最大角速度 rad/s），保持速度大小
function homing(g, p, turn, dt) {
  const sp = Math.hypot(p.vx, p.vy);
  if (sp < 1) return;
  const a = Math.atan2(p.vy, p.vx);
  let target = null, best = PETS.bird.range;
  for (const z of g.zombies) {
    if (z.dead || (p.hit && p.hit.has(z))) continue;
    const d = Math.hypot(z.x - p.x, z.y - p.y);
    let da = Math.atan2(z.y - p.y, z.x - p.x) - a;
    da = Math.atan2(Math.sin(da), Math.cos(da));
    if (d < best && Math.abs(da) < 1.2) { best = d; target = da; }
  }
  if (target === null) return;
  const na = a + clamp(target, -turn * dt, turn * dt);
  p.vx = Math.cos(na) * sp; p.vy = Math.sin(na) * sp;
}

const PROJECTILES = {
  // 子弹分步移动，防止高速穿过小目标
  bullet(g, p, dt) {
    if (g.pets.bird) homing(g, p, PETS.bird.turn, dt);
    const steps = Math.max(1, Math.ceil(Math.hypot(p.vx, p.vy) * dt / 8));
    const sx = p.vx * dt / steps, sy = p.vy * dt / steps;
    p.life -= dt;
    for (let i = 0; i < steps; i++) {
      p.x += sx; p.y += sy;
      if (p.life <= 0 || p.x < -50 || p.x > W + 50 || p.y < -50 || p.y > H + 50) { p.dead = true; return; }
      for (const o of g.obstacles) {
        if (g.pets.ghost) break;   // 幽灵：子弹穿墙
        if (!o.dead && pointInRect(p.x, p.y, o)) {
          g.damageObstacle(o, p.def.dmg);
          g.sparks(p.x, p.y, p.z, '#ddd', 4);
          p.dead = true;
          return;
        }
      }
      for (const z of g.zombies) {
        if (z.dead || p.hit.has(z) || Math.hypot(z.x - p.x, z.y - p.y) > z.r + 3) continue;
        p.hit.add(z);
        const d = norm(p.vx, p.vy);
        g.damageZombie(z, p.def.dmg, d.x, d.y, p.def.knock);
        if (p.pierce-- <= 0) { p.dead = true; return; }
      }
    }
  },

  // 榴弹：竖直方向受重力（z 轴），落地弹跳；水平方向撞墙/撞丧尸反弹；引信到时爆炸
  grenade(g, p, dt) {
    const def = p.def;
    p.t += dt; p.hitCd -= dt;
    p.vz -= GRAVITY * dt;
    p.z += p.vz * dt;
    if (p.z < 0) {
      p.z = 0;
      p.vz = p.vz < -60 ? -p.vz * 0.45 : 0;
      p.vx *= 0.72; p.vy *= 0.72;
    }
    if (p.z === 0) { const f = Math.exp(-3 * dt); p.vx *= f; p.vy *= f; }
    p.x += p.vx * dt; p.y += p.vy * dt;

    for (const o of g.obstacles) {
      if (o.dead || p.z >= o.height) continue;   // 飞得比障碍物高就越过去
      const c = circleRect(p.x, p.y, 6, o);
      if (c) { p.x += c.nx * c.depth; p.y += c.ny * c.depth; reflect(p, c.nx, c.ny, 0.6); }
    }
    if (p.x < 6) { p.x = 6; p.vx = Math.abs(p.vx) * 0.6; }
    if (p.x > W - 6) { p.x = W - 6; p.vx = -Math.abs(p.vx) * 0.6; }
    if (p.y < 6) { p.y = 6; p.vy = Math.abs(p.vy) * 0.6; }
    if (p.y > H - 6) { p.y = H - 6; p.vy = -Math.abs(p.vy) * 0.6; }

    // 撞击伤害：速度越快越疼
    const sp = Math.hypot(p.vx, p.vy);
    if (p.hitCd <= 0 && sp > 150 && p.z < 50) {
      for (const z of g.zombies) {
        if (z.dead || Math.hypot(z.x - p.x, z.y - p.y) > z.r + 6) continue;
        const n = norm(p.x - z.x, p.y - z.y);
        g.damageZombie(z, def.dmg * sp / def.speed, -n.x, -n.y, 160);
        reflect(p, n.x, n.y, 0.5);
        p.hitCd = 0.15;
        break;
      }
    }
    p.spin += sp * dt * 0.05;
    if (p.t >= def.fuse) { p.dead = true; g.explode(p.x, p.y, def.blast, true); }
  },

  // 导弹：先慢速飘出，点火后急加速；撞到任何东西或飞出边缘即爆炸
  rocket(g, p, dt) {
    const def = p.def;
    p.t += dt;
    if (p.t > def.ignite) p.speed = Math.min(def.maxSpeed, p.speed + def.accel * dt);
    if (g.pets.bird && p.t > def.ignite) {
      const v = { vx: p.dx, vy: p.dy };
      homing(g, Object.assign(v, { x: p.x, y: p.y }), PETS.bird.rocketTurn, dt);
      const n = norm(v.vx, v.vy); p.dx = n.x; p.dy = n.y;
    }
    if (Math.random() < 0.8) {
      g.burst(p.x - p.dx * 12, p.y - p.dy * 12, p.z, 1, 'rgba(210,210,210,0.7)',
        { speed: 20, up: 15, grav: -40, life: 0.6, size: p.t > def.ignite ? 6 : 3 });
    }
    const steps = Math.max(1, Math.ceil(p.speed * dt / 10));
    const step = p.speed * dt / steps;
    for (let i = 0; i < steps; i++) {
      p.x += p.dx * step; p.y += p.dy * step;
      let boom = p.x < 0 || p.x > W || p.y < 0 || p.y > H;
      if (boom) { p.x = clamp(p.x, 0, W); p.y = clamp(p.y, 0, H); }
      boom = boom
        || (!g.pets.ghost && g.obstacles.some((o) => !o.dead && circleRect(p.x, p.y, 4, o)))
        || g.zombies.some((z) => !z.dead && Math.hypot(z.x - p.x, z.y - p.y) < z.r + 6);
      if (boom) { p.dead = true; g.explode(p.x, p.y, def.blast, true); return; }
    }
  },
};
