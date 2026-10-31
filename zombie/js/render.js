// 渲染：伪 2D。地面坐标 (x, y)，高度 z 画成向上偏移 (x, y - z)。
// 场景物体按脚底 y 排序后绘制，靠下的遮挡靠上的，形成侧面纵深感。

const FONT = '"Microsoft YaHei", "PingFang SC", system-ui, sans-serif';

// 地面按主题颜色画一次，缓存到离屏画布
const GROUND_CACHE = {};
function groundFor(color) {
  if (!GROUND_CACHE[color]) GROUND_CACHE[color] = makeGround(color);
  return GROUND_CACHE[color];
}
function makeGround(color) {
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const x = c.getContext('2d');
  x.fillStyle = color;
  x.fillRect(0, 0, W, H);
  for (let i = 0; i < W; i += 64) {
    for (let j = 0; j < H; j += 64) {
      if (((i + j) / 64) % 2 === 0) { x.fillStyle = 'rgba(255,255,255,0.025)'; x.fillRect(i, j, 64, 64); }
    }
  }
  for (let i = 0; i < 900; i++) {
    x.fillStyle = Math.random() < 0.5 ? 'rgba(0,0,0,0.12)' : 'rgba(255,255,255,0.05)';
    x.fillRect(rand(0, W), rand(0, H), rand(1, 3), rand(1, 3));
  }
  return c;
}

function drawShadow(ctx, x, y, r, a = 0.3) {
  ctx.fillStyle = `rgba(0,0,0,${a})`;
  ctx.beginPath();
  ctx.ellipse(x, y, r * 1.1, r * 0.45, 0, 0, TAU);
  ctx.fill();
}

// 人形角色（玩家与丧尸共用）。以 r=14 为基准尺寸绘制，再按 r 缩放；脚底在 (x, y)
function drawHumanoid(ctx, x, y, r, c, facing, phase, o = {}) {
  const s = r / 14;
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(facing * s, s);
  if (o.rot) { ctx.translate(0, -22); ctx.rotate(o.rot); ctx.translate(0, 22); }
  const col = o.flash ? { body: '#fff', head: '#fff', legs: '#fff' } : c;
  const sw = Math.sin(phase) * 6;
  ctx.lineCap = 'round';
  ctx.strokeStyle = col.legs;
  ctx.lineWidth = 5;
  ctx.beginPath();
  ctx.moveTo(-3, -16); ctx.lineTo(-3 + sw, 0);
  ctx.moveTo(3, -16); ctx.lineTo(3 - sw, 0);
  ctx.stroke();
  ctx.fillStyle = col.body;
  ctx.beginPath();
  ctx.roundRect(-8, -36, 16, 22, 5);
  ctx.fill();
  ctx.fillStyle = col.head;
  ctx.beginPath();
  ctx.arc(1, -43, 8, 0, TAU);
  ctx.fill();
  ctx.fillStyle = '#222';
  ctx.fillRect(4, -45, 2.5, 2.5);
  ctx.restore();
}

// 颜色明暗调整：amt > 0 变亮，< 0 变暗（结果缓存）
const SHADE_CACHE = {};
function shade(hex, amt) {
  const key = hex + amt;
  if (!SHADE_CACHE[key]) {
    const n = parseInt(hex.slice(1), 16), f = (v) => clamp(Math.round(v + amt * 255), 0, 255);
    SHADE_CACHE[key] = `rgb(${f(n >> 16)},${f((n >> 8) & 255)},${f(n & 255)})`;
  }
  return SHADE_CACHE[key];
}

const dot = (ctx, x, y, r) => { ctx.beginPath(); ctx.arc(x, y, r, 0, TAU); ctx.fill(); };

// 丧尸外形参数：w 体宽，hunch 驼背角度，head 头部缩放，arm 手臂粗细，eye 眼睛颜色
// 其余开关：spikes 背部骨刺，horns 头顶骨角，ribs 露出肋骨，fist 石拳，plates 石甲，claws 利爪，robe 兜帽长袍
const ZOMBIE_LOOK = {
  walker:        { w: 1,    hunch: 0.25, head: 1,    arm: 4,   eye: '#ff3b2f' },
  tank:          { w: 1.5,  hunch: 0.12, head: 0.85, arm: 6,   eye: '#ff3b2f' },
  bomber:        { w: 1.15, hunch: 0.2,  head: 1,    arm: 4,   eye: '#ffb020' },
  spitter:       { w: 1,    hunch: 0.32, head: 1.05, arm: 4,   eye: '#d8ff3a' },
  boss:          { w: 1.45, hunch: 0.38, head: 0.85, arm: 6.5, eye: '#ff3b2f', spikes: true },
  boss_ranged:   { w: 0.95, hunch: 0.15, head: 1,    arm: 3.5, eye: '#ffe27a', horns: true, ribs: true },
  boss_slam:     { w: 1.6,  hunch: 0.2,  head: 0.8,  arm: 7,   eye: '#ff7a2a', fist: true, plates: true },
  boss_hunter:   { w: 0.9,  hunch: 0.55, head: 0.95, arm: 4,   eye: '#ffdd33', spikes: true, claws: true },
  boss_summoner: { w: 1.1,  hunch: 0.1,  head: 1,    arm: 3.5, eye: '#c08aff', robe: true },
};

// 弯膝的腿：髋 → 膝 → 脚踝 → 脚尖
function zLeg(ctx, hx, d, color, lw) {
  ctx.strokeStyle = color;
  ctx.lineWidth = lw;
  ctx.beginPath();
  ctx.moveTo(hx, -16); ctx.lineTo(hx + d * 0.5 + 1.5, -8); ctx.lineTo(hx + d, -1); ctx.lineTo(hx + d + 3, 0);
  ctx.stroke();
}

// 前伸的手臂：肩 → 肘 → 手，手上画三根手指（或利爪 / 石拳）。前摇时手臂抬起
function zArm(ctx, L, sx, sy, w, color, wob, lift, fl) {
  const ex = sx + 5 + w, ey = sy + 2 - lift * 0.4;
  const hx = sx + 10 + 3 * w, hy = sy + 3 + wob - lift;
  ctx.strokeStyle = color;
  ctx.lineWidth = L.arm;
  ctx.beginPath(); ctx.moveTo(sx, sy); ctx.lineTo(ex, ey); ctx.lineTo(hx, hy); ctx.stroke();
  if (L.fist) {
    ctx.fillStyle = fl ? '#fff' : '#7a746c';
    dot(ctx, hx + 1, hy, 4.5);
    return;
  }
  const len = L.claws ? 6 : 3;
  if (L.claws) ctx.strokeStyle = fl ? '#fff' : '#e8e0c8';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  for (let i = -1; i <= 1; i++) { ctx.moveTo(hx, hy); ctx.lineTo(hx + len, hy + i * 1.6 + len * 0.25); }
  ctx.stroke();
}

// 躯干上的细节：破洞、血迹，以及各类型的特征
function zTorsoDetail(ctx, L, z, w, skin, t) {
  ctx.fillStyle = skin;
  ctx.beginPath(); ctx.moveTo(3 * w, -28); ctx.lineTo(6 * w, -25); ctx.lineTo(4.5 * w, -20); ctx.lineTo(1.5 * w, -23); ctx.closePath(); ctx.fill();
  ctx.fillStyle = 'rgba(110,10,10,0.75)';
  ctx.beginPath(); ctx.ellipse(((z.seed * 7) % 1 - 0.5) * 8 * w, -18 - ((z.seed * 13) % 1) * 10, 2.8, 2, 0.4, 0, TAU); ctx.fill();

  if (z.type === 'tank') {
    // 鼓起的肚子和缝合线
    ctx.fillStyle = skin;
    ctx.beginPath(); ctx.ellipse(4 * w, -22, 4.5, 6, 0, 0, TAU); ctx.fill();
    ctx.strokeStyle = '#2a1a10'; ctx.lineWidth = 0.9;
    ctx.beginPath(); ctx.moveTo(4 * w, -27); ctx.lineTo(4 * w, -17);
    for (let y = -26; y <= -18; y += 2.5) { ctx.moveTo(4 * w - 1.5, y); ctx.lineTo(4 * w + 1.5, y); }
    ctx.stroke();
  }
  if (L.ribs) {
    ctx.fillStyle = 'rgba(30,20,30,0.85)';
    ctx.beginPath(); ctx.ellipse(2 * w, -25, 4.5 * w, 6, 0, 0, TAU); ctx.fill();
    ctx.strokeStyle = '#e8e0c8'; ctx.lineWidth = 1.3;
    ctx.beginPath();
    for (let i = 0; i < 3; i++) { const y = -29 + i * 3.5; ctx.moveTo(-1.5 * w, y); ctx.quadraticCurveTo(2 * w, y - 1.5, 5.5 * w, y + 1); }
    ctx.stroke();
  }
  if (L.plates) {
    // 肩上和胸口的石甲
    ctx.fillStyle = '#8a847a'; ctx.strokeStyle = 'rgba(0,0,0,0.4)'; ctx.lineWidth = 1.2;
    ctx.beginPath(); ctx.roundRect(-6 * w, -39, 9 * w, 7, 2); ctx.roundRect(-3 * w, -27, 8 * w, 6, 2); ctx.fill(); ctx.stroke();
    ctx.strokeStyle = '#4a4640'; ctx.lineWidth = 0.9;
    ctx.beginPath(); ctx.moveTo(-2 * w, -39); ctx.lineTo(-1 * w, -35); ctx.lineTo(-2.5 * w, -32); ctx.moveTo(2 * w, -27); ctx.lineTo(1 * w, -23); ctx.stroke();
  }
  if (z.type === 'bomber') {
    // 随时要爆的脓包
    const a = 0.5 + 0.5 * Math.sin(t * 12);
    ctx.fillStyle = `rgb(255,${(140 + 80 * a) | 0},60)`;
    for (const [px, py, pr] of [[4, -26, 2.4], [-3, -21, 2], [2, -17, 2.8], [-5, -30, 1.6]]) dot(ctx, px * w, py, pr);
    ctx.fillStyle = 'rgba(255,255,220,0.8)';
    dot(ctx, 4 * w - 0.7, -26.7, 0.8); dot(ctx, 2 * w - 0.8, -17.8, 0.9);
  }
}

