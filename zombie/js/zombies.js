// 丧尸系统
// AI[def.ai](g, z, dt) 只决定意图：设置期望速度 z.mx / z.my（px/s）并发动攻击。
// 移动、击退、泥潭减速、障碍物碰撞由 updateZombie 统一处理。
// 敌方弹幕放在 g.shots，延迟范围攻击（带地面预警）放在 g.hazards。
// 新增丧尸：config.js 的 ZOMBIES 加配置，ai 可复用已有的，也可以在这里加新的。

function makeZombie(type, x, y, hpMul) {
  const def = ZOMBIES[type];
  return {
    type, def, x, y, z: 0, r: def.r, hp: def.hp * hpMul, maxHp: def.hp * hpMul,
    mx: 0, my: 0, kx: 0, ky: 0, facing: 1, phase: rand(0, TAU),
    state: 'walk', timer: 0, cd: rand(0.5, 1.5), atkCd: 0, flash: 0, bumped: false, dead: false,
    pattern: 0, shotT: 1, swordCd: 0,
    seed: Math.random(),   // 外形的随机差异（肤色、血迹、秃头、断臂）
  };
}

// 朝玩家移动，mul 为负时后退；返回与玩家的距离
function seek(g, z, mul = 1) {
  const p = g.player;
  const d = norm(p.x - z.x, p.y - z.y);
  z.mx = d.x * z.def.speed * mul;
  z.my = d.y * z.def.speed * mul;
  return Math.hypot(p.x - z.x, p.y - z.y);
}

// 保持距离的远程移动：太近后退，太远靠近，中间绕着玩家横移
function kite(g, z, range) {
  const p = g.player, d = norm(p.x - z.x, p.y - z.y);
  const dist = Math.hypot(p.x - z.x, p.y - z.y), sp = z.def.speed;
  const radial = dist < range * 0.65 ? -0.8 : dist > range ? 1 : 0;
  z.strafe = z.strafe || (Math.random() < 0.5 ? 1 : -1);
  if (Math.random() < 0.005) z.strafe *= -1;
  z.mx = (d.x * radial - d.y * z.strafe * 0.6) * sp;
  z.my = (d.y * radial + d.x * z.strafe * 0.6) * sp;
  return dist;
}

function touching(g, z, pad = 2) {
  const p = g.player;
  return z.z < 20 && Math.hypot(p.x - z.x, p.y - z.y) < z.r + p.r + pad;
}

function contactHit(g, z, dmg, knock) {
  if (z.atkCd > 0 || !touching(g, z)) return false;
  if (g.hurtPlayer(dmg, z.x, z.y, knock)) { z.atkCd = 0.8; return true; }
  return false;
}

const aimAt = (g, z) => Math.atan2(g.player.y - z.y, g.player.x - z.x);
const isRage = (z) => z.hp < z.maxHp * 0.5;   // BOSS 半血后进入狂暴

function shoot(g, z, angle, s, speedMul = 1, extra = {}) {
  const sp = s.speed * speedMul;
  g.shots.push(Object.assign({
    x: z.x + Math.cos(angle) * z.r * 0.8, y: z.y + Math.sin(angle) * z.r * 0.6,
    vx: Math.cos(angle) * sp, vy: Math.sin(angle) * sp, r: s.r, dmg: s.dmg, color: s.color, life: s.life || 5, turn: s.turn || 0,
  }, extra));
}

function hazard(g, x, y, r, delay, dmg, knock, color = '255,80,40') {
  g.hazards.push({ x, y, r, t: 0, delay, dmg, knock, color });
}

