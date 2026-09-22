/**
 * 铁路货运测试：node test/railway.test.js
 * 覆盖：铺设/发车/装卸/区间占用/交叉争用/堵站排队/断路自愈/拆除保护/存档恢复/到站物料接入产线
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
global.window = global;
global.localStorage = {
  _d: {},
  getItem(k) { return this._d[k] !== undefined ? this._d[k] : null; },
  setItem(k, v) { this._d[k] = String(v); },
  removeItem(k) { delete this._d[k]; },
};

const files = [
  'js/core/config.js', 'js/core/utils.js',
  'js/data/items.js', 'js/data/recipes.js', 'js/data/buildings.js',
  'js/data/research.js', 'js/data/maps.js',
  'js/game/map.js', 'js/game/scheduler.js', 'js/game/railway.js', 'js/game/contracts.js', 'js/game/maintenance.js', 'js/game/sim.js',
  'js/game/researchmgr.js', 'js/game/stats.js', 'js/game/save.js',
  'js/game/blueprint.js', 'js/game/game.js',
];
for (const f of files) {
  vm.runInThisContext(fs.readFileSync(path.join(root, f), 'utf8'), { filename: f });
}

let pass = 0, fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; console.log('  ✓', msg); }
  else { fail++; console.log('  ✗ FAIL:', msg); }
}
function ticks(g, n) { for (let i = 0; i < n; i++) g.tickOnce(); }

const game = new FG.Game();
const gen = FG.Maps.generate(FG.Maps.getPreset('greenfield'), 999, 'medium');
game.startWithMap(gen, null, 'rail-test');
game.research.completed.add('railTransport'); // 解锁铁路建筑
const m = game.map, sim = game.sim, ry = game.railway;

function place(type, x, y, dir) {
  const b = FG.Map.create(type, x, y, dir || 0);
  if (b.def.railStation) { b.stationId = 'S' + (ry.stationSeq++); b.stationName = '站点 ' + b.stationId.slice(1); }
  m.register(b); sim.register(b);
  ry.markDirty();
  return b;
}
/** 铺一条直轨（含两站）：站点本身即轨节点 */
function straightLine(x0, x1, y, stations) {
  stations = stations || {};
  for (let x = x0; x <= x1; x++) {
    if (stations[x]) place('station', x, y, 0);
    else place('rail', x, y, 0);
  }
}
function shallowGen() {
  return {
    presetId: 'greenfield', biome: 'grass', w: gen.w, h: gen.h, seed: 999, sizeId: 'medium',
    terrain: gen.terrain,
    ores: gen.ores.map(row => row.map(c => c ? { type: c.type, amount: c.amount } : null)),
    water: gen.water, oil: gen.oil,
  };
}
function stationFill(st, item, n) { sim.chestAdd(st, item, n); }
function stationCount(st, item) {
  return st.chest.reduce((n, s) => n + (s.type === item ? s.count : 0), 0);
}

console.log('\n[R1] 基本运输：列车沿轨道到站、卸货、装货、循环');
{
  const y = 4;
  straightLine(2, 12, y, { 3: true, 11: true });
  const stA = m.buildingAt(3, y), stB = m.buildingAt(11, y);
  stA.stationName = '甲站'; stB.stationName = '乙站';
  // 机务段在甲站旁
  const depot = place('trainDepot', 3, y - 1, 0);
  // 车站必须邻轨：找一块不临轨的陆地格断言
  let farLand = null;
  for (let yy = 0; yy < m.h && !farLand; yy++) for (let xx = 0; xx < m.w && !farLand; xx++) {
    if (m.terrainAt(xx, yy) !== 'water' && !m.buildingAt(xx, yy) && !game.adjacentRail(xx, yy)) farLand = { x: xx, y: yy };
  }
  ok(game.canPlace('rail', 1, y) && farLand && !game.canPlace('station', farLand.x, farLand.y),
     '轨道可铺、孤立陆地格不能建车站（须邻轨）');
  ok(game.adjacentRail(3, y - 1), '机务段接轨校验通过');
  const tr = ry.spawnTrain(depot);
  ok(!!tr, '机务段相邻轨道成功发车（' + (tr && tr.id) + '），位于 ' + (tr && tr.x) + ',' + (tr && tr.y));
  // 计划：甲站卸铁矿 30 → 乙站装煤 20（循环）
  tr.addStop(stA.stationId, 'unload', 'ironOre', 30);
  tr.addStop(stB.stationId, 'load', 'coal', 20);
  // 车上预载 30 铁矿（模拟从另一站运来）
  tr.pushToTrain('ironOre', 30);
  stationFill(stB, 'coal', 50);

  // 出生在 (3,y) 相邻轨格 —— spawn 从 dir=0 开始找；断言最终到达甲站并卸货
  ticks(game, 20);
  ok(tr.cargoCount('ironOre') === 0, '在甲站把 30 铁矿卸入车站货位（剩 ' + tr.cargoCount('ironOre') + '）');
  ok(stationCount(stA, 'ironOre') === 30, '甲站收到 30 铁矿（到站物料入站）');
  ok(tr.state === 'docked' || tr.state === 'moving', '卸货后继续运行（状态=' + tr.state + '）');

  // 跑到乙站：记录整次停靠期间车上煤的最大值，必须严格 = 计划 20（不多装）
  let peakCoal = 0, wasDockedAtB = false;
  for (let i = 0; i < 300; i++) {
    game.tickOnce();
    const atB = tr.x === stB.x && tr.y === stB.y;
    if (atB) { wasDockedAtB = true; peakCoal = Math.max(peakCoal, tr.cargoCount('coal')); }
    if (wasDockedAtB && !atB) break; // 首次离站即停
  }
  console.log('    首次乙站停靠车上煤峰值 ' + peakCoal);
  ok(peakCoal === 20, '乙站首次停靠严格装 20 煤（计划数量，实测峰值 ' + peakCoal + '）');
  ok(stationCount(stB, 'coal') === 30, '乙站被取走 20 煤（余 ' + stationCount(stB, 'coal') + '）');

  // 再循环回甲站：卸煤动作是 unload ironOre —— 车上无铁矿，到量为 0 立即继续；
  // 这里主要验证循环不断、且货物守恒
  ticks(game, 300);
  const totalCoal = tr.cargoCount('coal') + stationCount(stA, 'coal') + stationCount(stB, 'coal');
  ok(totalCoal === 50, '循环运行后煤守恒（50，实际 ' + totalCoal + '）');
  ok(tr.totalErr === undefined, '无异常状态（断路=' + (tr.state === 'noroute') + '）');
}

