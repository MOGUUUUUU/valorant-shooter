// Headless acceptance check for valorant-awakening/index.html
//
// Rather than stubbing the game's internals, this harness boots the REAL page script inside a
// vm context with a DOM/canvas/rAF/timer emulation, then drives it exactly the way a browser
// would: run the boot animation to completion, click the loadout card, click 部署小队, dispatch
// keydown/keyup, let requestAnimationFrame run the real loop(), and answer the 3-choice draft.
//
// Usage: node _sim_check.js [combatSeconds]

const fs = require('fs');
const vm = require('vm');
const path = require('path');

const FILE = path.join(__dirname, 'index.html');
const HTML = fs.readFileSync(FILE, 'utf8');
const m = HTML.match(/<script>([\s\S]*?)<\/script>/);
if (!m) { console.error('FAIL: no <script> block'); process.exit(1); }
const SRC = m[1];

// ── canvas 2d context stub ──────────────────────────────────
function ctxStub() {
  const grad = { addColorStop() {} };
  return {
    fillStyle: '', strokeStyle: '', lineWidth: 1, globalAlpha: 1, font: '', textAlign: '',
    clearRect() {}, fillRect() {}, strokeRect() {},
    beginPath() {}, closePath() {}, arc() {}, ellipse() {},
    fill() {}, stroke() {}, moveTo() {}, lineTo() {},
    setLineDash() {}, fillText() {}, strokeText() {},
    save() {}, restore() {}, translate() {}, rotate() {}, scale() {},
    createLinearGradient() { return grad; },
    createRadialGradient() { return grad; },
    getImageData() { return { data: new Uint8Array(4) }; },
  };
}

// ── element stub with real listener dispatch ────────────────
let elSeq = 0;
function mkEl(id, tag) {
  const el = {
    id, tagName: (tag || 'div').toUpperCase(), textContent: '', className: '', value: '', disabled: false,
    style: { setProperty() {} },
    dataset: {}, children: [], parentNode: null, _html: '', _listeners: {}, _seq: ++elSeq,
    get innerHTML() { return el._html; },
    set innerHTML(v) { el._html = v; el.children.length = 0; },
    classList: {
      add(c) { el._classes.add(c); },
      remove(c) { el._classes.delete(c); },
      contains(c) { return el._classes.has(c); },
    },
    _classes: new Set(),
    addEventListener(type, fn) { (el._listeners[type] = el._listeners[type] || []).push(fn); },
    removeEventListener() {},
    appendChild(c) { el.children.push(c); c.parentNode = el; return c; },
    remove() { if (el.parentNode) { const i = el.parentNode.children.indexOf(el); if (i >= 0) el.parentNode.children.splice(i, 1); } },
    querySelector() { return mkEl('q'); },
    querySelectorAll() { return []; },
    getContext() { return ctxStub(); },
    getBoundingClientRect() { return { left: 0, top: 0, width: 480, height: 280 }; },
    closest() { return null; },
    click() { (el._listeners.click || []).slice().forEach((fn) => fn({ target: el, clientX: 0, clientY: 0, pointerId: 1 })); },
    fire(type, ev) { (el._listeners[type] || []).slice().forEach((fn) => fn(ev || { target: el })); },
  };
  return el;
}

const els = new Map();
const docListeners = {};
const documentStub = {
  getElementById(id) { if (!els.has(id)) els.set(id, mkEl(id)); return els.get(id); },
  createElement(tag) { return mkEl('new-' + tag, tag); },
  addEventListener(type, fn) { (docListeners[type] = docListeners[type] || []).push(fn); },
  removeEventListener() {},
  body: { appendChild() {} },
  querySelector() { return mkEl('q'); },
  querySelectorAll() { return []; },
};
const byId = (id) => documentStub.getElementById(id);
function keyDown(key) { (docListeners.keydown || []).slice().forEach((fn) => fn({ key, preventDefault() {} })); }
function keyUp(key) { (docListeners.keyup || []).slice().forEach((fn) => fn({ key })); }