function zHead(ctx, L, z, skin, col, t, fl) {
  ctx.save();
  ctx.translate(3, -43);
  ctx.rotate(0.1 + Math.sin(t * 1.7) * 0.12);   // 歪着脑袋晃
  ctx.scale(L.head, L.head);
  ctx.strokeStyle = 'rgba(0,0,0,0.35)';
  ctx.lineWidth = 1.2;
  if (L.robe) {
    // 兜帽 + 黑洞洞的脸
    ctx.fillStyle = col(z.def.colors.body);
    ctx.beginPath(); ctx.moveTo(-9, 8); ctx.quadraticCurveTo(-11, -11, 1, -11); ctx.quadraticCurveTo(11, -10, 9, 7); ctx.closePath(); ctx.fill(); ctx.stroke();
    ctx.fillStyle = fl ? '#fff' : '#120f22';
    ctx.beginPath(); ctx.ellipse(3, 0.5, 4.8, 6, 0, 0, TAU); ctx.fill();
  } else {
    ctx.fillStyle = skin;
    ctx.beginPath(); ctx.ellipse(0, 0, 7.5, 8, 0, 0, TAU); ctx.fill(); ctx.stroke();
    if (!fl) {
      if (z.seed < 0.35) {
        // 露出的头骨
        ctx.fillStyle = '#ddd5c0';
        ctx.beginPath(); ctx.ellipse(-3, -4.5, 3.2, 2.4, -0.3, 0, TAU); ctx.fill();
        ctx.strokeStyle = '#8a7a6a'; ctx.lineWidth = 0.7;
        ctx.beginPath(); ctx.moveTo(-4.5, -5.5); ctx.lineTo(-3, -4); ctx.lineTo(-2, -5); ctx.stroke();
      } else if (!z.def.boss) {
        // 稀疏的头发
        ctx.strokeStyle = '#2a2418'; ctx.lineWidth = 1.1;
        ctx.beginPath();
        for (let i = 0; i < 4; i++) { ctx.moveTo(-5 + i * 2.5, -6.5 + Math.abs(i - 1.5)); ctx.lineTo(-7.5 + i * 2, -10 + (i % 2) * 1.5); }
        ctx.stroke();
      }
      if (z.type === 'spitter') {
        // 喉咙的毒囊，前摇时鼓起
        const k = z.state === 'windup' ? 1 - z.timer / z.def.windup : 0;
        ctx.fillStyle = 'rgba(190,230,70,0.95)';
        ctx.beginPath(); ctx.ellipse(2, 8, 4.5 + k * 2.5, 3.5 + k * 2, 0, 0, TAU); ctx.fill();
        ctx.strokeStyle = 'rgba(90,120,20,0.8)'; ctx.lineWidth = 0.7;
        ctx.beginPath(); ctx.moveTo(-0.5, 7); ctx.lineTo(1.5, 9); ctx.lineTo(3, 8); ctx.stroke();
        const d = (t * 1.2) % 1;
        ctx.fillStyle = '#a6dc3a';
        ctx.globalAlpha = 1 - d; dot(ctx, 6, 6 + d * 8, 1.2); ctx.globalAlpha = 1;
      }
      // 一张一合的嘴和牙
      const open = 1.4 + (Math.sin(t * 3) + 1) * 0.9;
      ctx.fillStyle = '#2a0808';
      ctx.beginPath(); ctx.ellipse(4.2, 4, 2.8, open, 0.15, 0, TAU); ctx.fill();
      ctx.fillStyle = '#e8e0c8';
      ctx.fillRect(3, 4.2 - open, 1, 1.2); ctx.fillRect(5, 4.3 - open, 1, 1.2);
    }
  }
  if (!fl) {
    // 深陷的眼窝和发光的眼睛
    if (!L.robe) {
      ctx.fillStyle = 'rgba(0,0,0,0.5)';
      dot(ctx, 5, -1.5, 2.4); dot(ctx, 1.2, -1.8, 2);
    }
    ctx.fillStyle = L.eye;
    ctx.globalAlpha = 0.35; dot(ctx, 5, -1.5, 2.6); dot(ctx, 1.2, -1.8, 2.2);
    ctx.globalAlpha = 1; dot(ctx, 5.3, -1.5, 1.1); dot(ctx, 1.5, -1.8, 0.9);
  }
  if (L.horns) {
    ctx.fillStyle = col('#e8d27a');
    ctx.beginPath();
    for (const [bx, a, len] of [[-4, -0.7, 9], [0, -0.25, 11], [4, 0.2, 8]]) {
      const by = 1 - Math.sqrt(1 - (bx / 7.5) ** 2) * 8;
      ctx.moveTo(bx - 1.8, by); ctx.lineTo(bx + Math.sin(a) * len, by - Math.cos(a) * len); ctx.lineTo(bx + 1.8, by);
    }
    ctx.fill();
  }
  ctx.restore();
}

// 丧尸本体：驼背、拖腿、前伸双臂、破衣服，按类型加特征。以 r=14 为基准尺寸，脚底在 (x, y)
function drawZombieBody(ctx, g, z, x, y) {
  const L = ZOMBIE_LOOK[z.type] || ZOMBIE_LOOK.walker, C = z.def.colors;
  const fl = z.flash > 0, t = g.time + z.seed * 10, w = L.w;
  const tint = Math.round((z.seed - 0.5) * 4) / 50;   // 每只丧尸肤色略有不同
  const col = (hex, amt = 0) => (fl ? '#fff' : shade(hex, amt));
  const skin = col(C.head, tint), OUT = 'rgba(0,0,0,0.35)';
  const sw = Math.sin(z.phase) * 6, lift = z.state === 'windup' ? 7 : 0, wob = Math.sin(t * 2.3) * 1.5;

  ctx.save();
  ctx.translate(x, y);
  ctx.scale(z.facing * z.r / 14, z.r / 14);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  if (L.robe) {
    const sway = Math.sin(t * 2) * 1.5;
    ctx.fillStyle = col(C.body, -0.1);
    ctx.strokeStyle = OUT; ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.moveTo(-7 * w, -24); ctx.lineTo(7 * w, -24); ctx.lineTo(10 * w + sway, 0);
    for (let i = 1; i <= 5; i++) ctx.lineTo(10 * w + sway - i * 4 * w, i % 2 ? -3 : 0);
    ctx.closePath(); ctx.fill(); ctx.stroke();
  } else {
    const lw = 5 * Math.min(w, 1.3);
    zLeg(ctx, -2, sw * 0.6, col(C.legs, -0.08), lw);   // 后腿步幅小，像拖着走
    zLeg(ctx, 2, -sw, col(C.legs), lw);
  }

  // 以髋部为轴驼背前倾
  ctx.translate(0, -16); ctx.rotate(L.hunch); ctx.translate(0, 16);

  if (L.spikes) {
    ctx.fillStyle = col('#d8cfb0');
    ctx.beginPath();
    for (let i = 0; i < 4; i++) { const sy = -35 + i * 5; ctx.moveTo(-6 * w, sy); ctx.lineTo(-8 * w - 6 + i, sy - 3); ctx.lineTo(-6 * w, sy + 3.5); }
    ctx.fill();
  }
  zArm(ctx, L, -w, -32, w, col(C.head, tint - 0.12), wob - 2, lift, fl);   // 后臂

  // 躯干：破烂的衣服下摆
  ctx.fillStyle = col(C.body);
  ctx.strokeStyle = OUT; ctx.lineWidth = 1.2;
  ctx.beginPath();
  ctx.moveTo(-8 * w, -31);
  ctx.quadraticCurveTo(-8 * w, -37, -2 * w, -37);
  ctx.lineTo(3 * w, -37);
  ctx.quadraticCurveTo(8 * w, -37, 8 * w, -31);
  ctx.lineTo(7.5 * w, -15);
  for (let i = 1; i <= 4; i++) ctx.lineTo(7.5 * w - i * 3.75 * w, i % 2 ? -11.5 : -15);
  ctx.closePath(); ctx.fill(); ctx.stroke();
  if (!fl) zTorsoDetail(ctx, L, z, w, skin, t);

  if (z.type === 'walker' && z.seed > 0.82) {
    // 断臂
    ctx.strokeStyle = skin; ctx.lineWidth = L.arm;
    ctx.beginPath(); ctx.moveTo(2 * w, -32); ctx.lineTo(6 * w, -30); ctx.stroke();
    if (!fl) { ctx.fillStyle = '#7a0c0c'; dot(ctx, 6 * w, -30, 2); }
  } else {
    zArm(ctx, L, 2 * w, -32, w, skin, wob, lift, fl);
  }
  zHead(ctx, L, z, skin, col, t, fl);
  ctx.restore();
}