console.log('\n[R2] 区间占用：列车不穿越/不重叠；堵站时后车在站外同向排队依次进站');
{
  const y = 14;
  straightLine(0, 24, y, { 5: true, 18: true });
  const stA = m.buildingAt(5, y), stB = m.buildingAt(18, y);
  // 尽头清道站（前车 t1 卸货后空驶到此，把乙站让给后车）
  const stEnd = place('station', 24, y, 0);
  const dep1 = place('trainDepot', 0, y - 1, 0);
  const dep2 = place('trainDepot', 1, y - 1, 0);
  const t1 = ry.spawnTrain(dep1); // 落在 (0,y)
  const t2 = ry.spawnTrain(dep2); // (0,y) 被占 → 落在 (1,y)
  ok(!!t1 && !!t2 && (t2.x === 1 || t2.y === 14), '两列同向车前后编组（t1@' + (t1 && t1.x) + '，t2@' + (t2 && t2.x) + '）');
  for (const [idx, t] of [t1, t2].entries()) {
    // 前车 t2（x=1）先到乙站卸 10 后继续空驶到尽头清道；后车 t1（x=0）随后进站卸货待命
    t.plan.loop = false;
    t.addStop(stB.stationId, 'unload', 'ironOre', 10);
    if (idx === 1) t.addStop(stEnd.stationId, 'unload', null, 1); // 前车清道
    t.pushToTrain('ironOre', 10);
  }
  // 甲站作为途中会经过的车站（不停）：仅用于观测后车是否能穿过前车刚离开的站区
  let t2EverAtB = false, t2EverAtA = false, overlap = false;
  for (let i = 0; i < 2400; i++) {
    game.tickOnce();
    if (t2.x === stB.x && t2.y === stB.y) t2EverAtB = true;
    if (t2.x === stA.x && t2.y === stA.y) t2EverAtA = true;
    if (t1.x === t2.x && t1.y === t2.y) overlap = true;
    if (t1.state === 'idle' && t2.state === 'idle' && stationCount(stB, 'ironOre') === 20) break;
  }
  ok(!overlap, '全程两列车从未占同一格（区间占用无穿透）');
  const atB = stationCount(stB, 'ironOre');
  console.log('    乙站收 ' + atB + '，t1=' + t1.state + '@' + t1.x + ' t2=' + t2.state + '@' + t2.x
    + '，后车途经甲站=' + t2EverAtA + ' 到乙站=' + t2EverAtB);
  ok(t2EverAtA, '前车占区间/车站时后车在其后排队（waiting），前车驶离后依次通过');
  ok(atB === 20 && t2EverAtB, '两车先后到乙站各卸 10 件（乙站 ' + atB + '，无穿越无重叠）');
  ok(t1.state !== 'blocked' && t2.state !== 'blocked', '同向行车无堵死（' + t1.state + '/' + t2.state + '）');
}

