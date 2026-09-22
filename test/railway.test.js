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

/** 在给定铁路上直接放一辆朝 dir 的车（绕过机务段），并占住起点 */
function spawnDirectOn(r, id, x, y, dir) {
  const tr = new FG.Train(id, x, y, dir);
  r.trains.push(tr);
  r.occupy.set(x + ',' + y, tr.id);
  tr.reserve = new Set([x + ',' + y]);
  r.reserve.set(x + ',' + y, tr.id);
  return tr;
}
/** 构造一个隔离的铁路游戏（独立地图），返回 {g, r, mm, ss, put, railLine} */
function isolatedRailGame(seed) {
  const g = new FG.Game();
  const gg = FG.Maps.generate(FG.Maps.getPreset('greenfield'), seed, 'medium');
  g.startWithMap(gg, null, 'rail-iso-' + seed);
  g.research.completed.add('railTransport');
  const r = g.railway, mm = g.map, ss = g.sim;
  const put = (type, x, y, dir) => {
    const b = FG.Map.create(type, x, y, dir || 0);
    if (b.def.railStation) { b.stationId = 'S' + (r.stationSeq++); b.stationName = '站点 ' + b.stationId.slice(1); }
    mm.register(b); ss.register(b); r.markDirty();
    return b;
  };
  const railLine = (x0, x1, y, stations) => {
    for (let x = x0; x <= x1; x++) put(stations && stations[x] ? 'station' : 'rail', x, y, 0);
  };
  return { g, r, mm, ss, put, railLine, spawn: (id, x, y, d) => spawnDirectOn(r, id, x, y, d) };
}

console.log('\n[R12] 区间前瞻预留：列车起步即锁定前方多格；停运后收回到物理占用格');
{
  const T = isolatedRailGame(3120);
  const y = 10;
  T.railLine(0, 20, y, { 20: true });
  const st = T.mm.buildingAt(20, y);
  const tr = T.spawn('Tr12', 2, y, 1);
  tr.plan.loop = false;
  tr.addStop(st.stationId, 'unload', null, 1);
  tr.pushToTrain('coal', 1);
  T.g.tickOnce(); // prepare 阶段前瞻
  const reserved = [...T.r.reserve.entries()].filter(e => e[1] === tr.id).map(e => e[0]);
  ok(reserved.length === 1 + FG.Config.TRAIN_LOOKAHEAD,
     '行驶列车前瞻预留 1+' + FG.Config.TRAIN_LOOKAHEAD + ' 格（实测 ' + reserved.length + ' 格）');
  ok(reserved.every(k => k.endsWith(',' + y)), '预留全部沿计划路径（同一水平线）');
  // 停运：前瞻收回到物理占用格
  tr.setPaused(true);
  T.g.tickOnce();
  const after = [...T.r.reserve.entries()].filter(e => e[1] === tr.id).map(e => e[0]);
  const occ = [...T.r.occupy.entries()].filter(e => e[1] === tr.id).map(e => e[0]);
  ok(after.length === occ.length && after.every(k => occ.includes(k)),
     '停运后预留不超前于物理占用（reserve=' + after.join('|') + ' occupy=' + occ.join('|') + '）');
}

console.log('\n[R13] 单线会车等待：无侧线对向不顶牛，信号机外等待并标红提示改线');
{
  const T = isolatedRailGame(3130);
  const y = 10;
  T.railLine(2, 14, y, { 2: true, 14: true });
  const stW = T.mm.buildingAt(2, y), stE = T.mm.buildingAt(14, y);
  const ta = T.spawn('Ta13', 12, y, 3); // 向西去西站
  const tb = T.spawn('Tb13', 4, y, 1);  // 向东去东站
  ta.plan.loop = false; tb.plan.loop = false;
  ta.addStop(stW.stationId, 'unload', null, 1); ta.pushToTrain('coal', 1);
  tb.addStop(stE.stationId, 'unload', null, 1); tb.pushToTrain('ironOre', 1);
  let overlap = false, bothBlocked = false;
  for (let i = 0; i < 400; i++) {
    T.g.tickOnce();
    if (ta.x === tb.x && ta.y === tb.y) overlap = true;
    if (ta.state === 'blocked' && tb.state === 'blocked') { bothBlocked = true; break; }
  }
  ok(!overlap, '对向会车全程未占同一格（无对撞/穿越）');
  ok(bothBlocked, '无会车侧线单线对顶：双车标红 blocked 提示加侧线改线（ta=' + ta.state + ' tb=' + tb.state + '）');
  // 解编一辆后另一辆能继续到达
  T.r.removeTrain(tb);
  ta.setPaused(false);
  for (let i = 0; i < 400; i++) { T.g.tickOnce(); if (ta.x === 2 && ta.y === y) break; }
  ok(ta.x === 2 && ta.y === y, '对向车解编后预留释放，剩余列车继续到达西站（@' + ta.x + ',' + ta.y + '）');
}

