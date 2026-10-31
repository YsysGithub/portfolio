// 游戏核心：状态机、主循环、输入、关卡与波次、伤害结算与特效
// 流程：menu → playing（若干普通波 + BOSS 波）→ clear（BOSS 倒下，全场清空）→ upgrade（三选一）→ 下一关 → … → over
// weapons.js / zombies.js 只通过这里的公共方法（damageZombie、explode、hurtPlayer 等）影响世界。

// 随机生成一关的地图：墙（主题配色）、木箱、成簇的油桶、泥潭
function buildMap(stage) {
  const theme = THEMES[(stage - 1) % THEMES.length];
  const obs = [], muds = [];
  const add = (kind, x, y, w, h) => {
    const def = OBSTACLES[kind], wall = kind === 'wall';
    obs.push({
      kind, def, x, y, w, h, height: def.height, hp: def.hp, maxHp: def.hp, dead: false,
      top: wall ? theme.wallTop : def.top, front: wall ? theme.wallFront : def.front,
    });
  };
  // 避开中心出生点，且与已有障碍物保持 pad 间距
  const free = (r, pad) => Math.hypot(r.x + r.w / 2 - W / 2, r.y + r.h / 2 - H / 2) > 170
    && !obs.some((o) => r.x < o.x + o.w + pad && r.x + r.w + pad > o.x && r.y < o.y + o.h + pad && r.y + r.h + pad > o.y);
  const place = (kind, n, size, pad) => {
    for (let tries = 0, k = 0; tries < 300 && k < n; tries++) {
      const [w, h] = size();
      const r = { x: rand(60, W - 60 - w), y: rand(80, H - 60 - h), w, h };
      if (free(r, pad)) { add(kind, r.x, r.y, w, h); k++; }
    }
  };

  place('wall', 5 + Math.floor(rand(0, 3)), () => (Math.random() < 0.5 ? [rand(120, 220), 26] : [26, rand(100, 180)]), 70);
  place('crate', 8, () => [40, 32], 30);
  // 油桶 2~3 个一簇，方便打出连锁爆炸
  for (let c = 0; c < 4; c++) {
    const cx = rand(120, W - 120), cy = rand(120, H - 120);
    for (let i = 0; i < 3; i++) {
      const r = { x: cx + rand(-45, 45), y: cy + rand(-35, 35), w: 24, h: 22 };
      if (r.x > 40 && r.x < W - 64 && r.y > 60 && r.y < H - 60 && free(r, 6)) add('barrel', r.x, r.y, r.w, r.h);
    }
  }
  for (let tries = 0; tries < 30 && muds.length < 4; tries++) {
    const m = { x: rand(100, W - 100), y: rand(100, H - 100), rx: rand(60, 110), ry: rand(35, 60) };
    if (Math.hypot(m.x - W / 2, m.y - H / 2) > 150) muds.push(m);
  }
  return { theme, obs, muds };
}

function newPlayer() {
  const P = CONFIG.player;
  return {
    x: W / 2, y: H / 2, r: P.r, hp: P.hp, maxHp: P.hp, kx: 0, ky: 0,
    facing: 1, phase: 0, aim: 0, recoil: 0,
    roll: 0, rollDir: 1, rdx: 0, rdy: 0, rollCd: 0, rollCharge: 1, rollMax: 1,
    iframe: 0, hurtFlash: 0, speedBuff: 0, slow: 0, poison: null,
    weapon: 'usp', fireCd: 0,
    weapons: CONFIG.startAllWeapons ? Object.fromEntries(WEAPON_ORDER.map((k) => [k, WEAPONS[k].ammo])) : { usp: Infinity },
    // 肉鸽属性（由 config.js 的 UPGRADES 修改）
    dmgMul: 1, armor: 0, rateMul: 1, speedMul: 1, rollCdMul: 1, swords: 0,
    lifesteal: 0, blastMul: 1, pierce: 0, ammoMul: 1, upgrades: {},
  };
}

class Game {
  constructor() {
    this.state = 'menu';   // menu | playing | clear | upgrade | over
    this.paused = false;
    this.reset();
  }

  reset() {
    this.player = newPlayer();
    this.pets = {};   // type -> 宠物实例，每种最多一只
    this.clearWorld();
    this.stage = 1; this.stageWave = 0; this.wave = 0; this.bossWave = false;
    this.loadMap();
    this.queue = []; this.spawnT = 0; this.breakT = 1.5; this.trickleT = 0;
    this.choices = []; this.clearT = 0;
    this.score = 0; this.kills = 0; this.time = 0; this.shake = 0; this.overT = 0;
    this.messages = [];
    this.dialogs = [];        // 排队中的剧情对话，dialogs[0] 正在播放
    this.seen = new Set();    // 已播放过的剧情，同一局不重复
  }