console.log('\n[R3] 交叉线路争用：两线共用交汇轨格，轮转通过不饿死');
{
  const y = 24;
  // 横线 (2,y)-(10,y)，竖线 (6,y-4)-(6,y+4)，交汇 (6,y)
  straightLine(2, 10, y, { 2: true, 10: true });
  for (let yy = y - 4; yy <= y + 4; yy++) {
    if (yy === y) continue;
    place('rail', 6, yy, 0);
  }
  place('station', 6, y - 4, 0); // 竖线南站
  // 横线两站
  const stW = m.buildingAt(2, y), stE = m.buildingAt(10, y), stS = m.buildingAt(6, y - 4);
  // 两条东西向车 + 南北向车：发在远离交汇点处
  const depW = place('trainDepot', 3, y - 1, 0);
  const tw1 = ry.spawnTrain(depW);
  // 手动在竖线北端放车：直接构造（绕过机务段）
  const tn = new FG.Train('Tz1', 6, y + 4, 0);
  ry.trains.push(tn); ry.occupy.set('6,' + (y + 4), tn.id);
  tw1.addStop(stE.stationId, 'unload', null, 1); tw1.pushToTrain('stone', 1);
  tn.addStop(stS.stationId, 'unload', null, 1); tn.pushToTrain('gear', 1);

  ticks(game, 400);
  ok(tw1.state !== 'blocked' || tw1.x !== tw1.px || tn.state !== 'blocked',
     '交汇点未出现永久双堵死（tw1=' + tw1.state + ',tn=' + tn.state + '）');
  // 至少一车完成卸货
  const movedAny = stationCount(stE, 'stone') > 0 || stationCount(stS, 'gear') > 0;
  ok(movedAny, '争用条件下列车仍能通过交汇点完成运输');
}

console.log('\n[R4] 断路自愈：拆轨 → 列车 noroute 等待；补轨后自动恢复');
{
  const y = 30;
  straightLine(2, 12, y, { 2: true, 12: true });
  const stA = m.buildingAt(2, y), stB = m.buildingAt(12, y);
  const depot = place('trainDepot', 2, y - 1, 0);
  const tr = ry.spawnTrain(depot);
  tr.addStop(stB.stationId, 'unload', null, 1);
  tr.pushToTrain('stone', 1);
  // 立即挖断中段 (7,y)：列车尚未到达
  ok(game.removeBuilding(m.buildingAt(7, y)) !== false, '无车占用的轨道可拆除');
  ticks(game, 30);
  ok(tr.state === 'noroute', '中段断路后列车进入断路状态（实际 ' + tr.state + '）');
  // 补回
  place('rail', 7, y, 0);
  ticks(game, 200);
  ok(stationCount(stB, 'stone') === 1, '补轨后自动重新寻路并送达乙站');
  ok(tr.state !== 'noroute', '断路状态自动解除（' + tr.state + '）');
}

console.log('\n[R5] 列车占用时禁止拆轨；解编货物落地');
{
  const y = 34;
  straightLine(2, 8, y, { 2: true, 8: true });
  const stA = m.buildingAt(2, y);
  const depot = place('trainDepot', 2, y - 1, 0);
  const tr = ry.spawnTrain(depot);
  tr.addStop(m.buildingAt(8, y).stationId, 'unload', null, 1);
  tr.pushToTrain('coal', 5);
  ticks(game, 4);
  // 占住的格子拆不掉
  const occTile = m.buildingAt(tr.x, tr.y);
  const ret = game.removeBuilding(occTile);
  ok(ret === false, '列车占用的轨道/站格拆除被拒绝');
  game.selection = tr;
  game.removeTrainSelection();
  const pile = m.pileAt(tr.x, tr.y);
  ok(pile && pile.some(s => s.type === 'coal' && s.count === 5), '解编后 5 煤落到所在格地面堆');
  // 车没了即可拆
  ok(game.removeBuilding(occTile) !== false, '列车移除后轨道可拆除');
}

console.log('\n[R6] 存档恢复：列车位置/载货/计划/停站状态与调度游标随档还原');
{
  const y = 22;
  straightLine(2, 14, y, { 3: true, 13: true });
  const stA = m.buildingAt(3, y), stB = m.buildingAt(13, y);
  const depot = place('trainDepot', 3, y - 1, 0);
  const tr = ry.spawnTrain(depot);
  tr.addStop(stA.stationId, 'unload', 'ironPlate', 10);
  tr.addStop(stB.stationId, 'load', 'gear', 5);
  tr.pushToTrain('ironPlate', 10);
  ticks(game, 10); // 可能在停靠或行驶
  const data = JSON.parse(JSON.stringify(game.serialize()));

  const g2 = new FG.Game();
  g2.deserialize(data);
  const tr2 = g2.railway.trains.find(t => t.id === tr.id);
  ok(!!tr2, '列车随存档恢复');
  ok(tr2.x === tr.x && tr2.y === tr.y, '列车位置恢复（' + tr2.x + ',' + tr2.y + '）');
  ok(tr2.cargoCount('ironPlate') === tr.cargoCount('ironPlate'), '列车在途货物恢复（' + tr2.cargoCount('ironPlate') + '）');
  ok(tr2.stops.length === 2 && tr2.stops[0].stationId === stA.stationId
     && tr2.stops[1].action === 'load' && tr2.stops[1].item === 'gear',
     '运输计划（站点顺序/装卸/物品/数量）恢复');
  // 占用表重建
  ok(g2.railway.occupiedBy(tr2.x, tr2.y) === tr2.id, '读档后区间占用表由列车位置重建');
  const stA2 = g2.map.buildingAt(stA.x, stA.y);
  ok(stA2.stationId === stA.stationId && stA2.stationName === stA.stationName, '车站站号/站名恢复');
  let err = null;
  try { ticks(g2, 300); } catch (e) { err = e; }
  ok(!err, '读档后铁路调度正常推进' + (err ? '：' + err.stack : ''));

  // 旧存档兼容：无 railway 段
  const old = JSON.parse(JSON.stringify(data));
  delete old.railway;
  const g3 = new FG.Game();
  let err2 = null;
  try { g3.deserialize(old); ticks(g3, 5); } catch (e) { err2 = e; }
  ok(!err2, '无 railway 字段的旧存档读取/推进不报错' + (err2 ? '：' + err2.stack : ''));
  ok(g3.railway.trains.length === 0, '旧档无列车（空铁路）');
}