// ── deterministic timers / intervals / rAF ──────────────────
let nowMs = 0, seq = 1;
const timers = new Map();
const intervals = new Map();
let rafCb = null, rafCount = 0;
const sandbox = {};
sandbox.setTimeout = (fn, ms) => { const id = seq++; timers.set(id, { fn, due: nowMs + (ms || 0) }); return id; };
sandbox.clearTimeout = (id) => { timers.delete(id); };
sandbox.setInterval = (fn, ms) => { const id = seq++; intervals.set(id, { fn, ms: ms || 16 }); return id; };
sandbox.clearInterval = (id) => { intervals.delete(id); };
sandbox.requestAnimationFrame = (fn) => { rafCb = fn; return ++rafCount; };
sandbox.cancelAnimationFrame = () => { rafCb = null; };
sandbox.performance = { now: () => nowMs };
sandbox.Date = { now: () => nowMs };
sandbox.Math = Math; sandbox.JSON = JSON; sandbox.console = console;
sandbox.Object = Object; sandbox.Array = Array; sandbox.Number = Number; sandbox.String = String;
sandbox.Boolean = Boolean; sandbox.Error = Error; sandbox.Set = Set; sandbox.Map = Map;
sandbox.Uint8Array = Uint8Array; sandbox.isNaN = isNaN; sandbox.parseInt = parseInt;
sandbox.document = documentStub;
sandbox.window = { innerWidth: 500, innerHeight: 900 };
sandbox.confirm = () => false;
sandbox.location = { reload() {} };
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
const run = (code) => vm.runInContext(code, sandbox);

function flushTimers() {
  for (let n = 0; n < 5000; n++) {
    let pick = null;
    for (const e of timers) if (e[1].due <= nowMs && (!pick || e[1].due < pick[1].due)) pick = e;
    if (!pick) return;
    timers.delete(pick[0]);
    pick[1].fn();
  }
  throw new Error('timer flush runaway');
}
function flushIntervals() {
  for (const e of intervals) {
    if (e[1]._due === undefined) e[1]._due = nowMs + e[1].ms;
    if (nowMs >= e[1]._due) { e[1]._due = nowMs + e[1].ms; e[1].fn(); }
  }
}