  // 清空所有临时实体（换关时调用）
  clearWorld() {
    this.zombies = []; this.projectiles = []; this.spits = []; this.puddles = [];
    this.shots = []; this.hazards = []; this.delayed = [];
    this.pickups = []; this.particles = []; this.beams = []; this.rings = [];
    this.texts = []; this.decals = []; this.swordPos = [];
  }

  loadMap() {
    const m = buildMap(this.stage);
    this.theme = m.theme;
    this.obstacles = m.obs;
    this.muds = m.muds;
  }

  start() {
    this.reset();
    this.state = 'playing';
    this.paused = false;
    this.msg(`第 1 关 · ${this.theme.name}`, '#ffd166');
    this.say('intro', STORY.intro);
  }

  // ---------- 剧情对话（台词在 story.js） ----------
  // key 用于去重，传 null 表示每次都播放
  say(key, lines) {
    if (!lines) return;
    if (key) {
      if (this.seen.has(key)) return;
      this.seen.add(key);
    }
    this.dialogs.push({ lines, i: 0, t: 0 });
  }

  get dialog() { return this.dialogs[0]; }

  // 文字还没打完就直接显示整句，否则进入下一句
  advanceDialog() {
    const d = this.dialog;
    if (!d) return;
    const len = d.lines[d.i][1].length;
    if (d.t * DIALOG_SPEED < len) { d.t = len / DIALOG_SPEED; return; }
    d.t = 0;
    if (++d.i >= d.lines.length) this.dialogs.shift();
  }

  skipDialog() { this.dialogs.shift(); }

  // 丧尸第一次进入画面时触发它的剧情
  checkEncounters() {
    for (const z of this.zombies) {
      if (z.dead || z.x < 0 || z.x > W || z.y < 0 || z.y > H) continue;
      if (z.def.boss) this.say('boss:' + z.type, STORY.bossIntro[z.type]);
      else this.say('zombie:' + z.type, STORY.zombieFirst[z.type]);
    }
  }

  inMud(x, y) {
    return this.muds.some((m) => ((x - m.x) / m.rx) ** 2 + ((y - m.y) / m.ry) ** 2 < 1);
  }

  hpMul() { return 1 + CONFIG.wave.hpGrowth * Math.max(0, this.wave - 1); }

  later(t, fn) { this.delayed.push({ t, fn }); }

  // ---------- 主更新 ----------
  update(dt, input) {
    this.time += dt;
    this.shake = Math.max(0, this.shake - dt * 40);
    // 对话期间世界暂停，只推进打字机效果
    if (this.dialog) { this.dialog.t += dt; return; }
    if (this.state === 'playing') this.checkEncounters();

    if (this.state === 'playing' || this.state === 'clear') {
      this.updatePlayer(dt, input);
      this.updatePets(dt);
      this.updateSwords();
      if (this.state === 'playing') this.updateWaves(dt);
      for (const z of this.zombies) if (!z.dead) updateZombie(this, z, dt);
      this.separateZombies();
      for (const p of this.projectiles) if (!p.dead) PROJECTILES[p.kind](this, p, dt);
      for (const s of this.spits) if (!s.dead) updateSpit(this, s, dt);
      for (const s of this.shots) if (!s.dead) updateShot(this, s, dt);
      for (const h of this.hazards) if (!h.dead) updateHazard(this, h, dt);
      for (const d of this.delayed) if (!d.done && (d.t -= dt) <= 0) { d.done = true; d.fn(); }
      for (const pd of this.puddles) pd.life -= dt;

      if (this.state === 'clear') {
        // 清场阶段：道具自动飞向玩家，倒计时结束后进入三选一
        const p = this.player;
        for (const k of this.pickups) {
          const d = norm(p.x - k.x, p.y - k.y);
          k.x += d.x * 600 * dt; k.y += d.y * 600 * dt;
        }
        if ((this.clearT -= dt) <= 0) this.openUpgrade();
      } else {
        for (const k of this.pickups) k.life -= dt;
      }
      this.checkDeath();
    } else if (this.state === 'over') {
      this.overT += dt;
    }
    this.updateEffects(dt);
    this.cleanup();
  }