const AI = {
  chase(g, z) {
    seek(g, z);
    contactHit(g, z, z.def.dmg, 220);
  },

  // 一碰就炸：死亡时由 killZombie 触发 def.blast
  bomber(g, z) {
    seek(g, z);
    if (touching(g, z, 4)) g.killZombie(z);
  },

  // 保持距离，前摇后向玩家位置吐毒液（最后 0.2 秒锁定目标，给玩家躲避窗口）
  spitter(g, z, dt) {
    const def = z.def, p = g.player;
    z.cd -= dt;
    if (z.state === 'walk') {
      const dist = seek(g, z, Math.hypot(p.x - z.x, p.y - z.y) < def.range * 0.5 ? -0.4 : 1);
      contactHit(g, z, def.dmg, 150);
      if (dist < def.range && z.cd <= 0) { z.state = 'windup'; z.timer = def.windup; }
    } else if (z.state === 'windup') {
      z.mx = z.my = 0;
      if (z.timer > 0.2) { z.tx = p.x; z.ty = p.y; }
      z.timer -= dt;
      if (z.timer <= 0) {
        spawnSpit(g, z);
        z.state = 'walk';
        z.cd = def.cooldown;
      }
    }
  },

  // 巨兽：走近 → 笨拙前摇（显示冲撞方向）→ 冲撞 → 硬直
  boss(g, z, dt) {
    const def = z.def, p = g.player;
    z.cd -= dt;
    if (z.state === 'walk') {
      const dist = seek(g, z);
      contactHit(g, z, def.dmg, 380);
      if (dist < def.range && z.cd <= 0) { z.state = 'windup'; z.timer = def.windup; }
    } else if (z.state === 'windup') {
      z.mx = z.my = 0;
      z.timer -= dt;
      if (z.timer > 0.3) { const d = norm(p.x - z.x, p.y - z.y); z.cdx = d.x; z.cdy = d.y; }
      if (z.timer <= 0) { z.state = 'charge'; z.timer = def.chargeTime; z.hitPlayer = false; }
    } else if (z.state === 'charge') {
      z.mx = z.cdx * def.chargeSpeed;
      z.my = z.cdy * def.chargeSpeed;
      z.timer -= dt;
      if (Math.random() < 0.6) g.burst(z.x, z.y, 0, 1, '#8a7a5a', { speed: 60, up: 60, life: 0.4, size: 4 });
      if (!z.hitPlayer && touching(g, z, 6) && g.hurtPlayer(def.chargeDmg, z.x, z.y, 750)) {
        z.hitPlayer = true;
        g.shake = Math.max(g.shake, 14);
      }
      if (z.bumped) g.shake = Math.max(g.shake, 10);
      if (z.timer <= 0 || z.bumped) { z.state = 'recover'; z.timer = def.recover; }
    } else if (z.state === 'recover') {
      z.mx = z.my = 0;
      z.timer -= dt;
      if (z.timer <= 0) { z.state = 'walk'; z.cd = def.cooldown * (isRage(z) ? 0.6 : 1); }
    }
  },

  // 远程 BOSS：绕着玩家走位，轮流使用 扇形 / 环形 / 双层扇形 弹幕
  ranged(g, z, dt) {
    const def = z.def, rage = isRage(z);
    z.cd -= dt;
    if (z.state === 'walk') {
      kite(g, z, def.range);
      contactHit(g, z, def.dmg, 300);
      if (z.cd <= 0) { z.state = 'windup'; z.timer = def.windup; z.pattern = (z.pattern + 1) % 3; }
    } else if (z.state === 'windup') {
      z.mx = z.my = 0;
      if ((z.timer -= dt) > 0) return;
      const a = aimAt(g, z), s = def.shot;
      if (z.pattern === 0) {
        const n = rage ? 11 : 7;
        for (let i = 0; i < n; i++) shoot(g, z, a + (i - (n - 1) / 2) * 0.14, s);
      } else if (z.pattern === 1) {
        const n = rage ? 26 : 18, off = rand(0, TAU);
        for (let i = 0; i < n; i++) shoot(g, z, off + (i / n) * TAU, s, 0.85);
      } else {
        for (let i = 0; i < 5; i++) { shoot(g, z, a + (i - 2) * 0.22, s, 1.25); shoot(g, z, a + (i - 1.5) * 0.22, s, 0.8); }
      }
      g.shake = Math.max(g.shake, 3);
      z.state = 'walk';
      z.cd = def.cooldown * (rage ? 0.6 : 1);
    }
  },

  // 范围 BOSS：震地（以自身为中心的大圈）和陨石雨（玩家周围多个小圈），狂暴后两招同时放
  slam(g, z, dt) {
    const def = z.def, p = g.player, rage = isRage(z);
    z.cd -= dt;
    if (z.state === 'walk') {
      seek(g, z);
      contactHit(g, z, def.dmg, 450);
      if (z.cd > 0) return;
      z.state = 'windup';
      z.timer = def.windup;
      z.pattern = (z.pattern + 1) % 2;
      if (z.pattern === 0 || rage) {
        const s = def.slam;
        hazard(g, z.x, z.y, s.r, def.windup, s.dmg, s.knock);
      }
      if (z.pattern === 1 || rage) {
        const m = def.meteor, n = m.n + (rage ? 3 : 0);
        hazard(g, p.x, p.y, m.r, def.windup + 0.2, m.dmg, m.knock);
        for (let i = 1; i < n; i++) {
          const a = rand(0, TAU), d = rand(40, m.spread);
          hazard(g, clamp(p.x + Math.cos(a) * d, 0, W), clamp(p.y + Math.sin(a) * d, 0, H), m.r, def.windup + 0.2 + i * 0.12, m.dmg, m.knock);
        }
      }
    } else if (z.state === 'windup') {
      z.mx = z.my = 0;
      if ((z.timer -= dt) <= 0) { z.state = 'recover'; z.timer = def.recover; }
    } else if (z.state === 'recover') {
      z.mx = z.my = 0;
      if ((z.timer -= dt) <= 0) { z.state = 'walk'; z.cd = def.cooldown * (rage ? 0.65 : 1); }
    }
  },

  // 追踪 BOSS：移动很快，交替发射追踪光球和飞扑（落点有预警）
  hunter(g, z, dt) {
    const def = z.def, p = g.player, rage = isRage(z);
    z.cd -= dt;
    if (z.state === 'walk') {
      seek(g, z, rage ? 1.25 : 1);
      contactHit(g, z, def.dmg, 380);
      if (z.cd <= 0) { z.state = 'windup'; z.timer = def.windup; z.pattern = (z.pattern + 1) % 2; }
    } else if (z.state === 'windup') {
      z.mx = z.my = 0;
      if ((z.timer -= dt) > 0) return;
      if (z.pattern === 0) {
        const o = def.orb, n = o.n + (rage ? 2 : 0), a = aimAt(g, z);
        for (let i = 0; i < n; i++) shoot(g, z, a + (i - (n - 1) / 2) * 0.6, o);
        z.state = 'walk';
        z.cd = def.cooldown * (rage ? 0.6 : 1);
      } else {
        const L = def.leap;
        z.sx = z.x; z.sy = z.y; z.tx = p.x; z.ty = p.y;
        z.state = 'leap';
        z.timer = 0;
        hazard(g, p.x, p.y, L.r, L.time, L.dmg, L.knock);
      }
    } else if (z.state === 'leap') {
      const L = def.leap;
      z.timer += dt;
      const k = Math.min(1, z.timer / L.time);
      z.mx = z.my = 0;
      z.x = lerp(z.sx, z.tx, k);
      z.y = lerp(z.sy, z.ty, k);
      z.z = Math.sin(k * Math.PI) * 140;
      if (k >= 1) { z.z = 0; z.state = 'recover'; z.timer = 0.45; }
    } else if (z.state === 'recover') {
      z.mx = z.my = 0;
      if ((z.timer -= dt) <= 0) { z.state = 'walk'; z.cd = def.cooldown * (rage ? 0.6 : 1); }
    }
  },

  // 召唤 BOSS：远离玩家，定时发射弹幕，前摇后在身边召唤一批小丧尸
  summoner(g, z, dt) {
    const def = z.def, rage = isRage(z);
    z.cd -= dt;
    z.shotT -= dt;
    if (z.state === 'walk') {
      kite(g, z, def.range);
      contactHit(g, z, def.dmg, 300);
      if (z.shotT <= 0) {
        const a = aimAt(g, z);
        for (let i = -1; i <= 1; i++) shoot(g, z, a + i * 0.25, def.shot);
        z.shotT = def.shotRate * (rage ? 0.6 : 1);
      }
      if (z.cd <= 0) { z.state = 'windup'; z.timer = def.windup; }
    } else if (z.state === 'windup') {
      z.mx = z.my = 0;
      if (Math.random() < 0.5) g.burst(z.x + rand(-40, 40), z.y + rand(-20, 20), 0, 1, '#b07aff', { speed: 20, up: 120, grav: -50, life: 0.6, size: 4 });
      if ((z.timer -= dt) > 0) return;
      const s = def.summon, n = s.n + (rage ? 3 : 0);
      for (let i = 0; i < n && g.zombies.length < s.cap; i++) {
        const a = (i / n) * TAU, x = z.x + Math.cos(a) * (z.r + 30), y = z.y + Math.sin(a) * (z.r + 30);
        g.zombies.push(makeZombie(s.types[Math.floor(Math.random() * s.types.length)], x, y, g.hpMul()));
        g.burst(x, y, 0, 8, '#b07aff', { speed: 80, up: 100, life: 0.5, size: 3 });
      }
      z.state = 'walk';
      z.cd = def.cooldown * (rage ? 0.7 : 1);
    }
  },
};

