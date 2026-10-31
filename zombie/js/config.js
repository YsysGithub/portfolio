// 所有可调数值集中在这里。新增武器 / 丧尸 / 道具 / 强化：加一条配置，
// 如果是新的"类型"（type / ai），再到 weapons.js / zombies.js 注册对应行为。

const CONFIG = {
  width: 1280,
  height: 720,
  gunHeight: 24,          // 枪口离地高度（伪 2D 的侧面高度）
  startAllWeapons: true,  // 开局拿到全部武器（试玩用，改成 false 则需要靠掉落获得）
  player: {
    hp: 100, speed: 210, r: 14,
    rollSpeed: 520, rollTime: 0.32, rollIframe: 0.42,
    rollCooldown: 0.9,    // 每次翻滚的体力恢复时间
    rollChain: 0.12,      // 翻滚开始多少秒后可以接下一次翻滚（需要有剩余次数）
    hurtIframe: 0.6,
    colors: { body: '#3a6ea5', head: '#f1c27d', legs: '#2b3a4a' },
  },
  wave: { baseCount: 6, perWave: 3, spawnInterval: 0.6, breakTime: 3, hpGrowth: 0.08 },
  // 每关 waves 个普通波次，之后是 BOSS 波；击败 BOSS 清场 → 三选一强化 → 换地图
  stage: { waves: 3, bossHpGrowth: 0.3, clearDelay: 1.8, healOnClear: 0.25 },
  sword: { dmg: 16, radius: 62, spin: 3.4, hitCd: 0.35 },
  mudSlow: { player: 0.55, zombie: 0.6 },
  dropChance: 0.16,       // 丧尸默认掉落概率
  pickupLife: 15,         // 道具存在时间（秒）
};
const W = CONFIG.width, H = CONFIG.height;

// type: bullet | laser | grenade | rocket（对应 weapons.js 中的 FIRE / PROJECTILES）
const WEAPONS = {
  usp:     { name: 'USP',      type: 'bullet',  auto: false, rate: 0.16, dmg: 22, speed: 1000, spread: 0.02, knock: 60,
             ammo: Infinity, color: '#ffe08a', gun: { len: 18, w: 5, color: '#2b2b2b' } },
  deagle:  { name: '沙漠之鹰', type: 'bullet',  auto: false, rate: 0.55, dmg: 80, speed: 1300, spread: 0.01, knock: 240, pierce: 1, shake: 4,
             ammo: 35, pickupAmmo: 14, color: '#ffb347', gun: { len: 22, w: 6, color: '#a0a0a0' } },
  smg:     { name: '冲锋枪',   type: 'bullet',  auto: true,  rate: 0.07, dmg: 11, speed: 950,  spread: 0.12, knock: 30,
             ammo: 240, pickupAmmo: 120, color: '#fff3b0', gun: { len: 24, w: 6, color: '#1d1d1d' } },
  laser:   { name: '激光枪',   type: 'laser',   auto: true,  rate: 0.1,  dmg: 14, range: 1600, bounces: 3, knock: 10,
             ammo: 150, pickupAmmo: 60, color: '#ff3df5', gun: { len: 26, w: 7, color: '#b03ab0' } },
  grenade: { name: '榴弹枪',   type: 'grenade', auto: false, rate: 0.7,  dmg: 25, speed: 620, lift: 260, fuse: 1.6, shake: 3,
             blast: { r: 110, dmg: 90, knock: 380, shake: 10 },
             ammo: 12, pickupAmmo: 6, gun: { len: 24, w: 9, color: '#3d5a2a' } },
  rocket:  { name: '导弹枪',   type: 'rocket',  auto: false, rate: 1.1,  speed0: 60, ignite: 0.35, accel: 2200, maxSpeed: 1200, shake: 5,
             blast: { r: 150, dmg: 170, knock: 520, shake: 16 },
             ammo: 6, pickupAmmo: 3, gun: { len: 32, w: 10, color: '#5a6b3a' } },
};
const WEAPON_ORDER = ['usp', 'deagle', 'smg', 'laser', 'grenade', 'rocket'];