  updatePlayer(dt, input) {
    const p = this.player, P = CONFIG.player, k = input.keys;
    p.iframe -= dt; p.hurtFlash -= dt; p.speedBuff -= dt; p.slow -= dt; p.fireCd -= dt;
    p.recoil = Math.max(0, p.recoil - dt * 8);
    if (p.poison) {
      p.hp -= p.poison.dps * (1 - p.armor) * dt;
      if ((p.poison.t -= dt) <= 0) p.poison = null;
    }
    // 翻滚体力：每次恢复一格
    const rollCdMax = P.rollCooldown * p.rollCdMul;
    if (p.rollCharge < p.rollMax && (p.rollCd -= dt) <= 0) {
      p.rollCharge++;
      p.rollCd = rollCdMax;
    }

    const ix = (k.has('KeyD') ? 1 : 0) - (k.has('KeyA') ? 1 : 0);
    const iy = (k.has('KeyS') ? 1 : 0) - (k.has('KeyW') ? 1 : 0);
    const moving = ix !== 0 || iy !== 0;
    const d = norm(ix, iy);
    p.aim = Math.atan2(input.my + CONFIG.gunHeight - p.y, input.mx - p.x);
    if (p.roll <= 0) p.facing = Math.cos(p.aim) >= 0 ? 1 : -1;

    // 翻滚：有移动方向就朝移动方向，否则朝准星方向；有剩余次数时可在翻滚途中再接一次
    const canChain = p.roll <= 0 || P.rollTime - p.roll >= P.rollChain;
    if (input.rollPressed && p.rollCharge > 0 && canChain) {
      if (p.rollCharge === p.rollMax) p.rollCd = rollCdMax;
      p.rollCharge--;
      const dir = moving ? d : { x: Math.cos(p.aim), y: Math.sin(p.aim) };
      p.roll = P.rollTime; p.rdx = dir.x; p.rdy = dir.y;
      p.rollDir = dir.x >= 0 ? 1 : -1;
      p.iframe = Math.max(p.iframe, P.rollIframe);
      this.burst(p.x, p.y, 2, 8, '#8a8070', { speed: 80, up: 40, life: 0.4, size: 3 });
    }

    let vx = 0, vy = 0;
    if (p.roll > 0) {
      p.roll -= dt;
      vx = p.rdx * P.rollSpeed; vy = p.rdy * P.rollSpeed;
    } else if (moving) {
      const sp = P.speed * p.speedMul * (p.speedBuff > 0 ? 1.45 : 1) * (p.slow > 0 ? 0.55 : 1)
        * (this.inMud(p.x, p.y) ? CONFIG.mudSlow.player : 1);
      vx = d.x * sp; vy = d.y * sp;
    }
    p.x += (vx + p.kx) * dt;
    p.y += (vy + p.ky) * dt;
    const kd = Math.exp(-8 * dt);
    p.kx *= kd; p.ky *= kd;
    for (const o of this.obstacles) {
      if (o.dead || this.pets.ghost) continue;   // 幽灵：玩家穿墙
      const c = circleRect(p.x, p.y, p.r, o);
      if (c) { p.x += c.nx * c.depth; p.y += c.ny * c.depth; }
    }
    p.x = clamp(p.x, p.r, W - p.r);
    p.y = clamp(p.y, p.r, H - p.r);
    if (moving || p.roll > 0) p.phase += Math.hypot(vx, vy) * dt * 0.08;

    // 地面毒液：翻滚可以越过
    if (p.roll <= 0) {
      for (const pd of this.puddles) {
        if (Math.hypot(p.x - pd.x, (p.y - pd.y) / 0.55) < pd.r + p.r * 0.5) {
          p.hp -= pd.def.puddleDps * (1 - p.armor) * dt;
          p.slow = Math.max(p.slow, pd.def.slowTime);
        }
      }
    }

    for (const it of this.pickups) {
      if (it.life > 0 && Math.hypot(p.x - it.x, p.y - it.y) < p.r + 14) {
        it.life = 0;
        const text = PICKUPS[it.type].apply(this);
        this.floatText(p.x, p.y - 60, text, PICKUPS[it.type].color, 18);
      }
    }

    const def = WEAPONS[p.weapon];
    if (p.roll <= 0 && p.fireCd <= 0 && (def.auto ? input.down : input.clicked)) this.fire();
  }

  fire() {
    const p = this.player, def = WEAPONS[p.weapon];
    const dx = Math.cos(p.aim), dy = Math.sin(p.aim);
    const mx = p.x + dx * 26, my = p.y + dy * 26;
    FIRE[def.type](this, def, { x: mx, y: my, dx, dy });
    p.fireCd = def.rate * p.rateMul;
    p.recoil = 1;
    this.shake = Math.max(this.shake, def.shake || 1.5);
    this.burst(mx, my, CONFIG.gunHeight, 3, '#ffd98a', { speed: 120, up: 20, grav: 0, life: 0.08, size: 2.5 });
    if (isFinite(p.weapons[p.weapon]) && --p.weapons[p.weapon] <= 0) {
      this.msg(`${def.name} 没子弹了`, '#ccc');
      p.weapon = 'usp';
    }
  }

  switchWeapon(key) {
    const p = this.player;
    if (p.weapons[key] > 0) { p.weapon = key; p.fireCd = Math.max(p.fireCd, 0.1); }
  }

  cycleWeapon(step) {
    const owned = WEAPON_ORDER.filter((k) => this.player.weapons[k] > 0);
    const i = owned.indexOf(this.player.weapon);
    this.switchWeapon(owned[(i + step + owned.length) % owned.length]);
  }