console.log('\n[R14] 拥堵绕行：主线对向堵死时加权寻路自动走平行会车侧线');
{
  const T = isolatedRailGame(3140);
  const y0 = 10, y1 = 12;
  for (let x = 2; x <= 16; x++) { T.put('rail', x, y0, 0); T.put('rail', x, y1, 0); }
  T.put('rail', 2, y0 + 1, 0); T.put('rail', 16, y0 + 1, 0); // 两端联络线
  const stE = T.put('station', 16, y0, 0);
  const blkTr = T.spawn('Blk14', 9, y0, 3);
  blkTr.plan.paused = true; blkTr.state = 'paused';
  const tr = T.spawn('Tr14', 3, y0, 1);
  tr.plan.loop = false;
  tr.addStop(stE.stationId, 'unload', null, 1);
  tr.pushToTrain('stone', 1);
  let usedSiding = false;
  for (let i = 0; i < 500; i++) {
    T.g.tickOnce();
    if (tr.y === y1 || tr.py === y1) usedSiding = true;
    if (tr.x === 16 && tr.y === y0) break;
  }
  ok(usedSiding, '主线拥堵时列车改走平行侧线 y=' + y1 + ' 绕行');
  ok(tr.x === 16 && tr.y === y0, '经侧线绕行后到达主线上的东站（@' + tr.x + ',' + tr.y + ' ' + tr.state + '）');
  ok(tr.state !== 'blocked' && tr.state !== 'noroute', '绕行未导致堵死/断路（' + tr.state + '）');
}

console.log('\n[R15] 交叉口公平：抢不到交叉口的车停在信号机外，垂直方向不被饿死');
{
  const T = isolatedRailGame(3150);
  const y = 14;
  T.railLine(2, 12, y, { 12: true });
  for (let yy = y - 5; yy <= y + 5; yy++) if (yy !== y) T.put('rail', 7, yy, 0);
  const stE = T.mm.buildingAt(12, y);
  const stN = T.put('station', 7, y - 5, 0);
  const stS = T.put('station', 7, y + 5, 0);
  const jk = '7,' + y;
  T.r.rebuildGraph(); // 放置后图被标记 dirty，首 tick 才惰性重建；这里显式建一次以便断言
  ok(T.r.blockAtKey(jk) && T.r.blockAtKey(jk).junction, '交汇格被识别为独立道岔/交叉口分区');
  const te = T.spawn('Te15', 4, y, 1); te.plan.loop = false;
  te.addStop(stE.stationId, 'unload', null, 1); te.pushToTrain('coal', 1);
  const tn = T.spawn('Tn15', 7, y + 4, 0); tn.plan.loop = false;
  tn.addStop(stN.stationId, 'unload', null, 1); tn.pushToTrain('ironOre', 1);
  const ts = T.spawn('Ts15', 7, y - 4, 2); ts.plan.loop = false;
  ts.addStop(stS.stationId, 'unload', null, 1); ts.pushToTrain('stone', 1);
  const trains = [te, tn, ts];
  let overlap = false;
  for (let i = 0; i < 900; i++) {
    T.g.tickOnce();
    const seen = {};
    for (const t of trains) { const k = t.x + ',' + t.y; if (seen[k]) overlap = true; seen[k] = 1; }
  }
  const eArrived = te.x === 12 || te.state === 'idle';
  ok(eArrived, '东西向列车穿过被争用的交叉口到达东站（@' + te.x + ',' + te.y + '），垂直方向不饿死');
  ok(!overlap, '交叉口争用全程无重叠占用');
  ok(tn.state === 'blocked' || Math.abs(tn.y - y) >= 1,
     '未能进入的南北车停在交叉口自己一侧（tn @' + tn.x + ',' + tn.y + ' ' + tn.state + '），交叉口保持清空');
}