// ai: chase | bomber | spitter | boss | ranged | slam | hunter | summoner（对应 zombies.js 中的 AI）
// boss: true 的丧尸会显示底部血条，被击败时结束本关
const ZOMBIES = {
  walker:  { name: '炮灰丧尸', ai: 'chase',   hp: 40,   speed: 72,  r: 13, dmg: 10, knockMul: 1,    score: 10,
             colors: { body: '#6b8e4e', head: '#9bbf7a', legs: '#4a3b2a' } },
  tank:    { name: '肉盾丧尸', ai: 'chase',   hp: 320,  speed: 36,  r: 22, dmg: 20, knockMul: 1,    score: 40,
             colors: { body: '#556b3a', head: '#7d9460', legs: '#3a2f22' } },
  bomber:  { name: '爆炸丧尸', ai: 'bomber',  hp: 5,    speed: 100, r: 12, dmg: 0,  knockMul: 1.2,  score: 15,
             blast: { r: 100, dmg: 45, knock: 450, shake: 10 },
             colors: { body: '#b5552d', head: '#d98b5f', legs: '#4a2b1a' } },
  spitter: { name: '污染丧尸', ai: 'spitter', hp: 90,   speed: 52,  r: 15, dmg: 8,  knockMul: 0.8,  score: 25,
             range: 320, windup: 0.75, cooldown: 2.6,
             spit: { speed: 380, hitDmg: 12, poisonDps: 5, poisonTime: 3, puddleR: 36, puddleTime: 1, puddleDps: 4, slowTime: 0.8 },
             colors: { body: '#7a9a2a', head: '#b7d34a', legs: '#3f4a1a' } },

  // ---- BOSS ----
  boss:    { name: '丧尸巨兽', ai: 'boss', boss: true, hp: 2500, speed: 30, r: 46, dmg: 25, knockMul: 0.05, score: 500,
             range: 340, windup: 1.1, chargeSpeed: 560, chargeTime: 0.55, chargeDmg: 40, recover: 0.9, cooldown: 2,
             colors: { body: '#4b5a36', head: '#6f8150', legs: '#2e2a20' } },
  boss_ranged:   { name: '腐骨射手', ai: 'ranged', boss: true, hp: 2200, speed: 44, r: 40, dmg: 20, knockMul: 0.05, score: 600,
             range: 380, windup: 0.6, cooldown: 1.5,
             shot: { speed: 330, dmg: 14, r: 8, color: '#e8d27a' },
             colors: { body: '#5a4a6a', head: '#a99ab8', legs: '#2e2638' } },
  boss_slam:     { name: '震地巨像', ai: 'slam', boss: true, hp: 3200, speed: 34, r: 52, dmg: 30, knockMul: 0.02, score: 700,
             windup: 1.1, cooldown: 2.2, recover: 0.7,
             slam: { r: 210, dmg: 35, knock: 600 },
             meteor: { n: 6, r: 70, dmg: 22, knock: 300, spread: 170 },
             colors: { body: '#6a5040', head: '#9a7a60', legs: '#3a2a20' } },
  boss_hunter:   { name: '猎杀者', ai: 'hunter', boss: true, hp: 2200, speed: 88, r: 38, dmg: 22, knockMul: 0.08, score: 700,
             windup: 0.6, cooldown: 1.8,
             orb: { n: 3, speed: 230, dmg: 16, r: 9, turn: 2.2, life: 4.5, color: '#ff5a5a' },
             leap: { time: 0.5, r: 95, dmg: 32, knock: 500 },
             colors: { body: '#7a2a2a', head: '#c06060', legs: '#3a1a1a' } },
  boss_summoner: { name: '亡灵召唤师', ai: 'summoner', boss: true, hp: 2000, speed: 40, r: 36, dmg: 18, knockMul: 0.08, score: 700,
             range: 420, windup: 1.0, cooldown: 3.6,
             summon: { n: 5, types: ['walker', 'walker', 'bomber', 'spitter'], cap: 40 },
             shotRate: 1.3, shot: { speed: 260, dmg: 12, r: 8, color: '#b07aff' },
             colors: { body: '#3a3a5a', head: '#8a8ac0', legs: '#22223a' } },
};
// 第 n 关的 BOSS = BOSS_ROTATION[(n - 1) % 长度]，轮完一圈后血量继续成长
const BOSS_ROTATION = ['boss', 'boss_ranged', 'boss_slam', 'boss_hunter', 'boss_summoner'];

// 刷怪权重；minWave 之前不会出现
const SPAWN_TABLE = [
  { type: 'walker',  w: 5 },
  { type: 'bomber',  w: 3 },
  { type: 'spitter', w: 3 },
  { type: 'tank',    w: 2, minWave: 2 },
];

// 墙的颜色由地图主题决定；有 blast 的障碍物被打爆时会爆炸（可连锁）
const OBSTACLES = {
  wall:   { height: 56, hp: Infinity, top: '#9aa0a8', front: '#646a73' },
  crate:  { height: 34, hp: 80,       top: '#d0a061', front: '#93682f', dropChance: 0.3 },
  barrel: { height: 40, hp: 25,       top: '#e0503a', front: '#a8321f', blast: { r: 120, dmg: 80, knock: 450, shake: 12 } },
};

// 每关换一个主题，按顺序循环
const THEMES = [
  { name: '荒野草地', ground: '#3c4a34', wallTop: '#9aa0a8', wallFront: '#646a73', mud: '#4a3a22' },
  { name: '沙漠小镇', ground: '#8a7448', wallTop: '#c9a46a', wallFront: '#8a6a3a', mud: '#5a4426' },
  { name: '冰封废墟', ground: '#6f8696', wallTop: '#d6e4ee', wallFront: '#8aa0b0', mud: '#3f4a55' },
  { name: '焦土工厂', ground: '#3a3434', wallTop: '#7a6a6a', wallFront: '#4a3c3c', mud: '#251c1c' },
];