  // 飞剑：绕玩家旋转，切割丧尸（每把剑对同一只丧尸有独立冷却），并拦截毒液和敌方弹幕
  updateSwords() {
    const p = this.player, S = CONFIG.sword;
    this.swordPos = [];
    for (let i = 0; i < p.swords; i++) {
      const a = this.time * S.spin + (i * TAU) / p.swords;
      const s = { x: p.x + Math.cos(a) * S.radius, y: p.y + Math.sin(a) * S.radius * 0.7, a };
      this.swordPos.push(s);
      for (const z of this.zombies) {
        if (z.dead || z.z > 30 || Math.hypot(z.x - s.x, z.y - s.y) > z.r + 12) continue;
        z.swordCds = z.swordCds || [];
        if ((z.swordCds[i] || 0) > this.time) continue;
        z.swordCds[i] = this.time + S.hitCd;
        const n = norm(z.x - p.x, z.y - p.y);
        this.damageZombie(z, S.dmg, n.x, n.y, 120);
        this.sparks(s.x, s.y, CONFIG.gunHeight, '#bff6ff', 3);
      }
      for (const sh of this.shots) {
        if (!sh.dead && Math.hypot(sh.x - s.x, sh.y - s.y) < sh.r + 12) { sh.dead = true; this.sparks(sh.x, sh.y, 16, '#bff6ff', 5); }
      }
      for (const sp of this.spits) {
        if (!sp.dead && Math.hypot(sp.x - s.x, sp.y - s.y) < 18) { sp.dead = true; this.burst(sp.x, sp.y, sp.z, 6, '#9ad13a', { speed: 80, up: 40 }); }
      }
    }
  }

  // ---------- 关卡与波次 ----------
  updateWaves(dt) {
    if (this.queue.length) {
      if ((this.spawnT -= dt) <= 0) {
        this.spawnZombie(this.queue.shift());
        this.spawnT = CONFIG.wave.spawnInterval;
      }
    } else if (this.bossWave) {
      // BOSS 战期间持续少量刷小怪
      if ((this.trickleT -= dt) <= 0 && this.zombies.length < 8) {
        this.spawnZombie(weightedPick(this.spawnTable()).type);
        this.trickleT = 3.5;
      }
    } else if (!this.zombies.length && (this.breakT -= dt) <= 0) {
      this.startWave();
    }
  }

  spawnTable() {
    return SPAWN_TABLE.filter((s) => this.wave >= (s.minWave || 1));
  }

  startWave() {
    const C = CONFIG.wave;
    this.wave++;
    this.stageWave++;
    this.breakT = C.breakTime;
    const table = this.spawnTable();
    if (this.stageWave > CONFIG.stage.waves) {
      this.bossWave = true;
      this.trickleT = 6;
      const type = BOSS_ROTATION[(this.stage - 1) % BOSS_ROTATION.length];
      this.queue.push(type);
      for (let i = 0; i < 4; i++) this.queue.push(weightedPick(table).type);
      this.msg(`BOSS：${ZOMBIES[type].name}`, '#ff5a5a');
      return;
    }
    const count = C.baseCount + C.perWave * (this.wave - 1);
    for (let i = 0; i < count; i++) this.queue.push(weightedPick(table).type);
    this.msg(`第 ${this.stage}-${this.stageWave} 波`, '#ffd166');
  }

  spawnZombie(type) {
    const side = Math.floor(Math.random() * 4), m = 40;
    const x = side === 0 ? -m : side === 1 ? W + m : rand(0, W);
    const y = side === 2 ? -m : side === 3 ? H + m : rand(0, H);
    const hpMul = ZOMBIES[type].boss ? 1 + CONFIG.stage.bossHpGrowth * (this.stage - 1) : this.hpMul();
    this.zombies.push(makeZombie(type, x, y, hpMul));
  }

  // 测试用：跳过普通波，直接进入本关 BOSS 战
  skipToBoss() {
    if (this.bossWave || this.state !== 'playing') return;
    for (const z of this.zombies) this.killZombie(z, true);
    this.queue = [];
    this.stageWave = CONFIG.stage.waves;
    this.breakT = 0.3;
  }

  // BOSS 倒下：其余丧尸全部死亡，清掉敌方攻击，稍后进入三选一
  stageClear(type) {
    this.say('defeat:' + type, STORY.bossDefeat[type]);
    if (type === BOSS_ROTATION[BOSS_ROTATION.length - 1]) this.say('ending', STORY.ending);
    for (const z of this.zombies) this.killZombie(z, true);
    this.queue = []; this.shots = []; this.hazards = []; this.spits = []; this.puddles = []; this.delayed = [];
    this.bossWave = false;
    this.state = 'clear';
    this.clearT = CONFIG.stage.clearDelay;
    this.shake = 22;
    this.msg('BOSS 已击败', '#ffd166');
  }