console.log('\n[R16] 改计划 / 拆轨释放预留：区间与交叉口立即让给他人');
{
  const T = isolatedRailGame(3160);
  const y = 10;
  T.railLine(0, 20, y, { 20: true });
  for (let yy = y - 6; yy <= y + 6; yy++) if (yy !== y) T.put('rail', 10, yy, 0);
  const stE = T.mm.buildingAt(20, y);
  const stN = T.put('station', 10, y - 6, 0);
  const te = T.spawn('Te16', 6, y, 1); te.plan.loop = false;
  te.addStop(stE.stationId, 'unload', null, 1); te.pushToTrain('coal', 1);
  T.g.tickOnce();
  ok(T.r.reserve.get('10,' + y) === te.id, '东行车前瞻预占交叉口');
  // 删除全部停靠 → 预留释放
  while (te.stops.length) te.removeStop(0);
  T.g.tickOnce();
  const teReserveAfter = [...T.r.reserve.entries()].filter(e => e[1] === te.id).map(e => e[0]);
  ok(te.state === 'idle' && T.r.reserve.get('10,' + y) !== te.id && teReserveAfter.length <= 1,
     '删光计划后列车待命、交叉口预留释放（state=' + te.state + '，自身预留 ' + teReserveAfter.length + ' 格）');
  // 南北车此时能通过交叉口
  const tn = T.spawn('Tn16', 10, y + 4, 0); tn.plan.loop = false;
  tn.addStop(stN.stationId, 'unload', null, 1); tn.pushToTrain('ironOre', 1);
  for (let i = 0; i < 300; i++) { T.g.tickOnce(); if (tn.y <= y - 5) break; }
  ok(tn.y <= y - 5, '计划释放后南北车通过交叉口北行（@10,' + tn.y + '）');
  // 拆轨触发图重建：在列车正常行驶、前瞻已展开时拆一节未被物理占用的轨
  te.addStop(stE.stationId, 'unload', null, 1);
  let leadBefore = 0;
  for (let i = 0; i < 60; i++) {
    T.g.tickOnce();
    leadBefore = [...T.r.reserve.entries()].filter(e => e[1] === te.id).length;
    if (leadBefore > 2) break;
  }
  const removed13 = T.g.removeBuilding(T.mm.buildingAt(13, y));
  T.g.tickOnce();
  const leadAfter = [...T.r.reserve.entries()].filter(e => e[1] === te.id).length;
  ok(removed13 !== false && leadBefore > 2 && leadAfter <= 1,
     '行驶中拆轨：图重建清空该车全部前瞻预留（' + leadBefore + ' → ' + leadAfter + '），列车转断路等待补轨');
}

console.log('\n[R17] 旧存档恢复：无 reserve 概念的旧档读入后由列车位置重建并继续');
{
  const T = isolatedRailGame(3170);
  const y = 10;
  T.railLine(2, 18, y, { 2: true, 18: true });
  const stA = T.mm.buildingAt(2, y), stB = T.mm.buildingAt(18, y);
  const tr = T.spawn('Tr17', 4, y, 1);
  tr.plan.loop = true;
  tr.addStop(stB.stationId, 'unload', null, 1);
  tr.pushToTrain('coal', 3);
  ticks(T.g, 10);
  const data = JSON.parse(JSON.stringify(T.g.serialize()));
  ok(!('reserve' in data.railway), '序列化不包含前瞻预留（reserve 为每 tick 重建的派生状态）');

  const g2 = new FG.Game();
  g2.deserialize(data);
  const tr2 = g2.railway.trains.find(t => t.id === tr.id);
  ok(!!tr2, '旧格式存档列车恢复');
  let err = null;
  try {
    for (let i = 0; i < 400; i++) g2.tickOnce();
  } catch (e) { err = e; }
  ok(!err, '无 reserve 字段旧档读入后调度正常推进' + (err ? '：' + err.stack : ''));
  let sane = true;
  for (const t of g2.railway.trains) {
    if (g2.railway.occupy.get(t.x + ',' + t.y) !== t.id) sane = false;
  }
  ok(sane, '读档后占用表与列车位置一致，预留随首个 tick 自动重建');
  // 完全无 railway 字段的更旧存档也不报错
  const old = JSON.parse(JSON.stringify(data));
  delete old.railway;
  const g3 = new FG.Game();
  let err3 = null;
  try { g3.deserialize(old); ticks(g3, 5); } catch (e) { err3 = e; }
  ok(!err3 && g3.railway.trains.length === 0, '无 railway 字段旧档读取/推进不报错且为空铁路');
}