// apply 返回提示文字
const PICKUPS = {
  heal:   { label: '+', color: '#e94b4b', w: 4, apply: (g) => { const p = g.player; p.hp = Math.min(p.maxHp, p.hp + 35); return '生命 +35'; } },
  speed:  { label: '»', color: '#3fb6e8', w: 2, apply: (g) => { g.player.speedBuff = 6; return '加速 6 秒'; } },
  ammo:   { label: '弹', color: '#d9b440', w: 4, apply: (g) => g.addAmmoAll() },
  weapon: { label: '枪', color: '#a66be0', w: 2, apply: (g) => g.giveRandomWeapon() },
  pet:    { label: '宠', color: '#ff7eb6', w: 2, apply: (g) => g.givePet() },
};

// 宠物永久跟随，每种最多一只。玩家受到致命伤害时随机失去一只宠物并保住性命。
// w 为获得权重（幽灵稀有）。行为见 game.js 的 updatePets / hurtPlayer 与 weapons.js 的追踪逻辑。
const PETS = {
  dog:   { name: '狗',   w: 4, color: '#c08a4a', speed: 300, range: 280, dmg: 20, rate: 0.5, knock: 140 },
  cat:   { name: '猫',   w: 3, color: '#f0a040', interval: 8 },     // 每 8 秒充能一次，自动闪避一次伤害
  bird:  { name: '鸟',   w: 3, color: '#4fc3f7', turn: 7, rocketTurn: 2.5, range: 450 },  // 子弹/导弹自动追踪
  ghost: { name: '幽灵', w: 1, color: '#d8e8ff' },                  // 玩家与子弹/导弹穿墙
};

// 肉鸽强化：每关结束三选一。max 为最多叠加层数，avail 返回 false 时不进入候选池。
// apply(player, game)，player 上的属性见 game.js 的 newPlayer。
const UPGRADES = [
  { id: 'atk',     name: '攻击强化', color: '#ff7a5a', desc: '所有伤害 +20%', max: 8, apply: (p) => { p.dmgMul += 0.2; } },
  { id: 'hp',      name: '生命强化', color: '#e94b4b', desc: '最大生命 +30，并回复 30 点生命', max: 8,
    apply: (p) => { p.maxHp += 30; p.hp = Math.min(p.maxHp, p.hp + 30); } },
  { id: 'def',     name: '防御强化', color: '#8fa8c8', desc: '受到的伤害 -12%（最多 -60%）', max: 5, apply: (p) => { p.armor = Math.min(0.6, p.armor + 0.12); } },
  { id: 'rate',    name: '快速扳机', color: '#ffd166', desc: '所有武器射速 +15%', max: 5, apply: (p) => { p.rateMul *= 0.87; } },
  { id: 'speed',   name: '轻装上阵', color: '#3fb6e8', desc: '移动速度 +12%', max: 4, apply: (p) => { p.speedMul += 0.12; } },
  { id: 'sword',   name: '飞剑环绕', color: '#7fe8ff', desc: '一把飞剑环绕身体旋转，切割丧尸，还能挡下毒液和弹幕', max: 6, w: 1.3,
    apply: (p) => { p.swords++; } },
  { id: 'stamina', name: '体力恢复', color: '#9ad0ff', desc: '翻滚的体力恢复速度 +35%', max: 4, apply: (p) => { p.rollCdMul *= 0.74; } },
  { id: 'dodge',   name: '二段闪避', color: '#b0e0ff', desc: '翻滚次数 +1，翻滚途中可以接着再滚一次', max: 2,
    apply: (p) => { p.rollMax++; p.rollCharge++; } },
  { id: 'vamp',    name: '嗜血',     color: '#c03050', desc: '每击杀一只丧尸回复 2 点生命', max: 4, apply: (p) => { p.lifesteal += 2; } },
  { id: 'blast',   name: '爆破专精', color: '#ffa030', desc: '你造成的爆炸范围 +25%', max: 4, apply: (p) => { p.blastMul += 0.25; } },
  { id: 'pierce',  name: '穿甲弹',   color: '#e0e0e0', desc: '子弹额外穿透 1 个目标', max: 3, apply: (p) => { p.pierce++; } },
  { id: 'ammo',    name: '弹药扩容', color: '#d9b440', desc: '最大弹药 +50%，并立刻补满', max: 3,
    apply: (p, g) => { p.ammoMul += 0.5; g.refillAmmo(); } },
  { id: 'pet',     name: '新伙伴',   color: '#ff7eb6', desc: '随机获得一只还没有的宠物', max: 99,
    avail: (g) => Object.keys(PETS).some((k) => !g.pets[k]), apply: (p, g) => { g.givePet(); } },
];