function drawObstacle(ctx, g, o) {
  const top = o.y - o.height;
  drawShadowRect(ctx, o);
  if (o.kind === 'barrel') {
    // 油桶：圆柱体，受损时闪烁
    const cx = o.x + o.w / 2, rx = o.w / 2, ry = o.h / 2;
    ctx.fillStyle = o.front;
    ctx.fillRect(o.x, top + ry, o.w, o.height);
    ctx.beginPath(); ctx.ellipse(cx, top + ry + o.height, rx, ry, 0, 0, Math.PI); ctx.fill();
    ctx.fillStyle = 'rgba(0,0,0,0.25)';
    ctx.fillRect(o.x, top + ry + o.height * 0.3, o.w, 4);
    ctx.fillRect(o.x, top + ry + o.height * 0.7, o.w, 4);
    ctx.fillStyle = o.top;
    ctx.beginPath(); ctx.ellipse(cx, top + ry, rx, ry, 0, 0, TAU); ctx.fill();
    ctx.fillStyle = '#ffd166';
    ctx.font = `bold 12px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('!', cx, top + ry + o.height * 0.5);
    if (o.hp < o.maxHp && Math.floor(g.time * 12) % 2) {
      ctx.fillStyle = 'rgba(255,200,80,0.4)';
      ctx.fillRect(o.x, top, o.w, o.h + o.height);
    }
    return;
  }
  ctx.fillStyle = o.front;
  ctx.fillRect(o.x, top + o.h, o.w, o.height);
  ctx.fillStyle = o.top;
  ctx.fillRect(o.x, top, o.w, o.h);
  ctx.strokeStyle = 'rgba(0,0,0,0.35)';
  ctx.lineWidth = 2;
  ctx.strokeRect(o.x, top, o.w, o.h + o.height);
  if (o.kind === 'crate') {
    ctx.beginPath();
    ctx.moveTo(o.x, top + o.h); ctx.lineTo(o.x + o.w, top + o.h + o.height);
    ctx.moveTo(o.x + o.w, top + o.h); ctx.lineTo(o.x, top + o.h + o.height);
    ctx.stroke();
    // 受损时变暗
    const dmg = 1 - o.hp / o.maxHp;
    if (dmg > 0) { ctx.fillStyle = `rgba(0,0,0,${dmg * 0.45})`; ctx.fillRect(o.x, top, o.w, o.h + o.height); }
  }
}

function drawShadowRect(ctx, o) {
  ctx.fillStyle = 'rgba(0,0,0,0.25)';
  ctx.fillRect(o.x + 6, o.y + 4, o.w, o.h);
}

function drawPlayer(ctx, g) {
  const p = g.player, P = CONFIG.player;
  drawShadow(ctx, p.x, p.y, p.r);
  const rolling = p.roll > 0;
  if (!rolling && p.iframe > 0 && Math.floor(g.time * 20) % 2) ctx.globalAlpha = 0.45;
  drawHumanoid(ctx, p.x, p.y, p.r, P.colors, p.facing, p.phase, {
    rot: rolling ? (1 - p.roll / P.rollTime) * TAU * p.rollDir : 0,
    flash: p.hurtFlash > 0,
  });
  if (!rolling) {
    const gun = WEAPONS[p.weapon].gun;
    ctx.save();
    ctx.translate(p.x, p.y - CONFIG.gunHeight);
    ctx.rotate(p.aim);
    ctx.translate(-p.recoil * 5, 0);
    ctx.fillStyle = gun.color;
    ctx.fillRect(2, -gun.w / 2, gun.len, gun.w);
    ctx.fillStyle = P.colors.head;
    ctx.beginPath(); ctx.arc(5, 0, 4, 0, TAU); ctx.fill();
    ctx.restore();
  }
  ctx.globalAlpha = 1;
}

// 宠物：简单的几何造型，脚底在 (x, y)，z 为悬浮高度
function drawPet(ctx, g, pet) {
  const def = PETS[pet.type], y = pet.y - pet.z;
  drawShadow(ctx, pet.x, pet.y, 8, pet.z > 0 ? 0.15 : 0.3);
  ctx.save();
  ctx.translate(pet.x, y);
  ctx.scale(pet.facing, 1);
  ctx.fillStyle = def.color;
  if (pet.type === 'dog' || pet.type === 'cat') {
    const leg = Math.sin(pet.phase) * 3;
    ctx.fillRect(-8 + leg, -6, 3, 6); ctx.fillRect(5 - leg, -6, 3, 6);
    ctx.beginPath(); ctx.ellipse(0, -10, 11, 6, 0, 0, TAU); ctx.fill();
    ctx.beginPath(); ctx.arc(10 + (pet.bite > 0 ? 4 : 0), -16, 6, 0, TAU); ctx.fill();
    if (pet.type === 'cat') {
      ctx.beginPath(); ctx.moveTo(6, -20); ctx.lineTo(8, -27); ctx.lineTo(11, -21); ctx.moveTo(11, -21); ctx.lineTo(14, -27); ctx.lineTo(15, -19); ctx.fill();
      ctx.strokeStyle = def.color; ctx.lineWidth = 3;
      ctx.beginPath(); ctx.moveTo(-10, -11); ctx.quadraticCurveTo(-18, -14, -15, -24); ctx.stroke();
    } else {
      ctx.fillStyle = '#8a5a2a';
      ctx.beginPath(); ctx.ellipse(8, -18, 3, 5, -0.4, 0, TAU); ctx.fill();
    }
    ctx.fillStyle = '#111'; ctx.fillRect(12, -18, 2, 2);
  } else if (pet.type === 'bird') {
    const flap = Math.sin(g.time * 18) * 6;
    ctx.beginPath(); ctx.ellipse(0, 0, 8, 5, 0, 0, TAU); ctx.fill();
    ctx.beginPath(); ctx.moveTo(-2, -2); ctx.lineTo(-8, -6 - flap); ctx.lineTo(4, -3); ctx.fill();
    ctx.fillStyle = '#ffb020';
    ctx.beginPath(); ctx.moveTo(7, -1); ctx.lineTo(12, 1); ctx.lineTo(7, 2); ctx.fill();
    ctx.fillStyle = '#111'; ctx.fillRect(4, -3, 2, 2);
  } else if (pet.type === 'ghost') {
    ctx.globalAlpha = 0.55 + Math.sin(g.time * 3) * 0.15;
    ctx.beginPath();
    ctx.arc(0, -12, 10, Math.PI, 0);
    ctx.lineTo(10, 2);
    for (let i = 0; i < 4; i++) ctx.lineTo(10 - (i + 0.5) * 5, (i % 2 ? 2 : -3) + Math.sin(g.time * 6 + i));
    ctx.lineTo(-10, 2);
    ctx.fill();
    ctx.fillStyle = '#334';
    ctx.fillRect(1, -15, 3, 4); ctx.fillRect(-5, -15, 3, 4);
  }
  ctx.restore();
  ctx.globalAlpha = 1;
  // 猫的闪避充能环
  if (pet.type === 'cat') {
    const k = pet.charge / def.interval;
    ctx.strokeStyle = k >= 1 ? '#ffd166' : 'rgba(255,255,255,0.4)';
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(pet.x, y - 34, 5, -Math.PI / 2, -Math.PI / 2 + TAU * k); ctx.stroke();
  }
}

function drawZombie(ctx, g, z) {
  const s = z.r / 14, fy = z.y - z.z, headY = fy - 52 * s;
  drawShadow(ctx, z.x, z.y, z.r, z.z > 0 ? 0.18 : 0.3);
  let x = z.x;
  if (z.state === 'windup') x += Math.sin(g.time * 60) * 2 * s;   // 前摇时发抖
  // BOSS 光环：普通状态暗色，半血狂暴后变红并加快脉动
  if (z.def.boss) {
    const rage = z.hp < z.maxHp * 0.5, k = 0.5 + 0.5 * Math.sin(g.time * (rage ? 10 : 4));
    ctx.fillStyle = rage ? `rgba(255,40,40,${0.12 + 0.12 * k})` : `rgba(255,255,255,${0.05 + 0.05 * k})`;
    ctx.beginPath(); ctx.ellipse(z.x, z.y, z.r * 1.5, z.r * 0.65, 0, 0, TAU); ctx.fill();
  }
  drawZombieBody(ctx, g, z, x, fy);
  if (z.def.ai === 'summoner') {
    // 召唤师头顶漂浮的紫色宝珠
    const oy = headY - 12 + Math.sin(g.time * 3) * 3;
    ctx.fillStyle = 'rgba(176,122,255,0.3)';
    dot(ctx, z.x, oy, 7 * s);
    ctx.fillStyle = '#b07aff';
    dot(ctx, z.x, oy, 4.2 * s);
  }

  if (z.def.ai === 'bomber') {
    const a = 0.3 + 0.3 * Math.sin(g.time * 12);
    ctx.fillStyle = `rgba(255,60,20,${a})`;
    ctx.beginPath(); ctx.arc(z.x, z.y - 25 * s, 13 * s, 0, TAU); ctx.fill();
  }
  if (z.def.ai === 'spitter' && z.state === 'windup') {
    const k = 1 - z.timer / z.def.windup;
    ctx.fillStyle = `rgba(160,220,40,${0.4 + k * 0.4})`;
    ctx.beginPath(); ctx.arc(z.x + z.facing * 9 * s, z.y - 42 * s, 4 + k * 8, 0, TAU); ctx.fill();
  }
  if (!z.def.boss && z.hp < z.maxHp) {
    ctx.fillStyle = '#300';
    ctx.fillRect(z.x - 14 * s, headY - 6, 28 * s, 4);
    ctx.fillStyle = '#e44';
    ctx.fillRect(z.x - 14 * s, headY - 6, 28 * s * Math.max(0, z.hp / z.maxHp), 4);
  }
}

// 巨兽冲撞方向预警，画在地面层
function drawBossWarning(ctx, g, z) {
  if (z.def.ai !== 'boss' || z.state !== 'windup' || z.cdx === undefined) return;
  const len = z.def.chargeSpeed * z.def.chargeTime;
  const k = 1 - z.timer / z.def.windup;
  ctx.save();
  ctx.translate(z.x, z.y);
  ctx.rotate(Math.atan2(z.cdy, z.cdx));
  ctx.fillStyle = `rgba(255,40,40,${0.12 + k * 0.25})`;
  ctx.fillRect(0, -z.r, len, z.r * 2);
  ctx.restore();
}

function drawProjectile(ctx, p) {
  if (p.kind === 'bullet') {
    const d = norm(p.vx, p.vy);
    ctx.strokeStyle = p.def.color;
    ctx.lineWidth = p.def.pierce ? 4 : 3;
    ctx.beginPath();
    ctx.moveTo(p.x, p.y - p.z);
    ctx.lineTo(p.x - d.x * 16, p.y - p.z - d.y * 16);
    ctx.stroke();
  } else if (p.kind === 'grenade') {
    drawShadow(ctx, p.x, p.y, 6, 0.3 * Math.max(0.3, 1 - p.z / 150));
    ctx.fillStyle = '#34502a';
    ctx.beginPath(); ctx.arc(p.x, p.y - p.z, 6, 0, TAU); ctx.fill();
    const urgent = p.def.fuse - p.t < 0.5;
    if (Math.floor(p.t * (urgent ? 16 : 6)) % 2) {
      ctx.fillStyle = '#f33';
      ctx.beginPath(); ctx.arc(p.x + Math.cos(p.spin) * 3, p.y - p.z + Math.sin(p.spin) * 3, 2, 0, TAU); ctx.fill();
    }
  } else if (p.kind === 'rocket') {
    drawShadow(ctx, p.x, p.y, 6, 0.25);
    ctx.save();
    ctx.translate(p.x, p.y - p.z);
    ctx.rotate(Math.atan2(p.dy, p.dx));
    if (p.t > p.def.ignite) {
      ctx.fillStyle = Math.random() < 0.5 ? '#ffb020' : '#ff6a00';
      ctx.beginPath(); ctx.moveTo(-9, -4); ctx.lineTo(-20 - rand(0, 10), 0); ctx.lineTo(-9, 4); ctx.fill();
    }
    ctx.fillStyle = '#6b7a45';
    ctx.fillRect(-10, -4, 18, 8);
    ctx.fillStyle = '#c33';
    ctx.beginPath(); ctx.moveTo(8, -4); ctx.lineTo(14, 0); ctx.lineTo(8, 4); ctx.fill();
    ctx.restore();
  }
}

// 敌方弹幕：发光的圆球
function drawShot(ctx, s) {
  drawShadow(ctx, s.x, s.y, s.r * 0.7, 0.2);
  ctx.fillStyle = s.color;
  ctx.globalAlpha = 0.35;
  ctx.beginPath(); ctx.arc(s.x, s.y - 18, s.r * 1.7, 0, TAU); ctx.fill();
  ctx.globalAlpha = 1;
  ctx.beginPath(); ctx.arc(s.x, s.y - 18, s.r, 0, TAU); ctx.fill();
  ctx.fillStyle = '#fff';
  ctx.beginPath(); ctx.arc(s.x, s.y - 18, s.r * 0.4, 0, TAU); ctx.fill();
}

// 范围攻击预警：外圈 + 逐渐填满的内圈
function drawHazard(ctx, h) {
  const k = clamp(h.t / h.delay, 0, 1);
  ctx.strokeStyle = `rgba(${h.color},0.8)`;
  ctx.lineWidth = 2;
  ctx.beginPath(); ctx.ellipse(h.x, h.y, h.r, h.r * 0.6, 0, 0, TAU); ctx.stroke();
  ctx.fillStyle = `rgba(${h.color},${0.12 + k * 0.25})`;
  ctx.beginPath(); ctx.ellipse(h.x, h.y, h.r * k, h.r * 0.6 * k, 0, 0, TAU); ctx.fill();
}

function drawSword(ctx, s) {
  ctx.save();
  ctx.translate(s.x, s.y - CONFIG.gunHeight);
  ctx.rotate(s.a + Math.PI / 2);
  ctx.shadowColor = '#7fe8ff';
  ctx.shadowBlur = 10;
  ctx.fillStyle = '#e8fbff';
  ctx.beginPath(); ctx.moveTo(0, -16); ctx.lineTo(4, 6); ctx.lineTo(-4, 6); ctx.closePath(); ctx.fill();
  ctx.shadowBlur = 0;
  ctx.fillStyle = '#5a7a9a';
  ctx.fillRect(-6, 6, 12, 3);
  ctx.fillRect(-1.5, 9, 3, 6);
  ctx.restore();
}

function drawSpit(ctx, s) {
  drawShadow(ctx, s.x, s.y, 6, 0.25);
  ctx.fillStyle = '#a6dc3a';
  ctx.beginPath(); ctx.arc(s.x, s.y - s.z, 7, 0, TAU); ctx.fill();
  ctx.fillStyle = '#e2ff8a';
  ctx.beginPath(); ctx.arc(s.x - 2, s.y - s.z - 2, 2.5, 0, TAU); ctx.fill();
}

function drawPickup(ctx, g, k) {
  if (k.life < 3 && Math.floor(g.time * 8) % 2) return;
  const def = PICKUPS[k.type], bob = Math.sin(g.time * 4 + k.x) * 3 + 14;
  drawShadow(ctx, k.x, k.y, 10, 0.3);
  ctx.fillStyle = def.color;
  ctx.beginPath(); ctx.arc(k.x, k.y - bob, 11, 0, TAU); ctx.fill();
  ctx.strokeStyle = '#fff';
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.fillStyle = '#fff';
  ctx.font = `bold 13px ${FONT}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(def.label, k.x, k.y - bob + 1);
}

function drawWorld(ctx, g) {
  ctx.drawImage(groundFor(g.theme.ground), 0, 0);

  // 泥潭
  for (const m of g.muds) {
    ctx.fillStyle = g.theme.mud;
    ctx.globalAlpha = 0.85;
    ctx.beginPath(); ctx.ellipse(m.x, m.y, m.rx, m.ry, 0, 0, TAU); ctx.fill();
    ctx.globalAlpha = 0.25;
    ctx.fillStyle = '#000';
    ctx.beginPath(); ctx.ellipse(m.x + 6, m.y + 4, m.rx * 0.7, m.ry * 0.6, 0, 0, TAU); ctx.fill();
    ctx.globalAlpha = 0.3;
    ctx.fillStyle = '#fff';
    const b = (g.time * 0.7 + m.x) % 1;
    ctx.beginPath(); ctx.arc(m.x - m.rx * 0.3, m.y - m.ry * 0.2, 3 + b * 3, 0, TAU); ctx.fill();
    ctx.globalAlpha = 1;
  }

  for (const d of g.decals) {
    ctx.fillStyle = `rgba(20,15,10,${0.5 * Math.min(1, d.life / 3)})`;
    ctx.beginPath(); ctx.ellipse(d.x, d.y, d.r, d.r * 0.55, 0, 0, TAU); ctx.fill();
  }
  for (const pd of g.puddles) {
    ctx.fillStyle = `rgba(140,200,40,${0.25 + 0.35 * pd.life / pd.max})`;
    ctx.beginPath(); ctx.ellipse(pd.x, pd.y, pd.r, pd.r * 0.55, 0, 0, TAU); ctx.fill();
  }
  for (const z of g.zombies) drawBossWarning(ctx, g, z);
  for (const h of g.hazards) drawHazard(ctx, h);
  for (const k of g.pickups) drawPickup(ctx, g, k);

  // 按脚底 y 排序绘制
  const items = [];
  for (const o of g.obstacles) items.push({ y: o.y + o.h, draw: () => drawObstacle(ctx, g, o) });
  for (const s of g.shots) items.push({ y: s.y, draw: () => drawShot(ctx, s) });
  for (const s of g.swordPos) items.push({ y: s.y, draw: () => drawSword(ctx, s) });
  for (const z of g.zombies) items.push({ y: z.y, draw: () => drawZombie(ctx, g, z) });
  for (const p of g.projectiles) items.push({ y: p.y, draw: () => drawProjectile(ctx, p) });
  for (const s of g.spits) items.push({ y: s.y, draw: () => drawSpit(ctx, s) });
  for (const pet of Object.values(g.pets)) items.push({ y: pet.y, draw: () => drawPet(ctx, g, pet) });
  if (g.player.hp > 0) items.push({ y: g.player.y, draw: () => drawPlayer(ctx, g) });
  items.sort((a, b) => a.y - b.y);
  for (const it of items) it.draw();

  // 激光
  ctx.lineCap = 'round';
  for (const b of g.beams) {
    const a = b.life / b.max;
    for (const [w, col] of [[10, b.color], [3, '#fff']]) {
      ctx.globalAlpha = w > 5 ? a * 0.4 : a;
      ctx.strokeStyle = col;
      ctx.lineWidth = w;
      ctx.beginPath();
      b.pts.forEach((pt, i) => (i ? ctx.lineTo : ctx.moveTo).call(ctx, pt.x, pt.y - CONFIG.gunHeight));
      ctx.stroke();
    }
  }
  ctx.globalAlpha = 1;

  for (const r of g.rings) {
    const k = 1 - r.life / r.max;
    ctx.strokeStyle = `rgba(255,220,150,${1 - k})`;
    ctx.lineWidth = 6 * (1 - k) + 1;
    ctx.beginPath(); ctx.ellipse(r.x, r.y, r.r * (0.4 + k * 0.6), r.r * (0.4 + k * 0.6) * 0.6, 0, 0, TAU); ctx.stroke();
  }
  for (const pt of g.particles) {
    ctx.globalAlpha = Math.max(0, pt.life / pt.max);
    ctx.fillStyle = pt.color;
    ctx.beginPath(); ctx.arc(pt.x, pt.y - pt.z, pt.size, 0, TAU); ctx.fill();
  }
  ctx.globalAlpha = 1;

  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (const t of g.texts) {
    ctx.globalAlpha = Math.min(1, t.life * 2);
    ctx.font = `bold ${t.size}px ${FONT}`;
    ctx.fillStyle = '#000';
    ctx.fillText(t.text, t.x + 1, t.y + 1);
    ctx.fillStyle = t.color;
    ctx.fillText(t.text, t.x, t.y);
  }
  ctx.globalAlpha = 1;
}

function bar(ctx, x, y, w, h, k, fg, bg = 'rgba(0,0,0,0.55)') {
  ctx.fillStyle = bg;
  ctx.fillRect(x, y, w, h);
  ctx.fillStyle = fg;
  ctx.fillRect(x + 2, y + 2, (w - 4) * clamp(k, 0, 1), h - 4);
}

function drawHUD(ctx, g) {
  const p = g.player, P = CONFIG.player;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';

  bar(ctx, 20, 18, 260, 22, p.hp / p.maxHp, p.poison ? '#7cc93a' : '#e04848');
  ctx.font = `bold 14px ${FONT}`;
  ctx.fillStyle = '#fff';
  ctx.fillText(`${Math.ceil(Math.max(0, p.hp))} / ${p.maxHp}`, 28, 29);
  // 翻滚体力：每格一次翻滚，正在恢复的那格显示进度
  const segW = 120 / p.rollMax, cdMax = P.rollCooldown * p.rollCdMul;
  for (let i = 0; i < p.rollMax; i++) {
    const k = i < p.rollCharge ? 1 : i === p.rollCharge ? 1 - p.rollCd / cdMax : 0;
    bar(ctx, 20 + i * segW, 44, segW - 3, 8, k, k >= 1 ? '#9ad0ff' : '#4a6a8a');
  }

  let bx = 150;
  ctx.font = `12px ${FONT}`;
  if (p.speedBuff > 0) { ctx.fillStyle = '#3fb6e8'; ctx.fillText(`加速 ${p.speedBuff.toFixed(1)}s`, bx, 48); bx += 80; }
  if (p.slow > 0) { ctx.fillStyle = '#a6dc3a'; ctx.fillText('减速', bx, 48); bx += 40; }
  if (p.poison) { ctx.fillStyle = '#a6dc3a'; ctx.fillText('中毒', bx, 48); }

  // 宠物栏
  const pets = Object.keys(g.pets);
  if (pets.length) {
    ctx.font = `bold 13px ${FONT}`;
    ctx.fillStyle = '#ff9ec8';
    ctx.fillText('宠物  ' + pets.map((k) => PETS[k].name).join('  '), 20, 66 + WEAPON_ORDER.length * 26 + 12);
  }

  // 已获得的强化
  const ups = UPGRADES.filter((u) => p.upgrades[u.id]);
  ctx.font = `12px ${FONT}`;
  ups.forEach((u, i) => {
    ctx.fillStyle = u.color;
    ctx.fillText(`${u.name} ×${p.upgrades[u.id]}`, 20, 66 + WEAPON_ORDER.length * 26 + 36 + i * 18);
  });

  // 武器栏
  WEAPON_ORDER.forEach((k, i) => {
    const owned = k in p.weapons, cur = k === p.weapon, y = 66 + i * 26;
    ctx.fillStyle = cur ? 'rgba(255,209,102,0.9)' : 'rgba(0,0,0,0.45)';
    ctx.fillRect(20, y, 170, 22);
    ctx.fillStyle = cur ? '#222' : owned ? '#eee' : '#666';
    ctx.font = `${cur ? 'bold ' : ''}13px ${FONT}`;
    ctx.fillText(`${i + 1}  ${owned ? WEAPONS[k].name : '———'}`, 28, y + 11);
    if (owned) {
      ctx.textAlign = 'right';
      ctx.fillText(isFinite(p.weapons[k]) ? p.weapons[k] : '∞', 182, y + 11);
      ctx.textAlign = 'left';
    }
  });

  ctx.textAlign = 'right';
  ctx.font = `bold 20px ${FONT}`;
  ctx.fillStyle = '#fff';
  const waveText = g.bossWave ? 'BOSS 战' : `第 ${Math.min(g.stageWave, CONFIG.stage.waves)} / ${CONFIG.stage.waves} 波`;
  ctx.fillText(`第 ${g.stage} 关 · ${waveText}`, W - 20, 28);
  ctx.font = `15px ${FONT}`;
  ctx.fillText(`${g.theme.name}   分数 ${g.score}   击杀 ${g.kills}`, W - 20, 54);
  if (g.state === 'playing' && !g.queue.length && !g.zombies.length && !g.bossWave) {
    ctx.fillStyle = '#ffd166';
    ctx.fillText(g.stageWave >= CONFIG.stage.waves ? `BOSS 即将出现 ${Math.ceil(g.breakT)}s` : `下一波 ${Math.ceil(g.breakT)}s`, W - 20, 78);
  }

  const boss = g.zombies.find((z) => z.def.boss);
  if (boss) {
    bar(ctx, W / 2 - 300, H - 40, 600, 20, boss.hp / boss.maxHp, '#b03030');
    ctx.textAlign = 'center';
    ctx.fillStyle = '#fff';
    ctx.font = `bold 14px ${FONT}`;
    ctx.fillText(boss.def.name + (boss.hp < boss.maxHp * 0.5 ? '（狂暴）' : ''), W / 2, H - 30);
  }

  ctx.textAlign = 'center';
  g.messages.forEach((m, i) => {
    ctx.globalAlpha = Math.min(1, m.life);
    ctx.font = `bold 30px ${FONT}`;
    ctx.fillStyle = '#000';
    ctx.fillText(m.text, W / 2 + 2, 122 + i * 40);
    ctx.fillStyle = m.color;
    ctx.fillText(m.text, W / 2, 120 + i * 40);
  });
  ctx.globalAlpha = 1;
}

function drawCrosshair(ctx, x, y) {
  ctx.strokeStyle = '#fff';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(x, y, 9, 0, TAU);
  ctx.moveTo(x - 15, y); ctx.lineTo(x - 5, y);
  ctx.moveTo(x + 5, y); ctx.lineTo(x + 15, y);
  ctx.moveTo(x, y - 15); ctx.lineTo(x, y - 5);
  ctx.moveTo(x, y + 5); ctx.lineTo(x, y + 15);
  ctx.stroke();
}

function drawOverlay(ctx, title, lines, hint) {
  ctx.fillStyle = 'rgba(0,0,0,0.7)';
  ctx.fillRect(0, 0, W, H);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#ffd166';
  ctx.font = `bold 56px ${FONT}`;
  ctx.fillText(title, W / 2, H / 2 - 150);
  ctx.fillStyle = '#ddd';
  ctx.font = `18px ${FONT}`;
  lines.forEach((l, i) => ctx.fillText(l, W / 2, H / 2 - 70 + i * 32));
  ctx.fillStyle = '#fff';
  ctx.font = `bold 24px ${FONT}`;
  ctx.fillText(hint, W / 2, H / 2 + 60 + lines.length * 32);
}

// 三选一卡片的位置（game.js 的点击判定也用这个）
function upgradeCardRects(n) {
  const w = 280, h = 340, gap = 40, x0 = (W - (n * w + (n - 1) * gap)) / 2;
  return Array.from({ length: n }, (_, i) => ({ x: x0 + i * (w + gap), y: H / 2 - h / 2 + 30, w, h }));
}

// 按宽度自动换行（中文按字符切分）
function wrapText(ctx, text, x, y, maxW, lh) {
  let line = '';
  for (const ch of text) {
    if (ctx.measureText(line + ch).width > maxW && line) { ctx.fillText(line, x, y); y += lh; line = ch; }
    else line += ch;
  }
  ctx.fillText(line, x, y);
}

function drawUpgrade(ctx, g, input) {
  ctx.fillStyle = 'rgba(0,0,0,0.75)';
  ctx.fillRect(0, 0, W, H);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#ffd166';
  ctx.font = `bold 40px ${FONT}`;
  ctx.fillText(`第 ${g.stage} 关完成 · 选择一项强化`, W / 2, 110);
  ctx.fillStyle = '#aaa';
  ctx.font = `16px ${FONT}`;
  ctx.fillText('点击卡片或按 1 / 2 / 3 选择，之后进入下一关', W / 2, 150);

  const p = g.player;
  upgradeCardRects(g.choices.length).forEach((r, i) => {
    const u = g.choices[i], hover = pointInRect(input.mx, input.my, r);
    const lift = hover ? -8 : 0;
    ctx.fillStyle = hover ? 'rgba(60,60,70,0.98)' : 'rgba(35,35,42,0.95)';
    ctx.beginPath(); ctx.roundRect(r.x, r.y + lift, r.w, r.h, 14); ctx.fill();
    ctx.strokeStyle = u.color;
    ctx.lineWidth = hover ? 4 : 2;
    ctx.stroke();
    ctx.fillStyle = u.color;
    ctx.beginPath(); ctx.arc(r.x + r.w / 2, r.y + lift + 80, 40, 0, TAU); ctx.fill();
    ctx.fillStyle = '#111';
    ctx.font = `bold 34px ${FONT}`;
    ctx.fillText(u.name[0], r.x + r.w / 2, r.y + lift + 82);
    ctx.fillStyle = '#fff';
    ctx.font = `bold 24px ${FONT}`;
    ctx.fillText(u.name, r.x + r.w / 2, r.y + lift + 160);
    const lv = p.upgrades[u.id] || 0;
    ctx.fillStyle = '#888';
    ctx.font = `14px ${FONT}`;
    ctx.fillText(u.max < 99 ? `等级 ${lv} → ${lv + 1}（上限 ${u.max}）` : '', r.x + r.w / 2, r.y + lift + 190);
    ctx.fillStyle = '#ddd';
    ctx.font = `16px ${FONT}`;
    wrapText(ctx, u.desc, r.x + r.w / 2, r.y + lift + 230, r.w - 40, 24);
    ctx.fillStyle = '#666';
    ctx.font = `bold 16px ${FONT}`;
    ctx.fillText(`[${i + 1}]`, r.x + r.w / 2, r.y + lift + r.h - 24);
  });
}

// ---------- 对话头像 ----------
// 人物用胸像（在 100×100 的局部坐标里绘制），丧尸和宠物复用游戏里的造型。
// 风格：写实偏暗，带脏污、伤口和疲惫感，符合末日题材。
const BUSTS = {
  // 林夏：研究员，蓬乱的齐肩发、白大褂、单耳无线电耳机，熬夜的黑眼圈，脸上贴着创可贴
  lin:  { female: true,  skin: '#f0cdb0', hair: '#3b2519', eye: '#5a3624', coat: '#dde3e6', inner: '#2b3440', bg: ['#2a4a55', '#0a1216'], radio: true },
  // 陈野：幸存者，短乱发、胡茬、竖领夹克和背包肩带，眉骨有旧伤疤
  hero: { female: false, skin: '#dcae86', hair: '#231a13', eye: '#2e2219', coat: '#3a6ea5', inner: '#252d36', bg: ['#5c3b22', '#120b07'] },
};

// side：-1 左眼 / 1 右眼（决定外眼角方向）
function bustEye(ctx, B, cx, cy, side, blink) {
  ctx.strokeStyle = '#2a1812';
  ctx.lineWidth = B.female ? 1.4 : 1.1;
  if (blink) {
    ctx.beginPath(); ctx.moveTo(cx - 4.2, cy + 0.5); ctx.quadraticCurveTo(cx, cy + 1.8, cx + 4.2, cy + 0.5); ctx.stroke();
    return;
  }
  const h = B.female ? 2.7 : 2.2;
  ctx.fillStyle = '#f2ede6';
  ctx.beginPath(); ctx.ellipse(cx, cy, 4.2, h, 0, 0, TAU); ctx.fill();
  ctx.save();
  ctx.clip();
  ctx.fillStyle = B.eye; dot(ctx, cx + 0.5, cy + 0.3, 2.5);
  ctx.fillStyle = '#0e0a08'; dot(ctx, cx + 0.5, cy + 0.3, 1.1);
  ctx.restore();
  ctx.fillStyle = '#fff'; dot(ctx, cx + 1.4, cy - 0.7, 0.7);
  // 上眼睑
  ctx.beginPath(); ctx.moveTo(cx - 4.6, cy + 0.4); ctx.quadraticCurveTo(cx, cy - h - 1.4, cx + 4.6, cy); ctx.stroke();
  if (B.female) {
    const ox = cx + side * 4.6;
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(ox, cy + 0.2); ctx.lineTo(ox + side * 1.3, cy - 1.3); ctx.stroke();
  }
  // 黑眼圈
  ctx.strokeStyle = 'rgba(90,45,60,0.28)';
  ctx.lineWidth = 0.9;
  ctx.beginPath(); ctx.moveTo(cx - 3, cy + h + 0.8); ctx.quadraticCurveTo(cx, cy + h + 2, cx + 3, cy + h + 0.8); ctx.stroke();
}

function drawBust(ctx, B, t) {
  const sk = B.skin, jaw = B.female ? 0 : 1;
  const facePath = () => {
    ctx.beginPath();
    ctx.moveTo(33, 40);
    ctx.bezierCurveTo(33, 19, 67, 19, 67, 40);
    ctx.bezierCurveTo(67, 53 + jaw * 2, 60 + jaw * 3, 66, 50, 67);
    ctx.bezierCurveTo(40 - jaw * 3, 66, 33, 53 + jaw * 2, 33, 40);
    ctx.closePath();
  };

  // 背景：林夏身后是研究所的监视器冷光，陈野身后是远处的火光
  const bg = ctx.createRadialGradient(50, 38, 4, 50, 50, 78);
  bg.addColorStop(0, B.bg[0]); bg.addColorStop(1, B.bg[1]);
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, 100, 100);
  if (B.radio) {
    ctx.fillStyle = 'rgba(120,220,255,0.08)';
    ctx.fillRect(5, 10, 22, 15); ctx.fillRect(75, 14, 20, 13);
    ctx.fillStyle = 'rgba(120,220,255,0.14)';
    for (let i = 0; i < 3; i++) ctx.fillRect(8, 13 + i * 4, 8 + ((i * 7) % 9), 1.2);
  } else {
    const k = 0.1 + Math.sin(t * 5) * 0.02;
    ctx.fillStyle = `rgba(255,140,60,${k})`; dot(ctx, 86, 30, 16);
    ctx.fillStyle = `rgba(255,190,90,${k})`; dot(ctx, 86, 33, 7);
  }

  ctx.save();
  ctx.translate(0, Math.sin(t * 1.6) * 0.5);   // 呼吸起伏
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  // 脑后的头发
  if (B.female) {
    ctx.fillStyle = shade(B.hair, -0.04);
    ctx.beginPath();
    ctx.moveTo(31, 44);
    ctx.bezierCurveTo(24, 10, 76, 10, 69, 44);
    ctx.lineTo(71, 62);
    ctx.bezierCurveTo(72, 70, 68, 74, 64, 75);
    ctx.lineTo(60, 64); ctx.lineTo(40, 64); ctx.lineTo(36, 75);
    ctx.bezierCurveTo(32, 74, 28, 70, 29, 62);
    ctx.closePath();
    ctx.fill();
  }

  // 肩膀和衣服
  ctx.fillStyle = B.coat;
  ctx.beginPath();
  ctx.moveTo(4, 100); ctx.bezierCurveTo(6, 84, 18, 77, 38, 73);
  ctx.lineTo(62, 73); ctx.bezierCurveTo(82, 77, 94, 84, 96, 100);
  ctx.closePath(); ctx.fill();
  ctx.fillStyle = 'rgba(0,0,0,0.16)';
  ctx.beginPath(); ctx.moveTo(62, 73); ctx.bezierCurveTo(82, 77, 94, 84, 96, 100); ctx.lineTo(70, 100); ctx.closePath(); ctx.fill();

  if (B.female) {
    // 高领毛衣 + 白大褂翻领
    ctx.fillStyle = B.inner;
    ctx.beginPath(); ctx.moveTo(40, 72); ctx.lineTo(60, 72); ctx.lineTo(54, 100); ctx.lineTo(46, 100); ctx.closePath(); ctx.fill();
    ctx.fillStyle = shade(B.coat, -0.08);
    ctx.beginPath();
    ctx.moveTo(38, 73); ctx.lineTo(46, 100); ctx.lineTo(40, 100); ctx.lineTo(33, 80); ctx.closePath();
    ctx.moveTo(62, 73); ctx.lineTo(54, 100); ctx.lineTo(60, 100); ctx.lineTo(67, 80); ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = shade(B.coat, -0.3); ctx.lineWidth = 0.8;
    ctx.beginPath(); ctx.moveTo(38, 73); ctx.lineTo(46, 100); ctx.moveTo(62, 73); ctx.lineTo(54, 100); ctx.stroke();
    // 胸牌
    ctx.fillStyle = '#f4f4f2'; ctx.fillRect(22, 85, 9, 12);
    ctx.fillStyle = '#3d7fa6'; ctx.fillRect(22, 85, 9, 2.6);
    ctx.fillStyle = '#c9b6a6'; ctx.fillRect(23.5, 89, 3, 3.5);
    ctx.fillStyle = '#999'; ctx.fillRect(27.5, 89.5, 2.5, 0.9); ctx.fillRect(27.5, 91.5, 2.5, 0.9); ctx.fillRect(23.5, 94, 6, 0.9);
    // 衣服上的污渍和血点
    ctx.fillStyle = 'rgba(95,75,55,0.22)';
    ctx.beginPath(); ctx.ellipse(14, 95, 6, 3, 0.3, 0, TAU); ctx.fill();
    ctx.fillStyle = 'rgba(120,25,25,0.55)';
    dot(ctx, 79, 90, 1.6); dot(ctx, 82, 93, 1); dot(ctx, 77, 94, 0.8);
  } else {
    // 内衬 V 领、竖起的衣领、拉链
    ctx.fillStyle = B.inner;
    ctx.beginPath(); ctx.moveTo(42, 72); ctx.lineTo(58, 72); ctx.lineTo(50, 86); ctx.closePath(); ctx.fill();
    ctx.fillStyle = shade(B.coat, -0.12);
    ctx.beginPath();
    ctx.moveTo(36, 72); ctx.lineTo(43, 61); ctx.lineTo(47, 76); ctx.closePath();
    ctx.moveTo(64, 72); ctx.lineTo(57, 61); ctx.lineTo(53, 76); ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = shade(B.coat, -0.3); ctx.lineWidth = 0.8;
    ctx.beginPath(); ctx.moveTo(50, 86); ctx.lineTo(50, 100); ctx.stroke();
    // 背包肩带
    ctx.fillStyle = '#5a4532';
    ctx.beginPath();
    ctx.moveTo(20, 82); ctx.lineTo(28, 79); ctx.lineTo(33, 100); ctx.lineTo(24, 100); ctx.closePath();
    ctx.moveTo(72, 79); ctx.lineTo(80, 82); ctx.lineTo(76, 100); ctx.lineTo(67, 100); ctx.closePath();
    ctx.fill();
    ctx.fillStyle = '#9a9a90'; ctx.fillRect(25.5, 90, 5, 2.4); ctx.fillRect(70, 90, 5, 2.4);
    ctx.fillStyle = 'rgba(60,45,30,0.3)';
    ctx.beginPath(); ctx.ellipse(60, 93, 5, 2.5, -0.2, 0, TAU); ctx.fill();
  }

  // 脖子（下巴下方有阴影）
  ctx.fillStyle = shade(sk, -0.12);
  ctx.fillRect(43.5, 55, 13, 19);
  ctx.fillStyle = 'rgba(0,0,0,0.18)';
  ctx.fillRect(43.5, 64, 13, 4);
  if (B.female) {
    ctx.fillStyle = B.inner;
    ctx.beginPath(); ctx.roundRect(41.5, 67, 17, 8, 3); ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.08)'; ctx.lineWidth = 0.6;
    ctx.beginPath(); for (let x = 44; x < 57; x += 2.5) { ctx.moveTo(x, 68); ctx.lineTo(x, 74); } ctx.stroke();
  }

  if (!B.female) {
    ctx.fillStyle = sk;
    ctx.beginPath(); ctx.ellipse(33, 46, 2.8, 4.4, 0, 0, TAU); ctx.ellipse(67, 46, 2.8, 4.4, 0, 0, TAU); ctx.fill();
  }

  // 脸：左侧受光，右侧偏暗
  facePath();
  ctx.fillStyle = sk;
  ctx.fill();
  ctx.save();
  ctx.clip();
  const lg = ctx.createLinearGradient(33, 0, 67, 0);
  lg.addColorStop(0, 'rgba(255,255,255,0.06)'); lg.addColorStop(0.55, 'rgba(0,0,0,0)'); lg.addColorStop(1, 'rgba(0,0,0,0.17)');
  ctx.fillStyle = lg;
  ctx.fillRect(30, 18, 40, 52);
  if (!B.female) {
    // 胡茬
    ctx.fillStyle = 'rgba(45,32,24,0.2)';
    ctx.beginPath(); ctx.ellipse(50, 61, 15, 8, 0, 0, TAU); ctx.ellipse(50, 56.6, 5, 1.4, 0, 0, TAU); ctx.fill();
    ctx.fillStyle = 'rgba(70,50,35,0.25)';
    ctx.beginPath(); ctx.ellipse(39, 54, 3.5, 2, 0.4, 0, TAU); ctx.fill();
  } else {
    ctx.fillStyle = 'rgba(80,60,50,0.14)';
    ctx.beginPath(); ctx.ellipse(63, 61, 3, 1.6, -0.3, 0, TAU); ctx.fill();
  }
  ctx.restore();
  facePath();
  ctx.strokeStyle = 'rgba(60,30,20,0.35)';
  ctx.lineWidth = 0.8;
  ctx.stroke();

  if (B.female) {
    ctx.fillStyle = 'rgba(225,120,120,0.16)';
    ctx.beginPath(); ctx.ellipse(41, 51.5, 3.6, 1.7, 0, 0, TAU); ctx.ellipse(59.5, 51.5, 3.6, 1.7, 0, 0, TAU); ctx.fill();
  }

  // 眉毛：林夏担忧（眉头上扬），陈野坚定（眉头压低）
  ctx.strokeStyle = shade(B.hair, 0.04);
  ctx.beginPath();
  if (B.female) {
    ctx.lineWidth = 1.3;
    ctx.moveTo(38.5, 39); ctx.quadraticCurveTo(42, 36.6, 47, 37);
    ctx.moveTo(53, 37); ctx.quadraticCurveTo(58, 36.6, 61.5, 39);
  } else {
    ctx.lineWidth = 2.2;
    ctx.moveTo(37, 37.5); ctx.quadraticCurveTo(42, 36.2, 47.5, 38.6);
    ctx.moveTo(52.5, 38.6); ctx.quadraticCurveTo(58, 36.2, 63, 37.5);
  }
  ctx.stroke();

  const blink = t % 3.7 < 0.12;
  bustEye(ctx, B, 43, 44, -1, blink);
  bustEye(ctx, B, 57, 44, 1, blink);

  // 鼻子
  ctx.strokeStyle = shade(sk, -0.28);
  ctx.lineWidth = 0.9;
  ctx.beginPath();
  ctx.moveTo(51, 45.5); ctx.quadraticCurveTo(53, 51, 51.6, 53);
  ctx.moveTo(48.5, 53.2); ctx.quadraticCurveTo(50, 54, 51.6, 53);
  ctx.stroke();

  // 嘴
  if (B.female) {
    ctx.fillStyle = '#c47c76';
    ctx.beginPath(); ctx.ellipse(50, 59.2, 3.4, 1.25, 0, 0, TAU); ctx.fill();
    ctx.strokeStyle = '#7c403c'; ctx.lineWidth = 0.8;
    ctx.beginPath(); ctx.moveTo(46.8, 58.6); ctx.quadraticCurveTo(50, 59.6, 53.2, 58.6); ctx.stroke();
  } else {
    ctx.strokeStyle = shade(sk, -0.4); ctx.lineWidth = 1.1;
    ctx.beginPath(); ctx.moveTo(46, 58.6); ctx.quadraticCurveTo(50, 59.2, 54, 58.2); ctx.stroke();
    ctx.strokeStyle = 'rgba(0,0,0,0.15)';
    ctx.beginPath(); ctx.moveTo(48, 61.2); ctx.lineTo(52, 61.2); ctx.stroke();
  }

  // 伤：林夏脸颊的创可贴，陈野眉骨的旧疤和脸上的新划痕
  if (B.female) {
    ctx.save();
    ctx.translate(60.5, 52.5); ctx.rotate(0.45);
    ctx.fillStyle = '#e9d3b4';
    ctx.beginPath(); ctx.roundRect(-3.6, -1.4, 7.2, 2.8, 1.2); ctx.fill();
    ctx.fillStyle = 'rgba(150,110,80,0.6)'; ctx.fillRect(-1, -0.8, 2, 1.6);
    ctx.restore();
  } else {
    ctx.strokeStyle = '#c88a78'; ctx.lineWidth = 0.8;
    ctx.beginPath(); ctx.moveTo(39.5, 34); ctx.lineTo(42.5, 41); ctx.stroke();
    ctx.strokeStyle = 'rgba(150,30,30,0.7)'; ctx.lineWidth = 0.7;
    ctx.beginPath(); ctx.moveTo(59, 50); ctx.lineTo(63, 52.5); ctx.moveTo(59.5, 52); ctx.lineTo(62, 53.6); ctx.stroke();
  }

  // 前面的头发
  ctx.fillStyle = B.hair;
  ctx.beginPath();
  if (B.female) {
    // 侧分刘海，左边一缕垂到脸颊
    ctx.moveTo(31, 48);
    ctx.bezierCurveTo(26, 20, 62, 10, 70, 30);
    ctx.bezierCurveTo(71, 36, 70, 42, 69, 48);
    ctx.bezierCurveTo(67, 40, 64, 34, 60, 31);
    ctx.bezierCurveTo(54, 33, 46, 32, 40, 37);
    ctx.bezierCurveTo(37, 42, 35, 47, 34, 52);
    ctx.closePath();
  } else {
    // 乱糟糟的短发
    ctx.moveTo(32, 44);
    ctx.bezierCurveTo(27, 16, 72, 12, 68, 44);
    for (const [px, py] of [[66.5, 37], [64, 31.5], [60.5, 34], [57, 29.5], [53, 33], [49, 29], [45, 33.5], [41, 30.5], [38, 36], [35, 34], [33.5, 40]]) ctx.lineTo(px, py);
    ctx.closePath();
    ctx.moveTo(37, 25); ctx.lineTo(34, 17); ctx.lineTo(43, 22); ctx.closePath();
    ctx.moveTo(46, 23); ctx.lineTo(49, 12); ctx.lineTo(54, 22); ctx.closePath();
    ctx.moveTo(58, 22); ctx.lineTo(65, 15); ctx.lineTo(64, 26); ctx.closePath();
    ctx.rect(32.5, 40, 2.2, 8);   // 鬓角
  }
  ctx.fill();
  ctx.strokeStyle = B.hair;
  ctx.lineWidth = 0.8;
  if (B.female) {
    // 散落的发丝
    ctx.beginPath();
    ctx.moveTo(60, 31); ctx.quadraticCurveTo(56, 38, 57.5, 43);
    ctx.moveTo(41, 36); ctx.quadraticCurveTo(38.5, 43, 39.5, 48);
    ctx.moveTo(69, 46); ctx.quadraticCurveTo(71, 54, 69.5, 60);
    ctx.stroke();
  }
  ctx.strokeStyle = 'rgba(255,230,210,0.13)';
  ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(36, 28); ctx.quadraticCurveTo(48, 18, 62, 22); ctx.stroke();

  // 单耳无线电耳机 + 麦克风，指示灯闪烁
  if (B.radio) {
    ctx.strokeStyle = '#2a2e34'; ctx.lineWidth = 2.2;
    ctx.beginPath(); ctx.moveTo(31, 40); ctx.bezierCurveTo(30, 13, 70, 13, 69, 40); ctx.stroke();
    ctx.fillStyle = '#30353c';
    ctx.beginPath(); ctx.roundRect(66, 39, 6.5, 11, 2.5); ctx.fill();
    ctx.strokeStyle = '#30353c'; ctx.lineWidth = 1.3;
    ctx.beginPath(); ctx.moveTo(69, 49); ctx.quadraticCurveTo(66, 60, 57.5, 60.5); ctx.stroke();
    ctx.fillStyle = '#1c1c1c'; dot(ctx, 57, 60.5, 1.5);
    if (Math.sin(t * 6) > 0) { ctx.fillStyle = '#ff4a3a'; dot(ctx, 69.2, 42, 0.9); }
  }
  ctx.restore();

  // 无线电信号的扫描线，偶尔闪一下
  if (B.radio) {
    ctx.fillStyle = 'rgba(170,235,255,0.05)';
    for (let y = (t * 12) % 3 - 3; y < 100; y += 3) ctx.fillRect(0, y, 100, 0.7);
    if (Math.sin(t * 7.3) > 0.97) { ctx.fillStyle = 'rgba(170,235,255,0.07)'; ctx.fillRect(0, 0, 100, 100); }
  }
}