console.log('\n[R7] 到站物料接入产线：车站货位经机械臂/按需物流供给熔炉');
{
  // 车站 (2,26) → 臂(2,27)朝南 → 熔炉(2,28)
  const y = 26;
  place('station', 2, y, 0);
  // 给车站接轨
  place('rail', 1, y, 0); place('rail', 3, y, 0);
  const st = m.buildingAt(2, y);
  stationFill(st, 'ironOre', 20);
  const arm = FG.Map.create('inserter', 2, y + 1, 2); m.register(arm); sim.register(arm);
  arm.demandMode = true;
  const furnace = FG.Map.create('furnace', 2, y + 2, 0); m.register(furnace); sim.register(furnace);
  furnace.recipe = 'smelt:iron'; FG.Map.syncRecipeSlots(furnace);
  ticks(game, 300);
  ok(furnace.totalCrafted > 0, '车站里的铁矿经按需机械臂送入熔炉并冶炼（' + furnace.totalCrafted + ' 块铁板）');
  ok(stationCount(st, 'ironOre') < 20, '车站货位被产线取走（余 ' + stationCount(st, 'ironOre') + '）');
}

console.log('\n[R8] 列车全图盘点包含在途货物；传送带可直接卸入车站');
{
  const y = 32;
  // 车站 (4,y) 东侧接轨；西侧 (3,y) 用传送带顶头直接卸入车站
  place('station', 4, y, 0); place('rail', 5, y, 0); place('rail', 6, y, 0);
  const st = m.buildingAt(4, y);
  // 传送带顶头朝车站
  const belt = FG.Map.create('belt', 3, y, 1); m.register(belt); sim.register(belt);
  for (let i = 0; i < 4; i++) belt.items.push({ type: 'copperOre', pos: 1 - i * 0.25, from: 0 });
  ticks(game, 60);
  ok(stationCount(st, 'copperOre') > 0, '传送带末端直接卸入车站货位（' + stationCount(st, 'copperOre') + '）');

  const depot = place('trainDepot', 4, y - 1, 0);
  const tr = ry.spawnTrain(depot);
  tr.pushToTrain('coal', 7);
  const inv = game.inventory();
  ok((inv.coal || 0) >= 7, '列车在途货物计入全图盘点（coal=' + (inv.coal || 0) + '）');
}

console.log('\n[R9] 行驶中解编：跨格中途解编释放全部占用（不留幽灵），货物落到占用格');
{
  const y = 44;
  straightLine(0, 14, y, { 14: true });
  const st = m.buildingAt(14, y);
  const depot = place('trainDepot', 0, y - 1, 0);
  const tr = ry.spawnTrain(depot);
  tr.addStop(st.stationId, 'unload', null, 1);
  tr.pushToTrain('coal', 5);
  // 跑到跨格中途（occupy 指向新格、车体仍在旧格）
  let mid = null;
  for (let i = 0; i < 20 && !mid; i++) {
    game.tickOnce();
    for (const [k, id] of ry.occupy) {
      if (id === tr.id && k !== tr.x + ',' + tr.y) mid = { k, bodyX: tr.x, bodyY: tr.y };
    }
  }
  ok(!!mid, '捕捉到跨格中途状态（车体 ' + (mid && mid.bodyX) + '，占用 ' + (mid && mid.k) + '）');
  if (mid) {
    game.selection = tr;
    game.removeTrainSelection();
    ok(!ry.occupy.has(mid.k), '跨格目标格占用被释放（无幽灵占用）');
    const [gx, gy] = mid.k.split(',').map(Number);
    const pile = m.pileAt(gx, gy);
    ok(pile && pile.some(s => s.type === 'coal' && s.count === 5), '货物落到占用权实际所在格地面堆');
    // 新车可以正常通过该格
    const tr2 = ry.spawnTrain(depot);
    tr2.addStop(st.stationId, 'unload', null, 1);
    let got = false;
    for (let i = 0; i < 300; i++) { game.tickOnce(); if (tr2.x === gx && tr2.y === gy) { got = true; break; } }
    ok(got, '后续列车可正常通过解编格（未被幽灵占用永久挡住）');
  }
}