function updateZombie(g, z, dt) {
  z.flash -= dt;
  z.atkCd -= dt;
  z.swordCd -= dt;
  AI[z.def.ai](g, z, dt);
  if (z.dead) return;

  z.bumped = false;
  const slow = z.z === 0 && z.state !== 'charge' && g.inMud(z.x, z.y) ? CONFIG.mudSlow.zombie : 1;
  z.x += (z.mx * slow + z.kx) * dt;
  z.y += (z.my * slow + z.ky) * dt;
  const kd = Math.exp(-7 * dt);
  z.kx *= kd; z.ky *= kd;

  if (z.z < 30) {   // 飞扑中越过障碍物
    for (const o of g.obstacles) {
      if (o.dead) continue;
      const c = circleRect(z.x, z.y, z.r, o);
      if (!c) continue;
      z.x += c.nx * c.depth; z.y += c.ny * c.depth;
      if (z.state === 'charge' && isFinite(o.hp)) g.damageObstacle(o, 9999);   // 冲撞撞碎木箱和油桶
      else z.bumped = true;
    }
  }
  z.x = clamp(z.x, -80, W + 80);
  z.y = clamp(z.y, -80, H + 80);

  const moving = Math.abs(z.mx) + Math.abs(z.my) > 1;
  z.facing = moving ? (z.mx >= 0 ? 1 : -1) : (g.player.x >= z.x ? 1 : -1);
  z.phase += Math.hypot(z.mx, z.my) * slow * dt * 0.08;
}