// 头像画在 (fx, fy) 起、边长 fs 的方框里
function drawPortrait(ctx, g, look, fx, fy, fs) {
  ctx.save();
  ctx.translate(fx, fy);
  ctx.scale(fs / 100, fs / 100);
  if (look.kind === 'bust') {
    drawBust(ctx, BUSTS[look.id], g.time);
  } else {
    const zb = look.kind === 'zombie';
    const bg = ctx.createRadialGradient(50, 50, 4, 50, 55, 75);
    bg.addColorStop(0, zb ? '#3b3226' : '#3c3a30');
    bg.addColorStop(1, zb ? '#100a08' : '#121210');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, 100, 100);
    if (zb) {
      ctx.fillStyle = 'rgba(140,20,20,0.2)';   // 脚下的血泊
      ctx.beginPath(); ctx.ellipse(48, 96, 40, 8, 0, 0, TAU); ctx.fill();
      const z = { type: look.type, def: ZOMBIES[look.type], r: 19, facing: 1, phase: 0, state: 'walk', seed: 0.6, flash: 0 };
      drawZombieBody(ctx, g, z, 44, 97);
    } else {
      ctx.translate(47, look.type === 'bird' ? 70 : 94);
      ctx.scale(2.2, 2.2);
      ctx.lineCap = 'butt';
      drawPet(ctx, g, { type: look.type, x: 0, y: 0, z: 0, facing: 1, phase: 0, bite: 0, charge: 0 });
    }
  }
  ctx.restore();
  // 暗角
  ctx.save();
  ctx.translate(fx, fy);
  ctx.scale(fs / 100, fs / 100);
  const vg = ctx.createRadialGradient(50, 45, 30, 50, 50, 75);
  vg.addColorStop(0, 'rgba(0,0,0,0)'); vg.addColorStop(1, 'rgba(0,0,0,0.55)');
  ctx.fillStyle = vg;
  ctx.fillRect(0, 0, 100, 100);
  ctx.restore();
}