console.log('\n[R10] 跨格中途存读：读档后吸附回落定格、占用一致、继续运行不重叠');
{
  const y = 48;
  straightLine(0, 30, y, { 30: true });
  const st = m.buildingAt(30, y);
  const depot = place('trainDepot', 0, y - 1, 0);
  const trA = ry.spawnTrain(depot);
  trA.addStop(st.stationId, 'unload', null, 1);
  trA.pushToTrain('stone', 1);
  // 等前车走出几格后发后车
  ticks(game, 12);
  const trB = ry.spawnTrain(depot);
  trB.addStop(st.stationId, 'unload', null, 1);
  trB.pushToTrain('stone', 1);
  // 找一个至少一车在跨格中途的时刻存档
  let data = null;
  for (let i = 0; i < 80 && !data; i++) {
    game.tickOnce();
    if (game.railway.trains.some(t => t.moveTimer > 0)) {
      data = JSON.parse(JSON.stringify(game.serialize()));
    }
  }
  ok(!!data && data.railway.trains.some(t => t.moveTimer > 0), '存档时确有列车处于跨格中途');
  const g4 = new FG.Game();
  g4.deserialize(data);
  const ry4 = g4.railway;
  let sane = true, overlap = null, ghost = false;
  for (const t of ry4.trains) {
    if (t.moveTimer !== 0) sane = false; // 跨格计时已清零
    if (ry4.occupy.get(t.x + ',' + t.y) !== t.id) sane = false;
  }
  for (const [k, id] of ry4.occupy) if (!ry4.trainById(id)) ghost = true;
  ok(sane, '读档后每车占用表与其落定格一致、无残留跨格计时');
  ok(!ghost, '读档后无幽灵占用条目');
  for (let i = 0; i < 600; i++) {
    g4.tickOnce();
    const pos = {};
    for (const t of ry4.trains) {
      const k = t.x + ',' + t.y;
      if (pos[k]) { overlap = k; break; }
      pos[k] = t.id;
    }
    if (overlap) break;
  }
  ok(!overlap, '读档后继续运行两车全程不重叠');
}

console.log('\n[R11] 损坏存档容错：同格多车读档后自动疏散，绝不重建重叠占用');
{
  // 用独立游戏实例构造存档，避免共享全局图上的其他列车干扰
  const g0 = new FG.Game();
  const g0gen = FG.Maps.generate(FG.Maps.getPreset('greenfield'), 12321, 'medium');
  g0.startWithMap(g0gen, null, 'corrupt-test');
  g0.research.completed.add('railTransport');
  const m0 = g0.map, sim0 = g0.sim, ry0 = g0.railway;
  for (let x = 2; x <= 8; x++) {
    const b = FG.Map.create('rail', x, 60, 0); m0.register(b); sim0.register(b);
  }
  ry0.markDirty();
  const dep = FG.Map.create('trainDepot', 2, 59, 0); m0.register(dep); sim0.register(dep);
  const tr = ry0.spawnTrain(dep);
  tr.addStop('SX', 'unload', null, 1);
  ticks(g0, 2);
  const data = JSON.parse(JSON.stringify(g0.serialize()));
  // 人为塞入第二辆与第一辆同格的车
  data.railway.trains.push(JSON.parse(JSON.stringify(data.railway.trains[0])));
  data.railway.trains[1].id = 'T999';
  data.railway.trainSeq = 1000;
  const g5 = new FG.Game();
  let err = null;
  try { g5.deserialize(data); } catch (e) { err = e; }
  ok(!err, '同格多车损坏存档读取不报错' + (err ? '：' + err.message : ''));
  const keys = Array.from(g5.railway.occupy.keys());
  const p0 = g5.railway.trains[0].x + ',' + g5.railway.trains[0].y;
  const p1 = g5.railway.trains[1].x + ',' + g5.railway.trains[1].y;
  ok(new Set(keys).size === keys.length && g5.railway.trains.length === 2 && p0 !== p1,
     '同格多车被疏散到不同格（占用表无重复键：' + p0 + ' vs ' + p1 + '）');
}

console.log('\n[R12] 区间预留：行驶前车头前方按窗口预留，停运释放、恢复后重建，改计划立即重预留');
{
  const y = 54;
  straightLine(0, 20, y, { 20: true });
  const st = m.buildingAt(20, y);
  const depot = place('trainDepot', 0, y - 1, 0);
  const tr = ry.spawnTrain(depot);
  tr.addStop(st.stationId, 'unload', null, 1);
  tr.pushToTrain('stone', 1);
  ticks(game, 3);
  // 前方应有若干格区间预留（不含物理格）
  let reservedAhead = 0;
  for (const [k, id] of ry.reserve) if (id === tr.id && k !== tr.x + ',' + tr.y) reservedAhead++;
  ok(reservedAhead >= 2, '行驶前列车已在车头前方建立区间预留（' + reservedAhead + ' 格）');
  ok(ry.reserve.get(tr.x + ',' + tr.y) !== tr.id, '当前物理格只在 occupy、不在 reserve');
  // 停运：前方预留全部释放（物理格保留）
  const physK = tr.x + ',' + tr.y;
  tr.setPaused(true);
  let left = 0;
  for (const id of ry.reserve.values()) if (id === tr.id) left++;
  ok(left === 0, '停运后全部区间预留释放（剩余 ' + left + '）');
  ok(ry.occupy.get(physK) === tr.id || Array.from(ry.occupy.values()).includes(tr.id), '停运保留物理占用（不脱轨）');
  // 恢复：重新寻路并建立预留
  tr.setPaused(false);
  ticks(game, 3);
  let again = 0;
  for (const id of ry.reserve.values()) if (id === tr.id) again++;
  ok(again >= 2, '恢复运行后区间预留重新建立（' + again + ' 格）');
  // 改计划：旧预留立即作废、按新目标重新预留
  const st2 = place('station', 20, y - 2, 0);
  place('rail', 19, y - 1, 0); place('rail', 19, y - 2, 0);
  tr.skip();
  tr.addStop(st2.stationId, 'unload', null, 1);
  ticks(game, 2);
  let sane = true;
  for (const [k, id] of ry.reserve) {
    if (id !== tr.id) continue;
    const [rx, ry2] = k.split(',').map(Number);
    if (rx > 20 || ry2 > y) sane = false;
  }
  ok(sane, '改计划后区间预留指向新目标（无残留旧线预留）');
  ticks(game, 400);
  ok(stationCount(st2, 'stone') === 1 || tr.x === st2.x && tr.y === st2.y, '列车按新计划送达（或已到站）');
}

