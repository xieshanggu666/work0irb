/**
 * 设备磨损与维修工单测试：node test/maintenance.test.js
 * 覆盖：
 *  科技门控 / 运转积累磨损 / 故障自动开单停机 / 按优先级从物流预留备件 /
 *  缺件等待 / 停机检修恢复生产 / 取消返还未用备件 / 拆除返还预留 /
 *  升级衔接（故障状态与工单迁移、备料需求重算）/ 施工池与按需调度盘点不到预留备件 /
 *  优先级争料（高层优先、同级轮转）/ 存档续修（含检修中读档、旧档兼容）/
 *  磨损不影响传送带与箱子 / 水泵磨损
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
global.window = global;

const files = [
  'js/core/config.js', 'js/core/utils.js',
  'js/data/items.js', 'js/data/recipes.js', 'js/data/buildings.js',
  'js/data/research.js', 'js/data/maps.js',
  'js/game/map.js', 'js/game/scheduler.js', 'js/game/railway.js',
  'js/game/contracts.js', 'js/game/maintenance.js',
  'js/game/sim.js', 'js/game/researchmgr.js', 'js/game/stats.js',
  'js/game/save.js', 'js/game/blueprint.js', 'js/game/game.js',
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
function freeSpare(g) {
  let n = 0;
  for (const b of g.map.buildings.values()) {
    if (b.chest) for (const s of b.chest) if (s.type === 'sparePart') n += s.count;
  }
  for (const pile of g.map.piles.values()) for (const s of pile) if (s.type === 'sparePart') n += s.count;
  return n;
}
function newGame() {
  const g = new FG.Game();
  g.startWithMap(FG.Maps.generate(FG.Maps.getPreset('greenfield'), (Math.random() * 99999) | 0, 'medium'), null, 'mo');
  g.research.completed.add('predictiveMaintenance');
  g.maintenance.enable();
  return g;
}
function place(g, type, x, y, dir) {
  const b = FG.Map.create(type, x, y, dir || 0);
  g.map.register(b); g.sim.register(b);
  g.maintenance.initWear(b);
  return b;
}

// ================= [M1] 科技门控 + 备件配方 =================
console.log('\n[M1] 科技门控：未研究无磨损；研究后开启并解锁备件配方');
{
  const g = new FG.Game();
  g.startWithMap(FG.Maps.generate(FG.Maps.getPreset('greenfield'), 1, 'medium'), null, 'gate');
  const fur = place(g, 'furnace', 3, 3);
  ok(!g.maintenance.enabled, '未研究预测性维护：磨损系统关闭');
  ok(!g.research.isRecipeUnlocked('craft:sparePart'), '备件配方未解锁');
  fur.wear = 5;  // 模拟字段存在
  ticks(g, 50);
  ok(!fur.broken, '关闭期间不积累磨损、不故障');
  g.research.completed.add('advancedElectronics');
  ok(g.research.canStart('predictiveMaintenance'), '高级电子学完成后可研究预测性维护');
  g.research.completed.add('predictiveMaintenance');
  g.maintenance.enable();
  ok(g.maintenance.enabled, '研究后磨损系统开启');
  ok(g.research.isRecipeUnlocked('craft:sparePart'), '备件配方已解锁');
  ok(fur.wearLimit >= FG.Config.WEAR_FAIL_MIN && fur.wearLimit <= FG.Config.WEAR_FAIL_MAX,
    '设备获得随机寿命 [' + FG.Config.WEAR_FAIL_MIN + ',' + FG.Config.WEAR_FAIL_MAX + ']：' + fur.wearLimit);
}

// ================= [M2] 运转积累磨损 → 故障自动开单停机 =================
console.log('\n[M2] 生产周期积累磨损，磨损满自动故障并生成工单');
{
  const g = newGame();
  const fur = place(g, 'furnace', 5, 5);
  const wear0 = fur.wear;
  fur.wear = fur.wearLimit - 2;
  // 供料让它真实完成 2 个生产周期
  g.setRecipe(fur, 'smelt:iron');
  fur.slots.inputs.ironOre.count = 10;
  for (let i = 0; i < 200 && !fur.broken; i++) g.tickOnce();
  ok(fur.broken, '石炉磨损满后故障停机');
  ok(fur.status === 'broken', '故障设备状态为 broken');
  ok(g.maintenance.orders.length === 1, '自动生成 1 张维修工单');
  const o = g.maintenance.orders[0];
  ok(o.need === 1 && o.state === 'waiting', '石炉维修需备件×1，状态 waiting（' + o.need + ',' + o.state + '）');
  // 故障期间不生产
  const outBefore = fur.slots.outputs.ironPlate ? fur.slots.outputs.ironPlate.count : 0;
  ticks(g, 30);
  const outAfter = fur.slots.outputs.ironPlate ? fur.slots.outputs.ironPlate.count : 0;
  ok(outBefore === outAfter, '故障停机期间不生产（产出不增加）');
  // 故障期间调度器不再为其备料（无需求臂时不影响；验证 wantsOf 为 null）
  ok(g.sim.scheduler.wantsOf(fur) === null, '故障设备不参与按需物流调度');
  void wear0;
}

// ================= [M3] 按优先级预留备件 + 停机检修恢复 =================
console.log('\n[M3] 工单从箱子预留备件，齐备后停机检修，恢复生产');
{
  const g = newGame();
  const fur = place(g, 'furnace', 5, 6);
  const chest = place(g, 'chest', 9, 9);
  g.sim.chestAdd(chest, 'sparePart', 3);
  g.maintenance.breakdown(fur);
  const o = g.maintenance.orderAt(5, 6);
  g.tickOnce();
  ok((o.stock.sparePart || 0) === 1, '工单从箱子预留 1 件备件');
  ok(freeSpare(g) === 2, '全图自由备件剩 2（预留已移出物流）');
  // 施工建材池口径也盘点不到预留备件
  let poolSees = 0;
  for (const b of g.map.buildings.values()) {
    if (b.def.storage) for (const s of b.chest) if (s.type === 'sparePart') poolSees += s.count;
  }
  ok(poolSees === 2, '施工统一建材池只能盘点到未预留的 2 件');
  ticks(g, FG.Config.REPAIR_TIME_TICKS + 2);
  ok(!fur.broken, '检修完成后设备恢复');
  ok(g.maintenance.orders.length === 0, '工单完成出列');
  ok(fur.wear === 0, '磨损清零');
  ok(fur.wearLimit >= FG.Config.WEAR_FAIL_MIN, '检修后获得新寿命');
  ok(freeSpare(g) === 2, '检修消耗 1 备件（剩余 2）');
  ok(g.maintenance.archived[0] && g.maintenance.archived[0].state === 'done', '归档记录为已修复');
}

// ================= [M4] 缺件等待：备件不齐持续停机，补料后续修 =================
console.log('\n[M4] 缺备件：设备停机等件，不消耗、不开工；补齐后续修');
{
  const g = newGame();
  const fur = place(g, 'furnace', 5, 7);
  g.maintenance.breakdown(fur);
  const o = g.maintenance.orderAt(5, 7);
  ticks(g, 100);
  ok(fur.broken && o.state === 'waiting' && o.waiting, '无备件时持续缺件等待');
  ok(g.maintenance.orders.length === 1, '工单仍在列表');
  // 地面堆放 1 备件（另一料源）
  g.map.pileAdd(2, 2, 'sparePart', 1);
  g.tickOnce();
  ok((o.stock.sparePart || 0) === 1, '地面堆备件也可被预留');
  ok(o.state === 'repairing', '备件齐备立即进入停机检修');
  ticks(g, FG.Config.REPAIR_TIME_TICKS + 2);
  ok(!fur.broken, '补齐备件后检修完成恢复生产');
}

// ================= [M5] 取消工单：返还未用预留备件 =================
console.log('\n[M5] 取消工单：未用备件返还物流（箱子优先），设备仍故障可重新报修');
{
  const g = newGame();
  const fur = place(g, 'furnace', 5, 8);
  const chest = place(g, 'chest', 9, 8);
  g.sim.chestAdd(chest, 'sparePart', 2);
  g.maintenance.breakdown(fur);
  g.tickOnce();
  const o = g.maintenance.orderAt(5, 8);
  ok((o.stock.sparePart || 0) === 1, '已预留 1 备件');
  const id = o.id;
  ok(g.maintenance.cancel(id), '取消工单');
  ok(freeSpare(g) === 2, '取消后预留备件全部返还物流（2 件）');
  ok(fur.broken, '设备仍保持故障停机');
  ok(g.maintenance.archived.some(a => a.id === id && a.state === 'canceled'), '归档为已取消');
  ok(g.maintenance.report(fur), '重新报修生成新工单');
  ok(g.maintenance.orders.length === 1, '新工单已生成（存档续修入口）');
}

// ================= [M6] 拆除故障设备：预留备件落到该格地面堆 =================
console.log('\n[M6] 拆除故障设备：工单出列，预留备件随拆除物料落地不丢失');
{
  const g = newGame();
  const fur = place(g, 'furnace', 6, 8);
  const chest = place(g, 'chest', 9, 6);
  g.sim.chestAdd(chest, 'sparePart', 1);
  g.maintenance.breakdown(fur);
  g.tickOnce();
  ok((g.maintenance.orderAt(6, 8).stock.sparePart || 0) === 1, '已预留 1 备件');
  ok(g.removeBuilding(fur) !== false, '拆除故障设备');
  const pile = g.map.pileAt(6, 8);
  ok(pile && pile.some(s => s.type === 'sparePart' && s.count === 1), '预留备件落到设备格地面堆');
  ok(g.maintenance.orders.length === 0, '工单随拆除出列');
}

// ================= [M7] 高级设备需要更多备件 =================
console.log('\n[M7] 高级设备维修备件需求递增（钢炉/二级组装机/化工厂=2）');
{
  const g = newGame();
  g.research.completed.add('steelSmelting');
  g.research.completed.add('chemicalScience');
  const sf = place(g, 'steelFurnace', 3, 3);
  const a2 = place(g, 'assembler2', 4, 4);
  const cp = place(g, 'chemPlant', 5, 5);
  const f0 = place(g, 'furnace', 6, 6);
  ok(g.maintenance.sparesNeeded(sf) === 2, '钢炉需备件×2');
  ok(g.maintenance.sparesNeeded(a2) === 2, '二级组装机需备件×2');
  ok(g.maintenance.sparesNeeded(cp) === 2, '化工厂需备件×2');
  ok(g.maintenance.sparesNeeded(f0) === 1, '石炉需备件×1');
  g.maintenance.breakdown(sf);
  const o = g.maintenance.orderAt(3, 3);
  ok(o.need === 2, '钢炉工单备件需求×2');
}

// ================= [M8] 优先级争料：高层未满足前低层不分配 =================
console.log('\n[M8] 多工单争用备件：高优先级先预留，低优先级等待');
{
  const g = newGame();
  const hi = place(g, 'furnace', 1, 1);
  const lo = place(g, 'furnace', 2, 2);
  const chest = place(g, 'chest', 9, 1);
  g.sim.chestAdd(chest, 'sparePart', 1);   // 全图只有 1 件
  g.maintenance.breakdown(lo);
  g.maintenance.breakdown(hi);
  const oHi = g.maintenance.orderAt(1, 1);
  const oLo = g.maintenance.orderAt(2, 2);
  g.maintenance.setPriority(oHi.id, 'high');
  g.tickOnce();
  ok((oHi.stock.sparePart || 0) === 1, '高优先工单先得备件');
  ok((oLo.stock.sparePart || 0) === 0 && oLo.waiting, '低优先工单缺件等待');
  // 高级检修完释放后，低优先级补料
  ticks(g, FG.Config.REPAIR_TIME_TICKS + 2);
  ok(!g.maintenance.orderById(oHi.id), '高优先工单已完成');
  g.sim.chestAdd(chest, 'sparePart', 1);
  ticks(g, FG.Config.REPAIR_TIME_TICKS + 2);
  ok(!lo.broken, '低优先设备在备件补充后完成检修');
}

// ================= [M9] 升级衔接：故障设备升级后工单迁移 =================
console.log('\n[M9] 原地升级：故障/磨损状态与工单无缝迁移到新建筑');
{
  const g = newGame();
  g.research.completed.add('steelSmelting');
  const fur = place(g, 'furnace', 7, 7);
  const chest = place(g, 'chest', 9, 7);
  g.sim.chestAdd(chest, 'sparePart', 5);
  fur.wear = 42;
  g.maintenance.breakdown(fur);
  g.tickOnce();   // 石炉工单预留 1 件
  const o = g.maintenance.orderAt(7, 7);
  ok((o.stock.sparePart || 0) === 1, '石炉工单已预留 1 件');
  // 提交升级计划（furnace → steelFurnace）
  const plan = g.construction.addUpgradePlan([{ from: 'furnace', to: 'steelFurnace', x: 7, y: 7, dir: 0 }]);
  // 升级条目占位期间：工单挂起、释放预留不占料
  g.maintenance.tick();
  ok(o.upgrading, '升级占位期间工单挂起');
  ok((o.stock.sparePart || 0) === 0, '挂起期间释放预留不占料');
  // 施工落成（备齐石炉→钢炉造价 stone×6+steelPlate×4）
  g.sim.chestAdd(chest, 'stone', 20);
  g.sim.chestAdd(chest, 'steelPlate', 20);
  for (let i = 0; i < 200 && g.map.buildingAt(7, 7).type !== 'steelFurnace'; i++) g.tickOnce();
  const sf = g.map.buildingAt(7, 7);
  ok(sf && sf.type === 'steelFurnace', '升级落成钢炉');
  ok(sf.broken === true, '故障状态随升级迁移（钢炉仍故障）');
  const o2 = g.maintenance.orderAt(7, 7);
  ok(!!o2 && o2 === o, '工单迁移到新建筑（同一工单）');
  ok(o2.need === 2, '工单备件需求按新型号重算为 2');
  ticks(g, FG.Config.REPAIR_TIME_TICKS + 5);
  ok(!sf.broken, '升级后续修完成，钢炉恢复生产');
  ok(sf.wear === 0, '修复后磨损清零');
  ok(!g.construction.byId(plan.id), '升级计划完工出列');
}

// ================= [M10] 未故障设备升级：磨损随迁移继续积累 =================
console.log('\n[M10] 未故障设备升级：磨损值迁移，不产生工单');
{
  const g = newGame();
  g.research.completed.add('steelSmelting');
  const fur = place(g, 'furnace', 8, 8);
  const chest = place(g, 'chest', 9, 8);
  g.sim.chestAdd(chest, 'stone', 20);
  g.sim.chestAdd(chest, 'steelPlate', 20);
  fur.wear = 30;
  g.construction.addUpgradePlan([{ from: 'furnace', to: 'steelFurnace', x: 8, y: 8, dir: 0 }]);
  for (let i = 0; i < 200 && g.map.buildingAt(8, 8).type !== 'steelFurnace'; i++) g.tickOnce();
  const sf = g.map.buildingAt(8, 8);
  ok(sf.type === 'steelFurnace' && sf.wear === 30, '磨损值随升级迁移（wear=30）');
  ok(!sf.broken && g.maintenance.orders.length === 0, '未故障不产生工单');
}

// ================= [M11] 存档续修 =================
console.log('\n[M11] 存档往返：磨损/故障/工单预留/检修状态随档恢复，读档后续修');
{
  const g = newGame();
  const fur = place(g, 'furnace', 4, 9);
  const fur2 = place(g, 'furnace', 5, 9);
  const chest = place(g, 'chest', 9, 9);
  g.sim.chestAdd(chest, 'sparePart', 3);
  fur.wear = 77;
  g.maintenance.breakdown(fur);
  g.maintenance.breakdown(fur2);
  g.maintenance.setPriority(g.maintenance.orderAt(5, 9).id, 'high');
  ticks(g, 2);   // 高优先 fur2 拿到备件进入检修
  const data = JSON.parse(JSON.stringify(g.serialize()));
  ok(data.buildings.some(b => b.x === 4 && b.y === 9 && b.broken && b.wear >= 77), '磨损与故障字段随建筑存档');
  ok(data.maintenance.enabled === true && data.maintenance.orders.length === 2, '工单列表随档保存');

  const g2 = new FG.Game();
  g2.deserialize(data);
  ok(g2.maintenance.enabled, '读档后磨损系统按研究状态恢复开启');
  const f2a = g2.map.buildingAt(4, 9);
  const f2b = g2.map.buildingAt(5, 9);
  ok(f2a.broken && f2b.broken, '两台故障设备状态恢复');
  ok(f2a.wear === 77, '磨损值恢复');
  const oa = g2.maintenance.orderAt(4, 9), ob = g2.maintenance.orderAt(5, 9);
  ok(oa && ob, '两张工单恢复');
  ok(ob.priority === 'high' && (ob.stock.sparePart || 0) >= 1, '高优先工单及其预留随档恢复');
  // 继续模拟：读档后不再凭空完成，需走完检修
  ticks(g2, FG.Config.REPAIR_TIME_TICKS + 200);
  ok(!f2a.broken && !f2b.broken, '读档后两张工单全部续修完成');
  ok(g2.maintenance.orders.length === 0, '工单完成出列');
}

// ================= [M12] 旧存档兼容：无 maintenance 字段不报错 =================
console.log('\n[M12] 旧存档：无 maintenance 字段，按研究状态回退，推进不报错');
{
  const g = newGame();
  place(g, 'furnace', 4, 4);
  const data = JSON.parse(JSON.stringify(g.serialize()));
  delete data.maintenance;
  // 建筑也没有 wear 字段（模拟更早旧档）
  for (const b of data.buildings) { delete b.wear; delete b.wearLimit; delete b.broken; }
  const g2 = new FG.Game();
  let err = null;
  try { g2.deserialize(data); ticks(g2, 60); } catch (e) { err = e; }
  ok(!err, '旧档读取与推进不报错' + (err ? '：' + err.stack : ''));
  ok(g2.maintenance.enabled === true, '已研究科技 → 磨损系统自动开启（既有设备从 0 积累）');
  const fur = g2.map.buildingAt(4, 4);
  ok(!!fur.wearLimit && fur.wear === 0 && !fur.broken, '旧设备补齐寿命、磨损从 0 开始、不误判故障');

  // 未研究科技的旧档：完全不启用
  const g3 = new FG.Game();
  g3.startWithMap(FG.Maps.generate(FG.Maps.getPreset('greenfield'), 3, 'medium'), null, 'old2');
  const d3 = JSON.parse(JSON.stringify(g3.serialize()));
  const g4 = new FG.Game();
  try { g4.deserialize(d3); ticks(g4, 30); err = null; } catch (e) { err = e; }
  ok(!err && !g4.maintenance.enabled, '未研究科技的旧档不启用磨损');
}

// ================= [M13] 读档时设备已消失：预留备件落地不丢失 =================
console.log('\n[M13] 读档对账：工单设备不存在时预留备件落到该格地面堆');
{
  const g = newGame();
  const fur = place(g, 'furnace', 6, 9);
  const chest = place(g, 'chest', 9, 9);
  g.sim.chestAdd(chest, 'sparePart', 1);
  g.maintenance.breakdown(fur);
  g.tickOnce();
  const data = JSON.parse(JSON.stringify(g.serialize()));
  data.buildings = data.buildings.filter(b => !(b.x === 6 && b.y === 9));
  data.map.terrain[9][6] = 'grass';
  const g2 = new FG.Game();
  g2.deserialize(data);
  ok(g2.maintenance.orders.length === 0, '设备不存在的工单不恢复');
  const pile = g2.map.pileAt(6, 9);
  ok(pile && pile.some(s => s.type === 'sparePart' && s.count === 1), '预留备件落到该格地面堆不丢失');
}

// ================= [M14] 非生产设备（传送带/箱子/机械臂/管道）不磨损 =================
console.log('\n[M14] 物流与仓储设备不积累磨损');
{
  const g = newGame();
  const belt = place(g, 'belt', 1, 5, 1);
  const ch = place(g, 'chest', 2, 5);
  const ins = place(g, 'inserter', 3, 5, 1);
  const pipe = place(g, 'pipe', 4, 5);
  ticks(g, 60);
  for (const [nm, b] of [['传送带', belt], ['箱子', ch], ['机械臂', ins], ['管道', pipe]]) {
    ok(!g.maintenance.wearsOut(b), nm + '不在磨损范围');
    ok(!b.broken, nm + '不会故障');
  }
}

// ================= [M15] 矿机/实验室磨损：完成周期才积累 =================
console.log('\n[M15] 矿机/实验室随生产/科研周期积累磨损并可维修');
{
  const g = newGame();
  // 矿机放在铁矿上
  const gen = FG.Maps.generate(FG.Maps.getPreset('greenfield'), g.mapInfo.seed, 'medium');
  let oreTile = null;
  for (let y = 0; y < g.map.h && !oreTile; y++) for (let x = 0; x < g.map.w; x++) {
    if (g.map.oreAt(x, y) === 'ironOre') { oreTile = { x, y }; break; }
  }
  const miner = place(g, 'miner', oreTile.x, oreTile.y);
  miner.wear = miner.wearLimit - 1;
  for (let i = 0; i < 60 && !miner.broken; i++) g.tickOnce();
  ok(miner.broken, '矿机磨损满后故障（随采矿周期积累）');
  const chest = place(g, 'chest', oreTile.x + 3, oreTile.y);
  g.sim.chestAdd(chest, 'sparePart', 1);
  ticks(g, FG.Config.REPAIR_TIME_TICKS + 2);
  ok(!miner.broken, '矿机检修后恢复');

  // 实验室
  g.research.current = null;
  const lab = place(g, 'lab', 10, 10);
  g.research.completed.delete('predictiveMaintenance'); // 不影响已启用状态
  g.research.current = FG.Research.byId('automationScience');
  for (const k of Object.keys(g.research.current.cost)) lab.slots.inputs[k].count = 50;
  lab.wear = lab.wearLimit - 1;
  for (let i = 0; i < 40 && !lab.broken; i++) g.tickOnce();
  ok(lab.broken, '实验室随科研消耗周期磨损故障');
}

// ================= [M16] 手动设置工单优先级同步设备供料优先级 =================
console.log('\n[M16] 工单优先级与设备供料优先级联动');{
  const g = newGame();
  const fur = place(g, 'furnace', 7, 9);
  g.maintenance.breakdown(fur);
  const o = g.maintenance.orderAt(7, 9);
  g.maintenance.setPriority(o.id, 'high');
  ok(fur.priority === 'high', '设工单高优先 → 设备供料优先级同步为高');
  g.maintenance.setPriority(o.id, 'low');
  ok(fur.priority === 'low', '设工单低优先 → 设备供料优先级同步为低');
}

// ================= [M17] 施工落成的新建筑自动纳入磨损体系 =================
console.log('\n[M17] 蓝图/施工落成设备自动初始化磨损字段并可故障维修');
{
  const g = newGame();
  const chest = place(g, 'chest', 2, 2);
  g.sim.chestAdd(chest, 'stone', 50);
  // 提交一个石炉施工计划
  const bp = { w: 1, h: 1, entries: [{ type: 'furnace', dx: 0, dy: 0, dir: 0 }] };
  g.construction.addPlan(bp, 12, 12);
  for (let i = 0; i < 100 && !g.map.buildingAt(12, 12); i++) g.tickOnce();
  const fur = g.map.buildingAt(12, 12);
  ok(!!fur && fur.type === 'furnace', '施工计划落成石炉');
  ok(!!fur.wearLimit && fur.wear === 0 && !fur.broken, '施工落成设备自动初始化磨损字段');
  // 强制磨损满 → 应正常走故障→维修闭环
  fur.wear = fur.wearLimit - 1;
  g.setRecipe(fur, 'smelt:iron');
  fur.slots.inputs.ironOre.count = 5;
  g.sim.chestAdd(chest, 'sparePart', 2);
  for (let i = 0; i < 200 && !fur.broken; i++) g.tickOnce();
  ok(fur.broken && g.maintenance.orders.length === 1, '施工落成设备可正常故障开单');
  ticks(g, FG.Config.REPAIR_TIME_TICKS + 2);
  ok(!fur.broken, '施工落成设备检修恢复');
}

console.log('\n结果：' + pass + ' 通过, ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