// 剧情对话框：底部面板，左边头像，右边名字 + 打字机效果的台词
function drawDialog(ctx, g) {
  const d = g.dialog;
  if (!d) return;
  const [who, text] = d.lines[d.i], sp = SPEAKERS[who];
  const shown = Math.floor(d.t * DIALOG_SPEED), done = shown >= text.length;
  const bx = 150, by = H - 200, bw = W - 300, bh = 170;

  ctx.fillStyle = 'rgba(0,0,0,0.35)';
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = 'rgba(20,20,26,0.94)';
  ctx.beginPath(); ctx.roundRect(bx, by, bw, bh, 14); ctx.fill();
  ctx.strokeStyle = sp.color;
  ctx.lineWidth = 2;
  ctx.stroke();

  // 头像框（裁剪，防止大块头 BOSS 画出框外）
  ctx.save();
  ctx.beginPath(); ctx.roundRect(bx + 16, by + 16, 138, 138, 10); ctx.clip();
  drawPortrait(ctx, g, sp.look, bx + 16, by + 16, 138);
  ctx.restore();
  ctx.strokeStyle = 'rgba(255,255,255,0.15)';
  ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.roundRect(bx + 16, by + 16, 138, 138, 10); ctx.stroke();

  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = sp.color;
  ctx.font = `bold 22px ${FONT}`;
  ctx.fillText(sp.name, bx + 176, by + 34);
  ctx.fillStyle = '#eee';
  ctx.font = `20px ${FONT}`;
  wrapText(ctx, text.slice(0, shown), bx + 176, by + 74, bw - 200, 30);

  ctx.fillStyle = '#888';
  ctx.font = `13px ${FONT}`;
  ctx.textAlign = 'right';
  ctx.fillText(`${d.i + 1} / ${d.lines.length}    点击 / 空格 继续    Esc 跳过`, bx + bw - 18, by + bh - 18);
  if (done && Math.floor(g.time * 3) % 2) {
    ctx.fillStyle = sp.color;
    ctx.font = `16px ${FONT}`;
    ctx.fillText('▼', bx + bw - 18, by + bh - 44);
  }
}