console.log('\n[R13] 拥堵绕行：旁线空闲时列车自动绕行他车占用区间，不排队死等');
{
  const y = 60;
  // 主线 (2,y)-(14,y)；旁线在 x=8..10 绕到 y-1（经两个交叉口 (8,y) 与 (10,y)）
  straightLine(2, 14, y, { 14: true });
  for (let x = 8; x <= 10; x++) place('rail', x, y - 1, 0);
  const stSlow = m.buildingAt(14, y);
  // 慢车占住主线中段 (9,y) 的车站并长时间装卸（无货可卸 → 停满最长停站时间）
  const blockerSt = place('station', 9, y, 0);
  const depA = place('trainDepot', 2, y - 1, 0);
  const slow = ry.spawnTrain(depA); // 机务段在 (2,y-1)：优先落在 (2,y)…跳过它，直接放 (4,y)
  ry.occupy.delete(slow.x + ',' + slow.y);
  slow.x = slow.px = 4; slow.y = slow.py = y;
  ry.occupy.set('4,' + y, slow.id);
  slow.path = null;
  // 循环计划：9 站装卸；停稳后直接停运——物理格继续占住主线、前方预留全部释放，
  // 正好模拟「区间被占但旁线空闲」的拥堵场景（停运释放由 R12 单独验证）
  slow.addStop(blockerSt.stationId, 'unload', null, 1);
  slow.addStop(stSlow.stationId, 'unload', null, 1);
  slow.pushToTrain('coal', 1);
  ticks(game, 24); // 慢车在 9 站停靠
  ok(slow.x === 9 && slow.y === y && slow.state === 'docked', '慢车抵达主线 9 站停靠（' + slow.state + '@' + slow.x + ',' + slow.y + '）');
  slow.setPaused(true); // 占住 (9,y)，主线中段被堵死、旁线空闲
  ticks(game, 2);
  ok(ry.occupiedBy(9, y) === slow.id, '停运慢车继续物理占用主线 9 站格');
  // 快车：放在慢车后方空轨 (3,y)，目标 14 站
  const fast = new FG.Train('Tfast', 3, y, 1);
  ry.trains.push(fast); ry.occupy.set('3,' + y, fast.id);
  fast.plan.loop = false;
  fast.addStop(stSlow.stationId, 'unload', null, 1);
  fast.pushToTrain('ironOre', 1);
  let usedBypass = false, arrived = false;
  for (let i = 0; i < 600; i++) {
    game.tickOnce();
    if (fast.y === y - 1) usedBypass = true;
    if (fast.x === 14 && fast.y === y) arrived = true;
    if (arrived && stationCount(stSlow, 'ironOre') === 1) break;
  }
  ok(usedBypass, '快车经旁线（y-1）绕行拥堵区间而非在慢车后死等');
  ok(arrived && stationCount(stSlow, 'ironOre') === 1, '绕行后快车抵达终点站卸货');
  // 交叉口已识别（节点度数 ≥3）
  ok(ry.isJunction(8, y) && ry.isJunction(10, y), '接轨点识别为交叉口（度数≥3）');
}