  openUpgrade() {
    const p = this.player;
    const pool = UPGRADES
      .filter((u) => (p.upgrades[u.id] || 0) < u.max && (!u.avail || u.avail(this)))
      .map((u) => ({ u, w: u.w || 1 }));
    this.choices = [];
    while (this.choices.length < 3 && pool.length) {
      const it = weightedPick(pool);
      this.choices.push(it.u);
      pool.splice(pool.indexOf(it), 1);
    }
    this.state = 'upgrade';
  }

  chooseUpgrade(i) {
    const u = this.choices[i];
    if (!u || this.state !== 'upgrade') return;
    const p = this.player;
    p.upgrades[u.id] = (p.upgrades[u.id] || 0) + 1;
    u.apply(p, this);
    this.nextStage();
    this.msg(`强化：${u.name}`, u.color);
  }

  nextStage() {
    this.stage++;
    this.clearWorld();
    this.loadMap();
    const p = this.player;
    p.x = W / 2; p.y = H / 2; p.kx = p.ky = 0; p.poison = null; p.slow = 0; p.roll = 0;
    p.hp = Math.min(p.maxHp, p.hp + p.maxHp * CONFIG.stage.healOnClear);
    for (const pet of Object.values(this.pets)) { pet.x = p.x + rand(-30, 30); pet.y = p.y + rand(-30, 30); }
    this.queue = []; this.stageWave = 0; this.breakT = 2; this.bossWave = false;
    this.state = 'playing';
    this.msg(`第 ${this.stage} 关 · ${this.theme.name}`, '#ffd166');
    this.say('stage:' + this.stage, STORY.stageStart[this.stage]);
  }

  // 丧尸之间互相推开，体型大的更难推动
  separateZombies() {
    const zs = this.zombies;
    for (let i = 0; i < zs.length; i++) {
      const a = zs[i];
      if (a.dead) continue;
      for (let j = i + 1; j < zs.length; j++) {
        const b = zs[j];
        if (b.dead) continue;
        const dx = b.x - a.x, dy = b.y - a.y, min = a.r + b.r, d2 = dx * dx + dy * dy;
        if (d2 >= min * min || d2 < 1e-6) continue;
        const d = Math.sqrt(d2), push = min - d, wa = b.r / min, wb = a.r / min;
        a.x -= (dx / d) * push * wa; a.y -= (dy / d) * push * wa;
        b.x += (dx / d) * push * wb; b.y += (dy / d) * push * wb;
      }
    }
  }

  // ---------- 伤害与结算（供武器 / 丧尸调用） ----------
  // mul 默认使用玩家攻击倍率；丧尸自爆、油桶等环境伤害传 1
  damageZombie(z, dmg, dx, dy, knock, mul = this.player.dmgMul) {
    if (z.dead) return;
    dmg *= mul;
    z.hp -= dmg;
    z.flash = 0.08;
    z.kx += dx * knock * z.def.knockMul;
    z.ky += dy * knock * z.def.knockMul;
    this.burst(z.x, z.y, 25 * z.r / 14 + z.z, 3, '#7a1a1a', { speed: 90, up: 60, life: 0.4, size: 2.5 });
    this.floatText(z.x + rand(-8, 8), z.y - z.z - z.r * 4, Math.round(dmg), '#fff', 13);
    if (z.hp <= 0) this.killZombie(z);
  }

  // quiet：清场时使用，不计分、不掉落、不触发自爆
  killZombie(z, quiet = false) {
    if (z.dead) return;
    z.dead = true;
    this.burst(z.x, z.y, 20, 14, '#6a1515', { speed: 160, up: 140, life: 0.7, size: 3.5 });
    this.decals.push({ x: z.x, y: z.y, r: z.r * 1.2, life: 20 });
    if (quiet) return;
    const p = this.player;
    this.score += z.def.score;
    this.kills++;
    if (p.lifesteal) p.hp = Math.min(p.maxHp, p.hp + p.lifesteal);
    if (z.def.blast) this.explode(z.x, z.y, z.def.blast, false);
    if (z.def.boss) {
      for (let i = 0; i < 3; i++) this.dropPickup(z.x + rand(-40, 40), z.y + rand(-30, 30));
      this.burst(z.x, z.y, 30, 40, '#ffd166', { speed: 260, up: 260, life: 1, size: 4 });
      this.stageClear(z.type);
      return;
    }
    if (Math.random() < CONFIG.dropChance) this.dropPickup(z.x, z.y);
  }

  damageObstacle(o, dmg) {
    if (o.dead || !isFinite(o.hp)) return;
    o.hp -= dmg;
    if (o.hp > 0) return;
    o.dead = true;
    const cx = o.x + o.w / 2, cy = o.y + o.h / 2;
    this.burst(cx, cy, 15, 16, o.top, { speed: 180, up: 160, life: 0.8, size: 4 });
    // 油桶延迟一小会儿再爆，连锁时能看出先后顺序
    if (o.def.blast) this.later(0.1, () => this.explode(cx, cy, o.def.blast, false));
    else if (Math.random() < (o.def.dropChance || 0)) this.dropPickup(cx, cy);
  }