function drawGame(ctx, g, input) {
  ctx.save();
  if (g.shake > 0) ctx.translate(rand(-1, 1) * g.shake, rand(-1, 1) * g.shake);
  drawWorld(ctx, g);
  ctx.restore();
  drawHUD(ctx, g);
  drawDialog(ctx, g);

  if (g.state === 'menu') {
    drawOverlay(ctx, '丧尸突围', [
      'WASD 移动    鼠标左键 射击    鼠标右键 翻滚（短暂无敌）',
      '1-6 / 滚轮 切换武器    P / Esc 暂停    G 测试：全武器+全宠物',
      'B 测试：直接进入本关 BOSS',
      '每关 3 波 + BOSS，击败 BOSS 后全场清空，三选一强化，然后进入新地图',
      '掉落：+ 回血   » 加速   弹 弹药   枪 新武器   宠 宠物',
      '宠物：狗 咬丧尸   猫 定时闪避   鸟 子弹追踪   幽灵 穿墙（稀有）；濒死时宠物替你挡刀',
      '红色油桶一打就炸，可以连锁；泥潭会减速，翻滚不受影响',
      '剧情对话时游戏暂停：点击 / 空格 继续，Esc 跳过',
    ], '点击开始');
  } else if (g.state === 'upgrade') {
    drawUpgrade(ctx, g, input);
  } else if (g.state === 'over') {
    drawOverlay(ctx, '你倒下了', [`到达第 ${g.stage} 关（共 ${g.wave} 波）`, `分数 ${g.score}    击杀 ${g.kills}`], g.overT > 1 ? '点击重新开始' : '');
  } else if (g.paused) {
    drawOverlay(ctx, '暂停', [], '按 P / Esc 继续');
  }
  drawCrosshair(ctx, input.mx, input.my);
}