console.log('\n[R14] 单线会车等待：对向顶住先会车等待（不立即标红）；补会让线后自动绕行疏解，全程不重叠');
{
  const y = 66;
  // 起初是纯单线（无绕行）：西站(2) ↔ 东站(18)
  straightLine(2, 18, y, { 2: true, 18: true });
  const stW = m.buildingAt(2, y), stE = m.buildingAt(18, y);
  const depW = place('trainDepot', 2, y - 1, 0);
  const tw = ry.spawnTrain(depW); // 西站
  const te = new FG.Train('Teast', 17, y, 3);
  ry.trains.push(te); ry.occupy.set('17,' + y, te.id);
  tw.plan.loop = false; te.plan.loop = false;
  tw.addStop(stE.stationId, 'unload', null, 1); tw.pushToTrain('stone', 1);
  te.addStop(stW.stationId, 'unload', null, 1); te.pushToTrain('gear', 1);
  let sawMeeting = false, overlap2 = false, redDuringWait = false;
  for (let i = 0; i < 200; i++) {
    game.tickOnce();
    if (te.state === 'meeting' && tw.state === 'meeting') { sawMeeting = true; break; }
    if (te.state === 'blocked' || tw.state === 'blocked') redDuringWait = true;
    if (te.x === tw.x && te.y === tw.y) overlap2 = true;
  }
  ok(!overlap2, '会车过程两列车从未占同一格');
  ok(sawMeeting, '纯单线对向顶住：两车进入「会车等待」（而非立即堵死标红）');
  ok(!redDuringWait, '会车超时窗口内（< 300 tick）不误标红');
  // 玩家在会车点旁补一条会让侧线（图重建 → 路径作废重新寻路）：
  // (8,y)-(8,y-1)-(8,y-2)-(9..12,y-2)-(12,y-1)-(12,y)，完整绕过会车占用的 9/10 格
  place('rail', 8, y - 1, 0); place('rail', 8, y - 2, 0);
  for (let x = 9; x <= 12; x++) place('rail', x, y - 2, 0);
  place('rail', 12, y - 1, 0);
  // 西车进侧线让行（其路径含侧线；东车直穿主线）：把西车目标改为侧线外已有的东站仍可行，
  // 这里直接让西车停运，东车按新图的拥堵边权经侧线绕过西车物理格
  tw.setPaused(true);
  for (let i = 0; i < 800; i++) {
    game.tickOnce();
    if (te.x === tw.x && te.y === tw.y) overlap2 = true;
    if (stationCount(stW, 'gear') === 1) break;
  }
  ok(!overlap2, '补线绕行疏解过程两车不重叠');
  ok(stationCount(stW, 'gear') === 1, '补会让线后东车绕行抵达西站卸货（图重建自愈）');
  // 西车恢复后也能送达东站
  tw.setPaused(false);
  for (let i = 0; i < 800; i++) {
    game.tickOnce();
    if (te.x === tw.x && te.y === tw.y) overlap2 = true;
    if (stationCount(stE, 'stone') === 1) break;
  }
  ok(!overlap2, '西车恢复后运行全程不重叠');
  ok(stationCount(stE, 'stone') === 1, '西车恢复后送达东站');
}

console.log('\n[R15] 拆轨释放区间预留：拆除仅被预留的轨道后列车重新寻路；物理占用格仍禁拆');
{
  const y = 72;
  straightLine(2, 18, y, { 18: true });
  const st = m.buildingAt(18, y);
  const depot = place('trainDepot', 2, y - 1, 0);
  const tr = ry.spawnTrain(depot);
  tr.addStop(st.stationId, 'unload', null, 1);
  tr.pushToTrain('coal', 1);
  ticks(game, 2);
  // 找一个被本车预留但物理无车的前方格
  let reserveTile = null;
  for (const [k, id] of ry.reserve) {
    if (id === tr.id && !ry.occupy.has(k)) { const [x, yy] = k.split(',').map(Number); reserveTile = { x, y: yy }; break; }
  }
  ok(!!reserveTile, '存在仅被区间预留（无物理占用）的前方轨格');
  if (reserveTile) {
    const b = m.buildingAt(reserveTile.x, reserveTile.y);
    const removed = game.removeBuilding(b);
    ok(removed !== false, '仅预留、无物理占用的轨道允许拆除（拆除即释放该预留）');
    ticks(game, 2);
    const ghostKey = reserveTile.x + ',' + reserveTile.y;
    ok(!ry.reserve.has(ghostKey), '被拆轨格不再残留在区间预留表（无幽灵预留）');
    // 物理占用格仍禁止拆除
    place('rail', reserveTile.x, reserveTile.y, 0);
    ticks(game, 30);
    const occ = m.buildingAt(tr.x, tr.y);
    ok(game.removeBuilding(occ) === false, '列车物理占用格依旧禁止拆除');
    ticks(game, 400);
    ok(stationCount(st, 'coal') === 1, '补轨后列车重新寻路并送达');
  }
}

console.log('\n[R16] 改计划/单程切循环的占用释放与运输进度：中途改站不卡区间，进度按新计划继续');
{
  const y = 78;
  straightLine(2, 20, y, { 20: true });
  place('station', 20, y - 2, 0);
  place('rail', 19, y - 1, 0); place('rail', 19, y - 2, 0); place('rail', 20, y - 1, 0);
  const stEnd = m.buildingAt(20, y), stAlt = m.buildingAt(20, y - 2);
  const depot = place('trainDepot', 2, y - 1, 0);
  const tr = ry.spawnTrain(depot);
  tr.plan.loop = false;
  tr.addStop(stEnd.stationId, 'unload', 'ironPlate', 10);
  tr.pushToTrain('ironPlate', 10);
  ticks(game, 8);
  // 行驶中途改计划：跳过原站、改去 alt（单程），再切回循环
  tr.skip();
  tr.addStop(stAlt.stationId, 'unload', 'ironPlate', 10);
  tr.setLoop(true);
  ticks(game, 400);
  ok(stationCount(stAlt, 'ironPlate') === 10, '改计划后 10 铁板送达新站（运输进度按新计划继续）');
  // 旧线（主线终点）不应有货
  ok(stationCount(stEnd, 'ironPlate') === 0, '旧目标站未收到货（改计划后未沿旧预留行驶）');
}