  // fromPlayer：玩家武器造成的爆炸，享受攻击/爆破强化，对自己只有 30% 伤害
  explode(x, y, b, fromPlayer) {
    const p = this.player;
    const r = b.r * (fromPlayer ? p.blastMul : 1), mul = fromPlayer ? p.dmgMul : 1;
    this.shake = Math.max(this.shake, b.shake || 8);
    this.rings.push({ x, y, r, life: 0.35, max: 0.35 });
    this.decals.push({ x, y, r: r * 0.45, life: 25 });
    this.burst(x, y, 10, 28, '#ffb030', { speed: r * 3, up: 200, life: 0.5, size: 5 });
    this.burst(x, y, 20, 14, 'rgba(90,90,90,0.8)', { speed: r * 1.5, up: 80, grav: -60, life: 1.1, size: 9 });

    for (const z of this.zombies) {
      if (z.dead) continue;
      const d = Math.hypot(z.x - x, z.y - y);
      if (d > r + z.r) continue;
      const k = 1 - d / (r + z.r), n = norm(z.x - x, z.y - y);
      this.damageZombie(z, b.dmg * (0.4 + 0.6 * k), n.x, n.y, b.knock * (0.3 + 0.7 * k), mul);
    }
    for (const o of this.obstacles) {
      if (!o.dead && rectCircleDist(x, y, o) < r) this.damageObstacle(o, b.dmg);
    }
    const d = Math.hypot(p.x - x, p.y - y);
    if (d < r + p.r) {
      const k = 1 - d / (r + p.r);
      this.hurtPlayer(b.dmg * (0.4 + 0.6 * k) * (fromPlayer ? 0.3 : 1), x, y, b.knock * k);
    }
  }

  // 返回是否真正造成了伤害（无敌帧、猫闪避、非战斗状态时返回 false）
  hurtPlayer(dmg, sx, sy, knock) {
    const p = this.player;
    if (p.iframe > 0 || p.hp <= 0 || this.state !== 'playing') return false;
    const cat = this.pets.cat;
    if (cat && cat.charge >= PETS.cat.interval) {
      cat.charge = 0;
      p.iframe = 0.4;
      this.floatText(p.x, p.y - 60, '喵！闪避', PETS.cat.color, 18);
      this.burst(p.x, p.y, 20, 10, PETS.cat.color, { speed: 120, up: 60, life: 0.4, size: 3 });
      return false;
    }
    p.hp -= dmg * (1 - p.armor);
    p.iframe = CONFIG.player.hurtIframe;
    p.hurtFlash = 0.1;
    const n = norm(p.x - sx, p.y - sy);
    p.kx += n.x * knock; p.ky += n.y * knock;
    this.shake = Math.max(this.shake, 6);
    this.burst(p.x, p.y, 25, 6, '#b02020', { speed: 100, up: 80, life: 0.4, size: 3 });
    this.checkDeath();
    return true;
  }

  poisonPlayer(dps, t) {
    const p = this.player;
    p.poison = { dps: Math.max(dps, p.poison?.dps || 0), t: Math.max(t, p.poison?.t || 0) };
  }

  checkDeath() {
    const p = this.player;
    if (p.hp > 0 || this.state !== 'playing') return;
    // 有宠物时：随机失去一只宠物，保住性命
    const owned = Object.keys(this.pets);
    if (owned.length) {
      const k = owned[Math.floor(Math.random() * owned.length)];
      const pet = this.pets[k];
      delete this.pets[k];
      p.hp = Math.round(p.maxHp * 0.3);
      p.iframe = 1.5;
      p.poison = null;
      this.burst(pet.x, pet.y, 15, 24, PETS[k].color, { speed: 160, up: 160, life: 0.8, size: 4 });
      this.msg(`${PETS[k].name}替你挡下致命一击，离开了你`, '#ff9ec8');
      this.say(null, STORY.petFarewell[k]);
      return;
    }
    this.dialogs = [];
    this.state = 'over';
    this.overT = 0;
    this.burst(p.x, p.y, 20, 30, '#a01818', { speed: 200, up: 180, life: 1, size: 4 });
  }

  // ---------- 道具 ----------
  dropPickup(x, y) {
    const types = Object.entries(PICKUPS).map(([type, d]) => ({ type, w: d.w }));
    this.pickups.push({ type: weightedPick(types).type, x: clamp(x, 20, W - 20), y: clamp(y, 30, H - 20), life: CONFIG.pickupLife });
  }

  maxAmmo(k) { return Math.round(WEAPONS[k].ammo * this.player.ammoMul); }