// 毒液：抛物线飞向目标点，命中玩家造成撞击+中毒，落地形成毒液水洼
function spawnSpit(g, z) {
  const s = z.def.spit;
  const dist = Math.hypot(z.tx - z.x, z.ty - z.y);
  g.spits.push({ x: z.x, y: z.y, z: 30, sx: z.x, sy: z.y, tx: z.tx, ty: z.ty, t: 0, dur: Math.max(0.25, dist / s.speed), def: s });
}

function updateSpit(g, s, dt) {
  s.t += dt;
  const k = Math.min(1, s.t / s.dur);
  s.x = lerp(s.sx, s.tx, k);
  s.y = lerp(s.sy, s.ty, k);
  s.z = 30 * (1 - k) + Math.sin(k * Math.PI) * 45;

  const p = g.player;
  if (k > 0.1 && Math.hypot(p.x - s.x, p.y - s.y) < p.r + 8 && g.hurtPlayer(s.def.hitDmg, s.sx, s.sy, 120)) {
    g.poisonPlayer(s.def.poisonDps, s.def.poisonTime);
    g.burst(s.x, s.y, 20, 10, '#9ad13a', { speed: 120, up: 80 });
    s.dead = true;
    return;
  }
  const blocked = g.obstacles.some((o) => !o.dead && s.z < o.height && pointInRect(s.x, s.y, o));
  if (k >= 1 || blocked) {
    s.dead = true;
    g.puddles.push({ x: s.x, y: s.y, r: s.def.puddleR, life: s.def.puddleTime, max: s.def.puddleTime, def: s.def });
    g.burst(s.x, s.y, 4, 8, '#9ad13a', { speed: 90, up: 60 });
  }
}

// 敌方弹幕：可选追踪（turn），撞墙消失
function updateShot(g, s, dt) {
  const p = g.player;
  s.life -= dt;
  if (s.turn) {
    const sp = Math.hypot(s.vx, s.vy), a = Math.atan2(s.vy, s.vx);
    let da = Math.atan2(p.y - s.y, p.x - s.x) - a;
    da = Math.atan2(Math.sin(da), Math.cos(da));
    const na = a + clamp(da, -s.turn * dt, s.turn * dt);
    s.vx = Math.cos(na) * sp; s.vy = Math.sin(na) * sp;
  }
  s.x += s.vx * dt; s.y += s.vy * dt;
  if (s.life <= 0 || s.x < -30 || s.x > W + 30 || s.y < -30 || s.y > H + 30) { s.dead = true; return; }
  if (g.obstacles.some((o) => !o.dead && pointInRect(s.x, s.y, o))) {
    s.dead = true;
    g.sparks(s.x, s.y, 16, s.color, 4);
    return;
  }
  if (Math.hypot(p.x - s.x, p.y - s.y) < p.r + s.r) {
    if (g.hurtPlayer(s.dmg, s.x - s.vx, s.y - s.vy, 160)) {
      s.dead = true;
      g.sparks(s.x, s.y, 20, s.color, 6);
    }
  }
}

// 延迟范围攻击：预警圈逐渐填满，时间到时结算
function updateHazard(g, h, dt) {
  h.t += dt;
  if (h.t < h.delay) return;
  h.dead = true;
  g.shake = Math.max(g.shake, 8);
  g.rings.push({ x: h.x, y: h.y, r: h.r, life: 0.35, max: 0.35 });
  g.burst(h.x, h.y, 4, 16, '#a08060', { speed: h.r * 2, up: 160, life: 0.5, size: 4 });
  g.decals.push({ x: h.x, y: h.y, r: h.r * 0.35, life: 12 });
  const p = g.player;
  if (Math.hypot(p.x - h.x, (p.y - h.y) / 0.6) < h.r + p.r * 0.5) g.hurtPlayer(h.dmg, h.x, h.y, h.knock);
  for (const o of g.obstacles) if (rectCircleDist(h.x, h.y, o) < h.r * 0.5) g.damageObstacle(o, 40);
}