// results
const results = [];
function check(label, ok, detail) {
  results.push({ label, ok: !!ok });
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label + (detail !== undefined ? '   [' + detail + ']' : ''));
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// ════════════════ 0. static DOM contract ════════════════
console.log('=== 0. HTML / script DOM contract ===');
const htmlIds = new Set(Array.from(HTML.matchAll(/id="([^"]+)"/g)).map((x) => x[1]));
const wanted = Array.from(new Set(Array.from(SRC.matchAll(/getElementById\('([^']+)'\)/g)).map((x) => x[1])));
const missing = wanted.filter((id) => !htmlIds.has(id));
check('every getElementById target exists in the HTML', missing.length === 0, missing.join(', ') || wanted.length + ' ids checked');
const refd = Array.from(new Set(Array.from(HTML.matchAll(/id="([^"]+)"/g)).map((x) => x[1])));
console.log('      HTML ids=' + refd.length + '  script-referenced ids=' + wanted.length);

// 状态对象契约：G 上被读取的字段必须已在 G 字面量里声明（或至少被赋值过）。
// 这条检查专门防住「重写状态对象时漏掉某个字段」——曾漏掉 beaconInterval 导致补给只出一次。
const gLit = (SRC.match(/const G = \{([\s\S]*?)\n\};/) || [])[1] || '';
const gDeclared = new Set(Array.from(gLit.matchAll(/([A-Za-z_$][\w$]*)\s*:/g)).map((x) => x[1]));
const gUsed = new Set(Array.from(SRC.matchAll(/\bG\.([A-Za-z_$][\w$]*)/g)).map((x) => x[1]));
const gAssigned = new Set(Array.from(SRC.matchAll(/\bG\.([A-Za-z_$][\w$]*)\s*=[^=]/g)).map((x) => x[1]));
const gMissing = Array.from(gUsed).filter((p) => !gDeclared.has(p) && !gAssigned.has(p));
check('G 状态对象被读取的字段都已声明', gMissing.length === 0, gMissing.join(', ') || gUsed.size + ' fields, ' + gDeclared.size + ' declared');

// ════════════════ 1. load ════════════════
console.log('');
console.log('=== 1. script load ===');
try {
  vm.runInContext(SRC, sandbox, { filename: 'game.js' });
  check('page script evaluates without throwing', true);
} catch (e) {
  check('page script evaluates without throwing', false, e.message);
  process.exit(1);
}

// ════════════════ 2. real boot sequence ════════════════
console.log('');
console.log('=== 2. boot sequence (loading -> ready) ===');
for (let i = 0; i < 40; i++) { nowMs += 200; flushIntervals(); flushTimers(); }
check('loading overlay dismissed', byId('loading').classList.contains('gone'));
check('game container shown', byId('game').style.display === 'block', byId('game').style.display);
check('boot leaves the game in ready state', run('G.state') === 'ready', run('G.state'));
check('loadout modal opened automatically', byId('modal-weapon').classList.contains('show'));
check('loadout renders 3 weapon cards', byId('weapon-list').children.length === 3, 'cards=' + byId('weapon-list').children.length);
const cardHtml = byId('weapon-list').children.map((c) => c.innerHTML).join('');
check('cards are 狂徒 / 奥丁 / 判官', ['狂徒', '奥丁', '判官'].every((n) => cardHtml.indexOf(n) >= 0));
check('no weapon equipped before choosing', run('G.weapon') === null);
check('rAF loop registered', rafCb !== null);

// ════════════════ 3. spawn loadout choice ════════════════
console.log('');
console.log('=== 3. spawn loadout choice ===');
check('weapon pool = vandal / odin / judge', eq(run('Object.keys(WEAPONS)'), ['vandal', 'odin', 'judge']));
console.log('      ' + JSON.stringify(run('Object.keys(WEAPONS).map(function(k){var w=WEAPONS[k];return [w.name,w.dmg,w.fireInterval,w.projectiles,w.pierce];})')));
byId('btn-auto').click();               // deploy must be refused while unarmed
check('deploy refused without a weapon', run('G.state') === 'ready', run('G.state'));
byId('weapon-list').children[0].click(); // player clicks the first card (狂徒)
check('clicking the card equips a weapon', run('G.weapon && G.weapon.id') === 'vandal', run('G.weapon && G.weapon.name'));
check('loadout modal closed after pick', !byId('modal-weapon').classList.contains('show'));
keyDown('i'); check('I opens the armory', byId('modal-inv').classList.contains('show'));
keyDown('p'); check('P opens the specialisation panel', byId('modal-passive').classList.contains('show'));

// ════════════════ 4. deploy + real input ════════════════
console.log('');
console.log('=== 4. deploy + keyboard driving ===');
byId('btn-auto').click();
check('部署小队 click enters playing', run('G.state') === 'playing', run('G.state'));
check('opening squad of 6 deployed', run('G.minions.length') === 6, 'units=' + run('G.minions.length'));
const step = 1000 / 60;
function frames(n, each) {
  for (let i = 0; i < n; i++) {
    nowMs += step;
    if (rafCb) { const cb = rafCb; rafCb = null; cb(nowMs); }
    flushTimers(); flushIntervals();
    if (each) each(i);
  }
}
const x0 = run('G.playerX');
keyDown('d'); frames(45); keyUp('d');
const x1 = run('G.playerX');
check('keydown D moves the squad right', x1 > x0, x0.toFixed(1) + ' -> ' + x1.toFixed(1));
const x2 = run('G.playerX');
keyDown('a'); frames(45); keyUp('a');
check('keydown A moves the squad left', run('G.playerX') < x2, x2.toFixed(1) + ' -> ' + run('G.playerX').toFixed(1));
check('rAF loop is what advanced the game', run('G.elapsed') > 1, 'elapsed=' + run('G.elapsed').toFixed(1) + 's');

// ════════════════ 5. live 3-choice draft via the real loop ════════════════
console.log('');
console.log('=== 5. level-up draft through the running loop ===');
const COMBAT = Number(process.argv[2]) || 150;
// 记录每次空投补给实际结算的卡牌，用来说明补给链路真的在生效（而不是靠运气断言）
run('var __picks=[];var __origResolve=resolveSupplyGate;resolveSupplyGate=function(){if(G.gate)__picks.push(G.playerX<CW/2?G.gate.left.label:G.gate.right.label);return __origResolve();};');
let drafts = 0, coreOk = 0, firstDraft = null, maxWave = 0, sawGate = false, sawBoss = false;
let maxUnits = run('G.minions.length'), bad = 0;
frames(COMBAT * 60, () => {
  if (run('G.pendingUpgrades.length') > 0) {
    drafts++;
    const pending = run('G.pendingUpgrades.slice()');
    const core = pending.indexOf('dmg') >= 0 && pending.indexOf('speed') >= 0;
    if (core) coreOk++;
    if (!firstDraft) {
      firstDraft = {
        pending,
        cards: byId('drop-list').children.length,
        html: byId('drop-list').children.map((c) => c.innerHTML).join(''),
        kinds: Array.from(byId('drop-list').children).map((c) => c.className),
        nexts: byId('drop-list').children.map((c) => (c.innerHTML.match(/uc-next">([^<]*)</) || [])[1]),
        open: byId('modal-drop').classList.contains('show'),
        paused: run('G.paused'),
      };
    }
    const before = run('JSON.stringify(G.up)');
    keyDown(String(1 + Math.floor(Math.random() * 3)));   // player presses 1/2/3
    if (run('JSON.stringify(G.up)') === before) bad++;
    if (byId('modal-drop').classList.contains('show')) bad++;
  }
  if (run('G.gate!==null')) sawGate = true;
  if (run('G.bossActive')) sawBoss = true;
  maxWave = Math.max(maxWave, run('G.wave'));
  maxUnits = Math.max(maxUnits, run('G.minions.length'));
});
console.log('      first draft: cards=' + (firstDraft ? firstDraft.cards : 0) + ' pending=' + JSON.stringify(firstDraft && firstDraft.pending));
console.log('      card kinds: ' + JSON.stringify(firstDraft && firstDraft.kinds));
console.log('      card next values: ' + JSON.stringify(firstDraft && firstDraft.nexts));
check('draft modal opened by the loop', firstDraft && firstDraft.open === true);
check('draft paused combat for the choice', firstDraft && firstDraft.paused === true);
check('draft rendered exactly 3 cards', firstDraft && firstDraft.cards === 3, firstDraft && firstDraft.cards);
check('伤害提升 always in the draft', firstDraft && firstDraft.pending.indexOf('dmg') >= 0 && firstDraft.html.indexOf('伤害提升') >= 0);
check('攻速提升 always in the draft', firstDraft && firstDraft.pending.indexOf('speed') >= 0 && firstDraft.html.indexOf('攻速提升') >= 0);
check('每张牌显示 当前 → 下一级', firstDraft && firstDraft.nexts.every((t) => t && t.indexOf('→') >= 0), JSON.stringify(firstDraft && firstDraft.nexts));
check('数字键 1/2/3 每次都能选中并关闭弹窗', bad === 0 && drafts > 0, 'drafts=' + drafts + ' failures=' + bad);
check('每次升级都是含核心强化的三选一', coreOk === drafts, coreOk + '/' + drafts);

const snap = run('({state:G.state,kills:G.killCount,level:G.level,wave:G.wave,units:G.minions.length,losses:G.losses,defense:Math.round(G.defense),timer:Math.round(G.timer),boss:G.bossActive,areaIdx:G.areaIdx,playerX:Math.round(G.playerX),weapon:G.weapon.id,up:JSON.stringify(G.up)})');
console.log('');
console.log('── ' + COMBAT + 's 实战后的状态 ──');
for (const k of Object.keys(snap)) console.log('   ' + k.padEnd(10) + snap[k]);
check('squad kills enemies', snap.kills > 0, 'kills=' + snap.kills);
check('kill XP produces level-ups', snap.level > 1, 'level=' + snap.level);
check('waves advance', maxWave >= 3, 'maxWave=' + maxWave);
const picks = run('__picks.slice()');
const pickCounts = {};
picks.forEach((p) => { pickCounts[p] = (pickCounts[p] || 0) + 1; });
check('supply gate appears', sawGate);
check('每次空投都结算了一张补给卡', picks.length >= 3 && picks.every((p) => p && p.length > 0), picks.length + ' gates: ' + JSON.stringify(pickCounts));
check('补给卡包含增援或全队加成', Object.keys(pickCounts).every((k) => /新兵|步枪手|狙击手|重装兵|火力|射速/.test(k)));
check('mission reaches the boss phase', sawBoss || snap.areaIdx > 0, 'boss=' + sawBoss + ' areaIdx=' + snap.areaIdx);
check('player stays inside the field', snap.playerX >= 48 && snap.playerX <= 432, 'x=' + snap.playerX);
check('game never hard-stops', snap.state === 'playing', snap.state);
check('weapon stays valid', ['vandal', 'odin', 'judge'].indexOf(snap.weapon) >= 0, snap.weapon);
check('HUD upgrade chips reflect taken upgrades', byId('up-chips').innerHTML.indexOf('up-chip') >= 0);

// ════════════════ 6. draft pool statistics ════════════════
console.log('');
console.log('=== 6. draft pool statistics ===');
const ROLLS = 20000;
const stat = run('(function(){var bad=0,noDmg=0,noSpd=0,dup=0,special=0,slots=[{}, {}, {}];for(var i=0;i<' + ROLLS + ';i++){var p=rollUpgradeChoices();if(p.length!==3)bad++;if(p.indexOf("dmg")<0)noDmg++;if(p.indexOf("speed")<0)noSpd++;if(p[0]===p[1]||p[1]===p[2]||p[0]===p[2])dup++;for(var j=0;j<3;j++){slots[j][p[j]]=(slots[j][p[j]]||0)+1;if(UPGRADES[p[j]].kind==="special")special++;}}return {bad:bad,noDmg:noDmg,noSpd:noSpd,dup:dup,rate:special/(' + ROLLS + '*3),slots:slots.map(function(o){var s=0;for(var k in o)if(UPGRADES[k].kind==="special")s+=o[k];return s/' + ROLLS + ';})};})()');
console.log('      special-rate per slot: ' + JSON.stringify(stat.slots.map((v) => (v * 100).toFixed(1) + '%')));
check(ROLLS + ' 次抽取都是 3 张不同的牌', stat.bad === 0 && stat.dup === 0, 'bad=' + stat.bad + ' dup=' + stat.dup);
check('伤害提升 100% 出现', stat.noDmg === 0);
check('攻速提升 100% 出现', stat.noSpd === 0);
check('特殊强化为低概率（1%~15%）', stat.rate > 0.01 && stat.rate < 0.15, (stat.rate * 100).toFixed(2) + '% of all cards');
check('常规强化池 = 多重射击 / 穿透 / 连锁', eq(run('THIRD_POOL.filter(function(id){return UPGRADES[id].kind==="normal";})'), ['multishot', 'pierce', 'chain']));
check('特殊强化池存在且权重更低', run('THIRD_POOL.filter(function(id){return UPGRADES[id].kind==="special";}).length') >= 5);

// ════════════════ 7. upgrade math ════════════════
console.log('');
console.log('=== 7. upgrade numeric effects ===');
run('G.up={dmg:0,speed:0,multishot:0,pierce:0,chain:0,headshot:0,incendiary:0,shock:0,stim:0,ultcharge:0,fortify:0};G.passives={};G.itemDps=0;G.itemSpeed=0;G.itemCrit=0;G.veteranBonus=0;G.buffs={};G.weapon=WEAPONS.vandal;');
const d0 = run('shotDamage()'), i0 = run('fireInterval()'), p0 = run('shotProjectiles()');
for (let i = 0; i < 5; i++) run('applyUpgrade("dmg")');
check('伤害提升 Lv.5 = 伤害 x2.0（每级 +20%）', Math.abs(run('shotDamage()') / d0 - 2) < 1e-9, 'x' + (run('shotDamage()') / d0).toFixed(3));
for (let i = 0; i < 5; i++) run('applyUpgrade("speed")');
check('攻速提升 Lv.5 = 射速 x2.0（每级 +20%）', Math.abs(i0 / run('fireInterval()') - 2) < 1e-9, 'x' + (i0 / run('fireInterval()')).toFixed(3));
for (let i = 0; i < 3; i++) run('applyUpgrade("multishot")');
check('多重射击 +1 投射物/级', run('shotProjectiles()') === p0 + 3, p0 + ' -> ' + run('shotProjectiles()'));
for (let i = 0; i < 2; i++) run('applyUpgrade("pierce")');
for (let i = 0; i < 2; i++) run('applyUpgrade("chain")');
check('子弹穿透 +1/级', run('shotPierce()') === 2, 'pierce=' + run('shotPierce()'));
check('子弹连锁 +1/级', run('shotChain()') === 2, 'chain=' + run('shotChain()'));
run('G.up.multishot=0;G.up.pierce=0;G.up.chain=0;G.up.dmg=0;G.up.speed=0;');
const volley = run('(function(){G.projectiles=[];G.atkTimer=0;G.monsters=[{x:240,y:180,hp:1e6,maxHp:1e6,speed:0,dmg:0,color:"#fff",size:8,exp:0,frozen:0,burn:0}];G.up.multishot=4;doSkillAttack();return G.projectiles.length;})()');
check('多重射击真的打出额外弹丸', volley === 5, 'volley=' + volley + ' 发');
const judgeSpread = run('(function(){G.weapon=WEAPONS.judge;G.monsters=[{x:240,y:180,hp:1e6,maxHp:1e6,speed:0,dmg:0,color:"#fff",size:8,exp:0,frozen:0,burn:0}];G.projectiles=[];G.up.multishot=0;doSkillAttack();var a=G.projectiles.map(function(p){return Math.atan2(p.vy,p.vx);});G.weapon=WEAPONS.vandal;return {n:a.length,distinct:new Set(a.map(function(x){return x.toFixed(3);})).size};})()');
check('判官一次打出 5 发扩散弹丸', judgeSpread.n === 5 && judgeSpread.distinct >= 3, JSON.stringify(judgeSpread));

// ════════════════ 8. bullet pierce / chain ════════════════
console.log('');
console.log('=== 8. bullet pierce / chain behaviour ===');
function setup(extra) {
  run('G.monsters=[];G.projectiles=[];G.efts=[];G.minions=[];G.state="playing";G.paused=false;G.timer=90;G.waveTimer=999;G.beaconTimer=999;G.spawnQueue=[];G.playerX=240;G.targetX=240;G.up.multishot=0;G.up.pierce=0;G.up.chain=0;G.up.headshot=0;G.up.incendiary=0;G.up.shock=0;G.weapon=WEAPONS.vandal;' + extra);
}
function fly(n) { run('for(var i=0;i<' + n + ';i++){G.atkTimer=999;battleUpdate(1/60);}'); }
const enemyAt = 'function(y){return {x:240,y:y,hp:1e6,maxHp:1e6,speed:0,dmg:0,color:"#fff",size:8,exp:0,frozen:0,burn:0};}';
setup('G.monsters.push({x:240,y:180,hp:1e6,maxHp:1e6,speed:0,dmg:0,color:"#fff",size:8,exp:0,frozen:0,burn:0},{x:240,y:164,hp:1e6,maxHp:1e6,speed:0,dmg:0,color:"#fff",size:8,exp:0,frozen:0,burn:0},{x:240,y:148,hp:1e6,maxHp:1e6,speed:0,dmg:0,color:"#fff",size:8,exp:0,frozen:0,burn:0});');
run('doSkillAttack();'); fly(120);
check('无穿透：命中 1 个即消散', run('G.monsters.filter(function(m){return m.hp<1e6;}).length') === 1);
setup('G.monsters.push({x:240,y:180,hp:1e6,maxHp:1e6,speed:0,dmg:0,color:"#fff",size:8,exp:0,frozen:0,burn:0},{x:240,y:164,hp:1e6,maxHp:1e6,speed:0,dmg:0,color:"#fff",size:8,exp:0,frozen:0,burn:0},{x:240,y:148,hp:1e6,maxHp:1e6,speed:0,dmg:0,color:"#fff",size:8,exp:0,frozen:0,burn:0});');
run('G.up.pierce=3;doSkillAttack();'); fly(120);
check('穿透 3：一颗子弹贯穿 3 个敌人', run('G.monsters.filter(function(m){return m.hp<1e6;}).length') === 3);
setup('G.monsters.push({x:240,y:180,hp:1e6,maxHp:1e6,speed:0,dmg:0,color:"#fff",size:8,exp:0,frozen:0,burn:0},{x:285,y:180,hp:1e6,maxHp:1e6,speed:0,dmg:0,color:"#fff",size:8,exp:0,frozen:0,burn:0});');
run('G.up.chain=1;doSkillAttack();'); fly(180);
check('连锁 1：命中后弹射到旁边敌人', run('G.monsters.filter(function(m){return m.hp<1e6;}).length') === 2);

// ════════════════ 9. special upgrades ════════════════
console.log('');
console.log('=== 9. special upgrades ===');
setup('');
run('G.up.headshot=1;G.passives={};G.itemCrit=0;');
check('爆头专精：暴击率 12%/级', Math.abs(run('critChance()') - 0.12) < 1e-9, (run('critChance()') * 100).toFixed(0) + '%');
run('G.monsters=[{x:240,y:180,hp:1e6,maxHp:1e6,speed:0,dmg:0,color:"#fff",size:8,exp:0,frozen:0,burn:0}];G.up.incendiary=1;G.projectiles=[];doSkillAttack();');
fly(60);
const burnLeft = run('G.monsters.length?G.monsters[0].burn:-1');
check('燃烧弹：命中后敌人进入灼烧', burnLeft > 0, '剩余灼烧 ' + burnLeft.toFixed(2) + 's');
const burnHp = run('G.monsters.length?G.monsters[0].hp:-1');
check('燃烧弹会持续掉血', burnHp < 1e6, 'hp=' + Math.round(burnHp));
run('G.monsters=[];G.projectiles=[];G.up.shock=1;');
check('震荡弹：基础震荡几率 25%（每级 +5%）', Math.abs(run('shockChance()') - 0.25) < 1e-9, (run('shockChance()') * 100).toFixed(0) + '%');
const def0 = run('G.defenseMax');
run('applyUpgrade("fortify")');
check('据点加固：防线上限 +8% 并回满', run('G.defenseMax') === Math.round(def0 * 1.08) && run('G.defense') === run('G.defenseMax'), def0 + ' -> ' + run('G.defenseMax'));
const cd0 = run('(function(){G.up.ultcharge=0;return TACTICAL.r.cd*cdMult();})()');
run('G.up.ultcharge=1');
check('大招充能：战术技能冷却 -15%/级', Math.abs(run('TACTICAL.r.cd*cdMult()') / cd0 - 0.85) < 1e-9, cd0.toFixed(2) + 's -> ' + run('TACTICAL.r.cd*cdMult()').toFixed(2) + 's');
const mv0 = run('(function(){G.up.stim=0;G.buffs={};return moveMult();})()');
run('G.up.stim=2');
check('兴奋剂：移速 +8%/级', Math.abs(run('moveMult()') / mv0 - 1.16) < 1e-9, 'x' + (run('moveMult()') / mv0).toFixed(2));
check('兴奋剂：生命回复提升', run('(function(){G.up.stim=2;G.hp=10;battleUpdate(1);return G.hp;})()') > 10);

// ════════════════ 9b. boss leak regression ════════════════
console.log('');
console.log('=== 9b. boss leak does not stall the run ===');
setup('G.monsters=[];G.spawnQueue=[];G.timer=0;G.victory=false;G.bossActive=false;G.boss=null;G.defense=800;G.defenseMax=800;');
run('spawnBoss();G.boss.y=LINE_Y+2;battleUpdate(1/60);');   // 首领越线
check('首领越线后不会永久锁死 bossActive', run('G.bossActive') === false, 'bossActive=' + run('G.bossActive') + ' boss=' + run('G.boss'));
run('battleUpdate(1/60);');
check('下一帧会重新刷新首领（任务可继续推进）', run('G.bossActive') === true && run('G.boss&&G.boss.y<LINE_Y'), 'bossActive=' + run('G.bossActive'));
run('G.monsters=[];G.bossActive=false;G.boss=null;G.timer=90;G.waveTimer=999;');

// ════════════════ 10. tactical abilities ════════════════
console.log('');
console.log('=== 10. tactical abilities (QWER) ===');
run('G.up.ultcharge=0;G.defenseMax=800;G.defense=800;G.tacCD={q:0,w:0,e:0,r:0};G.mana=50;G.buffs={};');
byId('skill-bar').fire('click', { target: { closest: () => ({ dataset: { skill: 'q' } }) } });
check('战术技能可点击释放（Q）', run('G.tacCD.q') > 0 && run('G.mana') < 50, 'cd=' + run('G.tacCD.q').toFixed(1) + ' mana=' + run('G.mana'));

// ════════════════ 11. supply cards apply for real ════════════════
console.log('');
console.log('=== 11. supply cards (deterministic) ===');
const cards = run('SUPPLY_CARDS.map(function(c){return c.label;})');
console.log('      cards: ' + JSON.stringify(cards));
const units0 = run('G.minions.length');
run('SUPPLY_CARDS[0].apply()');
check('+4 新兵 真的部署 4 名队员', run('G.minions.length') === units0 + 4, units0 + ' -> ' + run('G.minions.length'));
const units1 = run('G.minions.length');
run('SUPPLY_CARDS[1].apply(); SUPPLY_CARDS[2].apply(); SUPPLY_CARDS[3].apply();');
check('其余增援卡也生效', run('G.minions.length') === units1 + 6, units1 + ' -> ' + run('G.minions.length'));
const dps0 = run('G.itemDps');
run('SUPPLY_CARDS[4].apply()');
check('全队火力 +12% 生效', run('G.itemDps') === dps0 + 12, dps0 + ' -> ' + run('G.itemDps'));
const spd0 = run('G.itemSpeed');
run('SUPPLY_CARDS[5].apply()');
check('全队射速 +10% 生效', run('G.itemSpeed') === spd0 + 10, spd0 + ' -> ' + run('G.itemSpeed'));

console.log('');
const failed = results.filter((r) => !r.ok);
console.log('=== ' + (results.length - failed.length) + '/' + results.length + ' checks passed ===');
if (failed.length) { console.log('FAILED: ' + failed.map((f) => f.label).join(' ; ')); process.exit(1); }
console.log('ALL CHECKS PASSED');
process.exit(0);