  addAmmoAll() {
    const p = this.player;
    for (const k of Object.keys(p.weapons)) {
      if (isFinite(p.weapons[k])) p.weapons[k] = Math.min(this.maxAmmo(k), p.weapons[k] + WEAPONS[k].pickupAmmo);
    }
    return '弹药补给';
  }

  refillAmmo() {
    const p = this.player;
    for (const k of Object.keys(p.weapons)) if (isFinite(p.weapons[k])) p.weapons[k] = this.maxAmmo(k);
  }

  giveRandomWeapon() {
    const p = this.player;
    const missing = WEAPON_ORDER.filter((k) => !(p.weapons[k] > 0));
    if (!missing.length) return this.addAmmoAll();
    const k = missing[Math.floor(Math.random() * missing.length)];
    p.weapons[k] = this.maxAmmo(k);
    p.weapon = k;
    this.msg(`获得 ${WEAPONS[k].name}`, '#c99bff');
    return WEAPONS[k].name;
  }

  giveAllWeapons() {
    for (const k of WEAPON_ORDER) this.player.weapons[k] = this.maxAmmo(k);
    this.msg('测试：获得全部武器', '#c99bff');
  }

  // ---------- 宠物 ----------
  addPet(k) {
    const p = this.player;
    this.pets[k] = { type: k, x: p.x + rand(-30, 30), y: p.y + rand(-30, 30), z: 0, facing: 1, phase: 0, cd: 0, bite: 0, charge: PETS.cat.interval };
  }

  givePet() {
    const missing = Object.entries(PETS).filter(([k]) => !this.pets[k]).map(([type, d]) => ({ type, w: d.w }));
    if (!missing.length) { const p = this.player; p.hp = Math.min(p.maxHp, p.hp + 35); return '生命 +35'; }
    const k = weightedPick(missing).type;
    this.addPet(k);
    this.msg(`获得宠物：${PETS[k].name}`, PETS[k].color);
    this.say('pet:' + k, STORY.petFirst[k]);
    return PETS[k].name;
  }

  giveAllPets() {
    for (const k of Object.keys(PETS)) if (!this.pets[k]) this.addPet(k);
    this.msg('测试：获得全部宠物', '#ff9ec8');
  }

  updatePets(dt) {
    const p = this.player;
    // 跟随位置（x 随玩家朝向翻转，排在身后两侧）
    const slots = { dog: [-38, 16], cat: [-30, -18], bird: [10, -30], ghost: [-50, -4] };
    for (const pet of Object.values(this.pets)) {
      const def = PETS[pet.type];
      let tx = p.x + slots[pet.type][0] * p.facing, ty = p.y + slots[pet.type][1], stop = 6;
      pet.cd -= dt; pet.bite -= dt;

      if (pet.type === 'dog') {
        // 攻击玩家附近最近的丧尸
        let target = null, best = def.range;
        for (const z of this.zombies) {
          if (z.dead || z.z > 30) continue;
          const d = Math.hypot(z.x - p.x, z.y - p.y);
          if (d < best) { best = d; target = z; }
        }
        if (target) {
          tx = target.x; ty = target.y; stop = target.r + 8;
          if (Math.hypot(target.x - pet.x, target.y - pet.y) < target.r + 16 && pet.cd <= 0) {
            const n = norm(target.x - pet.x, target.y - pet.y);
            this.damageZombie(target, def.dmg, n.x, n.y, def.knock);
            pet.cd = def.rate;
            pet.bite = 0.15;
          }
        }
      } else if (pet.type === 'cat') {
        pet.charge = Math.min(def.interval, pet.charge + dt);
      }
      pet.z = pet.type === 'bird' ? 46 + Math.sin(this.time * 3) * 5 : pet.type === 'ghost' ? 18 + Math.sin(this.time * 2) * 4 : 0;

      const dx = tx - pet.x, dy = ty - pet.y, d = Math.hypot(dx, dy);
      if (d > stop) {
        const step = Math.min(d - stop, Math.max(def.speed || 260, d * 4) * dt);
        pet.x += (dx / d) * step; pet.y += (dy / d) * step;
        pet.phase += step * 0.15;
        if (Math.abs(dx) > 2) pet.facing = dx > 0 ? 1 : -1;
      } else {
        pet.facing = p.facing;
      }
    }
  }

  // ---------- 特效 ----------
  burst(x, y, z, n, color, o = {}) {
    const speed = o.speed ?? 100, life = o.life ?? 0.5;
    for (let i = 0; i < n; i++) {
      const a = rand(0, TAU), s = rand(0.3, 1) * speed;
      this.particles.push({
        x, y, z, vx: Math.cos(a) * s, vy: Math.sin(a) * s * 0.6, vz: rand(0.4, 1) * (o.up ?? 50),
        grav: o.grav ?? 600, life: life * rand(0.6, 1), max: life, size: (o.size ?? 3) * rand(0.6, 1.2), color,
      });
    }
  }

  sparks(x, y, z, color, n) {
    this.burst(x, y, z, n, color, { speed: 160, up: 80, life: 0.25, size: 2 });
  }