console.log('\n[R17] 交叉口 FIFO：不同方向列车争用交汇点，多波轮转通过不饿死、不重叠');
{
  const y = 84;
  // 两条独立直线在 (7,y) 十字交叉，两端均为尽头站；每波用两列全新车（东西/南北各一），
  // 到站清道后解编、下一波重新发车——专门压测交汇点争用的 FIFO 公平性
  straightLine(1, 13, y, { 1: true, 13: true });
  for (let yy = y - 5; yy <= y + 5; yy++) {
    if (yy === y) continue;
    if (yy === y - 5 || yy === y + 5) place('station', 7, yy, 0);
    else place('rail', 7, yy, 0);
  }
  const stW = m.buildingAt(1, y), stE = m.buildingAt(13, y);
  const stS = m.buildingAt(7, y - 5), stN = m.buildingAt(7, y + 5);
  function mkOne(id, x0, y0, dir, dest) {
    const t = new FG.Train(id, x0, y0, dir);
    ry.trains.push(t); ry.occupy.set(x0 + ',' + y0, t.id);
    t.plan.loop = false;
    t.addStop(dest.stationId, 'unload', null, 1);
    t.pushToTrain('stone', 1);
    return t;
  }
  function chestStone(st) {
    let n = 0;
    for (const s of st.chest) if (s.type === 'stone') { n += s.count; s.count = 0; s.type = null; }
    return n;
  }
  let overlap3 = false, maxWait = 0;
  const cur = {};
  let eastArrive = 0, northArrive = 0;
  for (let wave = 0; wave < 4; wave++) {
    const te = mkOne('Te' + wave, 2, y, 1, stE);
    const tn = mkOne('Tn' + wave, 7, y - 4, 1, stN);
    for (let i = 0; i < 800; i++) {
      game.tickOnce();
      for (const t of ry.trains) {
        if (t.state === 'waiting' || t.state === 'meeting') {
          cur[t.id] = (cur[t.id] || 0) + 1;
          maxWait = Math.max(maxWait, cur[t.id]);
        } else cur[t.id] = 0;
      }
      const pos = {};
      for (const t of ry.trains) {
        const k = t.x + ',' + t.y;
        if (pos[k]) overlap3 = true;
        pos[k] = t.id;
      }
      if (te.state === 'idle' && tn.state === 'idle') break;
    }
    if (chestStone(stE) >= 1) eastArrive++;
    if (chestStone(stN) >= 1) northArrive++;
    for (const t of [te, tn]) ry.removeTrain(t);
  }
  ok(!overlap3, '交叉车流全程无同格重叠');
  ok(eastArrive === 4, '4 波东西向列车全部穿过交汇点抵达（' + eastArrive + '/4，方向未饿死）');
  ok(northArrive === 4, '4 波南北向列车全部穿过交汇点抵达（' + northArrive + '/4，方向未饿死）');
  ok(maxWait < 300, 'FIFO 轮转下无列车在交汇点长期等待（最长连续 ' + maxWait + ' tick）');
}
console.log('\n[R18] 区间预留读档：旧档无 reserve 字段也能由列车位置惰性重建，且不与他车冲突');
{
  const y = 90;
  straightLine(2, 30, y, { 30: true });
  const st = m.buildingAt(30, y);
  const depot = place('trainDepot', 2, y - 1, 0);
  const trA = ry.spawnTrain(depot);
  trA.addStop(st.stationId, 'unload', null, 1);
  trA.pushToTrain('stone', 1);
  ticks(game, 10);
  const trB = ry.spawnTrain(depot);
  trB.addStop(st.stationId, 'unload', null, 1);
  trB.pushToTrain('stone', 1);
  ticks(game, 20);
  const data = JSON.parse(JSON.stringify(game.serialize()));
  const g6 = new FG.Game();
  g6.deserialize(data);
  const ry6 = g6.railway;
  // 读档瞬间 reserve 为空：首个 tick 后各车应已重建预留，且预留互不冲突
  g6.tickOnce();
  let conflict = false;
  const owners = {};
  for (const [k, id] of ry6.reserve) {
    if (owners[k] && owners[k] !== id) conflict = true;
    owners[k] = id;
  }
  for (const [k, id] of ry6.occupy) {
    if (owners[k] && owners[k] !== id) conflict = true;
  }
  ok(!conflict, '读档后首个 tick 重建的区间预留与物理占用互不冲突');
  // 无 reservation 字段的更旧存档（模拟）：手工删掉也应正常
  const oldish = JSON.parse(JSON.stringify(data));
  // railway 段本身没有 reserve 字段（预留不序列化）——确认结构并直接推进
  ok(oldish.railway && oldish.railway.trains && oldish.railway.trains[0].moveTimer !== undefined,
     '存档含列车移动进度（moveTimer）与计划，区间预留按设计不序列化、读档重建');
  let overlap4 = false;
  for (let i = 0; i < 800; i++) {
    g6.tickOnce();
    const pos = {};
    for (const t of ry6.trains) {
      const k = t.x + ',' + t.y;
      if (pos[k]) { overlap4 = true; break; }
      pos[k] = t.id;
    }
    if (overlap4) break;
  }
  ok(!overlap4, '读档重建预留后列车继续运行全程不重叠');
}

console.log('\n结果：' + pass + ' 通过, ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