  floatText(x, y, text, color, size) {
    this.texts.push({ x, y, text: String(text), color, size, life: 0.8 });
  }

  msg(text, color) {
    this.messages.push({ text, color, life: 2.2 });
    if (this.messages.length > 3) this.messages.shift();
  }

  updateEffects(dt) {
    for (const pt of this.particles) {
      const f = Math.exp(-2 * dt);
      pt.vx *= f; pt.vy *= f;
      pt.vz -= pt.grav * dt;
      pt.x += pt.vx * dt; pt.y += pt.vy * dt; pt.z += pt.vz * dt;
      if (pt.z < 0) { pt.z = 0; pt.vz = 0; pt.vx *= 0.5; pt.vy *= 0.5; }
      pt.life -= dt;
    }
    for (const t of this.texts) { t.y -= 40 * dt; t.life -= dt; }
    for (const arr of [this.beams, this.rings, this.messages, this.decals]) for (const e of arr) e.life -= dt;
  }

  cleanup() {
    const alive = (e) => !e.dead;
    const living = (e) => e.life > 0;
    this.zombies = this.zombies.filter(alive);
    this.projectiles = this.projectiles.filter(alive);
    this.spits = this.spits.filter(alive);
    this.shots = this.shots.filter(alive);
    this.hazards = this.hazards.filter(alive);
    this.delayed = this.delayed.filter((d) => !d.done);
    this.obstacles = this.obstacles.filter(alive);
    this.puddles = this.puddles.filter(living);
    this.pickups = this.pickups.filter(living);
    this.particles = this.particles.filter(living);
    if (this.particles.length > 1500) this.particles.splice(0, this.particles.length - 1500);
    this.beams = this.beams.filter(living);
    this.rings = this.rings.filter(living);
    this.texts = this.texts.filter(living);
    this.messages = this.messages.filter(living);
    this.decals = this.decals.filter(living);
  }
}

// ---------- 启动与输入 ----------
(() => {
  const canvas = document.getElementById('game');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  const game = new Game();
  const input = { keys: new Set(), mx: W / 2, my: H / 2, down: false, clicked: false, rollPressed: false };
  const fighting = () => game.state === 'playing' || game.state === 'clear';

  function toCanvas(e) {
    const r = canvas.getBoundingClientRect();
    input.mx = clamp((e.clientX - r.left) * W / r.width, 0, W);
    input.my = clamp((e.clientY - r.top) * H / r.height, 0, H);
  }

  window.addEventListener('mousemove', toCanvas);
  canvas.addEventListener('mousedown', (e) => {
    toCanvas(e);
    if (e.button === 0) {
      if (game.state === 'menu' || (game.state === 'over' && game.overT > 1)) { game.start(); return; }
      if (game.dialog) { game.advanceDialog(); return; }
      if (game.state === 'upgrade') {
        const i = upgradeCardRects(game.choices.length).findIndex((r) => pointInRect(input.mx, input.my, r));
        if (i >= 0) game.chooseUpgrade(i);
        return;
      }
      if (game.paused) return;
      input.down = true;
      input.clicked = true;
    } else if (e.button === 2) {
      input.rollPressed = true;
    }
  });
  window.addEventListener('mouseup', (e) => { if (e.button === 0) input.down = false; });
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    if (fighting()) game.cycleWeapon(e.deltaY > 0 ? 1 : -1);
  }, { passive: false });

  window.addEventListener('keydown', (e) => {
    input.keys.add(e.code);
    if (game.dialog) {
      if (e.code === 'Space' || e.code === 'Enter') { e.preventDefault(); game.advanceDialog(); }
      if (e.code === 'Escape') game.skipDialog();
      return;
    }
    const n = /^Digit([1-9])$/.exec(e.code);
    if (game.state === 'upgrade') {
      if (n) game.chooseUpgrade(n[1] - 1);
      return;
    }
    if (!fighting()) return;
    if (e.code === 'KeyP' || e.code === 'Escape') game.paused = !game.paused;
    if (game.paused) return;
    if (n && WEAPON_ORDER[n[1] - 1]) game.switchWeapon(WEAPON_ORDER[n[1] - 1]);
    if (e.code === 'KeyG') { game.giveAllWeapons(); game.giveAllPets(); }
    if (e.code === 'KeyB') game.skipToBoss();
  });
  window.addEventListener('keyup', (e) => input.keys.delete(e.code));
  window.addEventListener('blur', () => {
    input.keys.clear();
    input.down = false;
    if (fighting() && !game.dialog) game.paused = true;
  });

  let last = performance.now();
  function frame(now) {
    const dt = Math.min(0.033, (now - last) / 1000);
    last = now;
    if (!game.paused) game.update(dt, input);
    input.clicked = false;
    input.rollPressed = false;
    drawGame(ctx, game, input);
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
})();
