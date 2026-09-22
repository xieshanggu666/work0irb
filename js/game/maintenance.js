/**
 * FG.Maintenance —— 设备磨损与维修工单管理
 *
 * 玩法：生产设备（矿机/水泵/抽油机/熔炉/组装机/化工厂/炼油厂/实验室）随运转
 * 积累磨损（每完成一个生产周期 +WEAR_PER_CYCLE），磨损达到各自随机寿命后
 * 发生故障：立即停机并自动生成维修工单；工单按优先级从全图物流（箱子/地面堆）
 * 预留备件（sparePart），备件齐备后停机检修 REPAIR_TIME_TICKS 个 tick，
 * 检修完成消除磨损、设备恢复生产。
 *
 * 料权模型（与施工预留、合同锁付同一套语义：预留即移出物流）：
 *  - 工单每 tick 盘点全图自由备件为统一预算池，高优先级一层未取料前低层不分配，
 *    同级按轮转游标公平起步；预留的备件从箱子/地面堆实体移出，任何预算池
 *    （施工 MaterialPool、按需调度、机械臂）都盘点不到；
 *  - 取消工单（或拆除故障设备）：未消耗的预留备件返还物流（优先箱子，余下落到
 *    设备所在格地面堆），设备保持故障停机状态；
 *  - 检修只在备件齐备后才开始，备件不齐时设备停机等件，预留持续保留。
 *
 * 工单状态机：
 *   waiting  故障已登记：缺备件时按优先级从物流预留（waiting=true）；
 *            备件在同一 tick 齐备即转入停机检修（ready 仅为序列化中的过渡读态）
 *   repairing 停机检修中（倒计时；设备保持停机，不生产、不接料）
 *   done     检修完成：消耗备件、磨损清零、设备恢复（工单出列，留一条归档记录）
 *   canceled 取消工单（预留返还），设备仍故障 —— 可重新报修（存档续修）
 *
 * 升级衔接：
 *  - 设备正在升级（施工计划 upgrade 条目占位）时：waiting/ready 工单不占料
 *    （每 tick 释放预留）；若旧设备在升级落成瞬间仍故障，工单直接迁移到新建筑
 *    （坐标不变）并恢复备料检修 —— 设备与工单状态无缝衔接；
 *  - 升级条目落成替换会保留 b.wear/b.wearLimit/b.broken（原地替换不翻新设备）。
 *
 * 存档续修：
 *  - 每台设备的 wear/wearLimit/broken 与全部工单（含预留备件、检修计时、优先级、
 *    归档记录）随存档序列化，读档后继续备料/检修；无 maintenance 字段的旧档
 *    回退：已研究「预测性维护」的设备按当前磨损（缺省 0）继续积累，行为不变。
 *    故障状态以 broken 标记为准：旧档无该字段 → 不故障。
 */
FG.Maintenance = class Maintenance {
  constructor(game) {
    this.game = game;
    this.orders = [];      // 工单列表（waiting/ready/repairing；完成即出列）
    this.archived = [];    // 最近完成/取消的工单记录（存档续修可查，UI 用）
    this.seq = 1;
    this.enabled = false;  // 是否启用磨损（研究「预测性维护」后开启；读档按研究状态恢复）
    this.tierStart = { high: 0, normal: 0, low: 0 };
  }

  reset() {
    this.orders = [];
    this.archived = [];
    this.seq = 1;
    this.enabled = false;
    this.tierStart = { high: 0, normal: 0, low: 0 };
  }

  /** 研究完成时开启：全图设备补齐磨损寿命字段（不回溯磨损，从此刻起积累） */
  enable() {
    if (this.enabled) return;
    this.enabled = true;
    for (const b of this.game.map.buildings.values()) this.initWear(b);
    FG.Events.emit('maintenance:change');
  }

  /** 该建筑是否为会磨损的生产设备 */
  static wearsOut(b) {
    if (!b || !b.def) return false;
    return !!b.def.recipeBuilding || b.type === 'miner' || b.type === 'lab'
      || b.type === 'pump' || b.type === 'pumpjack';
  }

  wearsOut(b) { return FG.Maintenance.wearsOut(b); }

  /** 新落成/读入设备初始化磨损字段（已存在不覆盖） */
  initWear(b) {
    if (!this.wearsOut(b)) return;
    if (b.wearLimit === undefined || b.wearLimit === null) {
      b.wearLimit = FG.Config.WEAR_FAIL_MIN
        + Math.floor(Math.random() * (FG.Config.WEAR_FAIL_MAX - FG.Config.WEAR_FAIL_MIN + 1));
    }
    if (b.wear === undefined || b.wear === null) b.wear = 0;
    if (!b.broken) b.broken = false;
  }

  /** 磨损比例 0..1（无寿命字段返回 0） */
  wearRatio(b) {
    if (!this.wearsOut(b) || !b.wearLimit) return 0;
    return Math.max(0, Math.min(1, (b.wear || 0) / b.wearLimit));
  }

  /** 维修该类型设备需要的备件数（按设备等级递增） */
  sparesNeeded(b) {
    let tier = 0;
    if (b.type === 'steelFurnace' || b.type === 'assembler2' || b.type === 'pumpjack'
        || b.type === 'chemPlant' || b.type === 'refinery') tier = 1;
    return FG.Config.REPAIR_SPARES_BASE + tier * FG.Config.REPAIR_SPARES_PER_TIER;
  }

  /** 设备当前的有效工单（坐标匹配） */
  orderAt(x, y) {
    const k = FG.Utils.key(x, y);
    return this.orders.find(o => o.x === x && o.y === y && !o._detached) || null;
  }

  orderById(id) { return this.orders.find(o => o.id === id) || null; }

  /** 生产周期完成回调（由 sim 在矿机/配方建筑每次产出、实验室每次消耗时调用） */
  noteCycle(b) {
    if (!this.enabled || !this.wearsOut(b) || b.broken) return;
    this.initWear(b);
    b.wear += FG.Config.WEAR_PER_CYCLE;
    if (b.wear >= b.wearLimit) this.breakdown(b);
  }

  /** 设备故障：置停机标记并自动生成维修工单（默认普通优先级） */
  breakdown(b) {
    if (b.broken) return;
    b.broken = true;
    b.status = 'broken';
    // 已有坐标相同的工单（升级迁移竞态兜底）：不重复开单
    if (this.orderAt(b.x, b.y)) return;
    const need = this.sparesNeeded(b);
    const order = {
      id: 'W' + (this.seq++),
      x: b.x, y: b.y,
      name: (b.def.name || '设备') + ' 维修',
      priority: (b.priority && FG.Config.PRIORITIES[b.priority]) ? b.priority : 'normal',
      need,                    // 备件总需求
      stock: {},               // 已预留（移出物流）的备件 {sparePart:n}
      state: 'waiting',        // waiting | ready | repairing
      repairTimer: 0,          // 停机检修剩余 tick
      createdAt: this.game.playTime,
      waiting: false,          // UI: 缺件等待
      upgrading: false,        // UI: 设备升级中挂起（不占料）
    };
    this.orders.push(order);
    this.game.logMsg('🛠 ' + b.def.name + '（' + b.x + ',' + b.y + '）发生故障已停机：'
      + '维修工单「' + order.id + '」已生成，需备件×' + need + '（从物流按优先级预留）', 'error');
    FG.Events.emit('maintenance:breakdown', { b, order });
    FG.Events.emit('maintenance:change');
  }

  /** 手动/联动报修：设备已故障但工单被取消后重新开单（存档续修） */
  report(b) {
    if (!b || !this.wearsOut(b) || !b.broken) return false;
    if (this.orderAt(b.x, b.y)) return true;
    const need = this.sparesNeeded(b);
    const order = {
      id: 'W' + (this.seq++),
      x: b.x, y: b.y,
      name: (b.def.name || '设备') + ' 维修',
      priority: (b.priority && FG.Config.PRIORITIES[b.priority]) ? b.priority : 'normal',
      need, stock: {}, state: 'waiting', repairTimer: 0,
      createdAt: this.game.playTime, waiting: false, upgrading: false,
    };
    this.orders.push(order);
    FG.Events.emit('maintenance:change');
    return true;
  }

  setPriority(orderId, priority) {
    const o = this.orderById(orderId);
    if (!o || !MO_VALID_PRIORITIES[priority]) return false;
    o.priority = priority;
    const b = this.game.map.buildingAt(o.x, o.y);
    if (b) b.priority = priority;   // 设备供料优先级与工单优先级保持一致
    FG.Events.emit('maintenance:change');
    return true;
  }

  /** 取消工单：返还全部预留备件，设备保持故障（可重新报修） */
  cancel(orderId) {
    const i = this.orders.findIndex(o => o.id === orderId);
    if (i < 0) return false;
    const o = this.orders[i];
    this.releaseStock(o);
    this.orders.splice(i, 1);
    this.archived.unshift({
      id: o.id, name: o.name, x: o.x, y: o.y, state: 'canceled',
      at: this.game.playTime,
    });
    if (this.archived.length > 30) this.archived.length = 30;
    const b = this.game.map.buildingAt(o.x, o.y);
    if (b) b.status = 'broken';
    this.game.logMsg('已取消维修工单「' + o.id + '」：未用备件已返还物流，设备仍停机（可重新报修）', 'info');
    FG.Events.emit('maintenance:change');
    return true;
  }

  /** 设备被拆除：其工单预留备件落到该格地面堆（随拆除物料一并保留），工单出列 */
  onBuildingRemoved(b) {
    if (!this.wearsOut(b)) return;
    const o = this.orderAt(b.x, b.y);
    if (!o) return;
    const n = (o.stock && o.stock[SPARE]) || 0;
    if (n > 0) this.game.map.pileAdd(b.x, b.y, SPARE, n);
    o.stock = {};
    o._detached = true;
    const i = this.orders.indexOf(o);
    if (i >= 0) this.orders.splice(i, 1);
    this.archived.unshift({
      id: o.id, name: o.name, x: o.x, y: o.y, state: 'demolished',
      at: this.game.playTime,
    });
    if (this.archived.length > 30) this.archived.length = 30;
  }

  /**
   * 原地升级落成（Construction.swapEntry）后调用：工单迁移到新建筑。
   *  - 旧建筑故障且工单存在：坐标不变，工单直接挂到新建筑（备件需求按新型号重算，
   *    多预留的备件立即返还，不足部分继续按优先级预留）；新建筑保持故障停机；
   *  - 旧建筑磨损未故障：磨损状态由 swapEntry 物理迁移（b.wear 等字段复制），无工单需处理。
   */
  onUpgraded(oldB, newB) {
    const o = this.orderAt(newB.x, newB.y);
    if (!o) {
      // 无工单：确保新建筑磨损字段就位（swapEntry 已迁移则沿用）
      this.initWear(newB);
      return;
    }
    o.upgrading = false;
    const need = this.sparesNeeded(newB);
    const had = (o.stock[SPARE]) || 0;
    o.name = (newB.def.name || '设备') + ' 维修';
    if (o.state === 'repairing') {
      // 升级打断检修：退回备料就绪态，按新型号重新检修（设备已被替换为新对象）
      o.state = had >= need ? 'ready' : 'waiting';
      o.repairTimer = 0;
    } else {
      o.state = 'waiting';
    }
    o.need = need;
    if (had > need) {
      // 多预留的备件返还物流
      const extra = had - need;
      o.stock[SPARE] = need;
      this.refundToLogistics({ [SPARE]: extra }, newB.x, newB.y);
    }
    if (newB.broken) newB.status = 'broken';
    FG.Events.emit('maintenance:change');
  }

  // ================= 主循环 =================
  tick() {
    if (!this.enabled) return;
    // 设备可能在 tick 间隙被拆/被升级：对账工单与建筑状态
    for (let i = this.orders.length - 1; i >= 0; i--) {
      const o = this.orders[i];
      const b = this.game.map.buildingAt(o.x, o.y);
      if (!b || !this.wearsOut(b) || !b.broken) {
        // 建筑已不在（兜底，正常拆除走 onBuildingRemoved）：返还预留并出列
        if (o && (o.stock[SPARE] || 0) > 0) {
          const [x, y] = [o.x, o.y];
          this.refundToLogistics({ [SPARE]: o.stock[SPARE] }, x, y);
        }
        this.orders.splice(i, 1);
        continue;
      }
    }
    if (!this.orders.length) return;

    // 状态复位：升级挂起 / 检修中
    for (const o of this.orders) {
      o.waiting = false;
      o.upgrading = false;
      const b = this.game.map.buildingAt(o.x, o.y);
      // 升级衔接：该格有未完成的升级计划条目时，工单挂起、不占料
      const upEntry = this.game.construction && this.game.construction.entryAt(o.x, o.y);
      if (upEntry && upEntry.plan.kind === 'upgrade' && upEntry.entry.from) {
        o.upgrading = true;
        this.releaseStock(o);
        if (o.state === 'repairing') { o.state = 'waiting'; o.repairTimer = 0; }
        continue;
      }
      if (o.state === 'repairing') {
        o.repairTimer--;
        if (o.repairTimer <= 0) this.finishOrder(o, b);
        continue;
      }
    }

    // 剩余待备料/待开工的工单：统一备件池 × 优先级分层 × 同级轮转
    const pool = new SparePool(this.game);
    this.tierStart = { high: 0, normal: 0, low: 0 };
    const active = this.orders.filter(o => o.state !== 'repairing' && !o.upgrading
      && this.game.map.buildingAt(o.x, o.y));

    for (const tier of MO_TIERS) {
      const list = active.filter(o => o.priority === tier);
      if (!list.length) continue;
      const start = this.tierStart[tier] % list.length;
      for (let n = 0; n < list.length; n++) {
        const o = list[(start + n) % list.length];
        this.processOrder(o, pool);
      }
    }
    if (this._changed) { this._changed = false; FG.Events.emit('maintenance:change'); }
  }

  /** 推进单个工单：预留缺口备件 → 齐备转 ready → ready 轮转开工检修 */
  processOrder(o, pool) {
    const b = this.game.map.buildingAt(o.x, o.y);
    if (!b) return;
    const have = o.stock[SPARE] || 0;
    if (have < o.need) {
      const got = pool.take(SPARE, o.need - have);
      if (got > 0) {
        o.stock[SPARE] = have + got;
        this._changed = true;
      }
      if ((o.stock[SPARE] || 0) < o.need) { o.state = 'waiting'; o.waiting = true; return; }
    }
    // 备件齐备：同一 tick 即进入停机检修（各工单独立倒计时，互不阻塞）
    o.state = 'repairing';
    o.repairTimer = FG.Config.REPAIR_TIME_TICKS;
    this._changed = true;
  }

  /** 检修完成：消耗备件、磨损清零、设备恢复生产 */
  finishOrder(o, b) {
    const used = Math.min(o.need, o.stock[SPARE] || 0);
    o.stock[SPARE] = (o.stock[SPARE] || 0) - used;
    if ((o.stock[SPARE] || 0) <= 0) delete o.stock[SPARE];
    b.wear = 0;
    // 检修后换新寿命（重新随机一个寿命周期）
    b.wearLimit = FG.Config.WEAR_FAIL_MIN
      + Math.floor(Math.random() * (FG.Config.WEAR_FAIL_MAX - FG.Config.WEAR_FAIL_MIN + 1));
    b.broken = false;
    b.status = 'idle';
    const i = this.orders.indexOf(o);
    if (i >= 0) this.orders.splice(i, 1);
    this.archived.unshift({
      id: o.id, name: o.name, x: o.x, y: o.y, state: 'done',
      at: this.game.playTime,
    });
    if (this.archived.length > 30) this.archived.length = 30;
    this.game.logMsg('✅ 维修工单「' + o.id + '」完成：' + b.def.name + '（' + b.x + ',' + b.y
      + '）已更换备件×' + used + '，磨损清零，恢复生产', 'unlock');
    FG.Events.emit('maintenance:repaired', { b, order: o });
    FG.Events.emit('maintenance:change');
  }

  // ================= 预留释放 / 返还 =================
  releaseStock(o) {
    const n = (o.stock && o.stock[SPARE]) || 0;
    if (n <= 0) { o.stock = {}; return; }
    this.refundToLogistics({ [SPARE]: n }, o.x, o.y);
    o.stock = {};
    this._changed = true;
  }

  /** 把备件返还物流：优先放回箱子，放不下的落到 (x,y) 地面堆 */
  refundToLogistics(stock, x, y) {
    for (const item of Object.keys(stock)) {
      let left = stock[item];
      if (left <= 0) { delete stock[item]; continue; }
      for (const b of this.game.map.buildings.values()) {
        if (left <= 0) break;
        if (b.type === 'chest') left = this.game.tryChestAdd(b, item, left);
      }
      if (left > 0) this.game.map.pileAdd(x, y, item, left);
      delete stock[item];
    }
  }

  // ================= 存档（工单/预留/磨损随档恢复，支持续修） =================
  serialize() {
    return {
      seq: this.seq,
      enabled: !!this.enabled,
      orders: this.orders.map(o => ({
        id: o.id, x: o.x, y: o.y, name: o.name, priority: o.priority,
        need: o.need, stock: Object.assign({}, o.stock),
        state: o.state, repairTimer: o.repairTimer || 0,
        createdAt: o.createdAt || 0,
      })),
      archived: this.archived.slice(0, 30).map(a => Object.assign({}, a)),
    };
  }

  deserialize(data) {
    this.reset();
    // 启用状态以科技研究为准（旧档无 maintenance 字段：研究过则补开启）
    this.enabled = !!(data && data.enabled)
      || !!(this.game.research && this.game.research.completed.has('predictiveMaintenance'));
    if (!data) {
      if (this.enabled) for (const b of this.game.map.buildings.values()) this.initWear(b);
      return;
    }
    this.seq = data.seq || 1;
    // 先为全图设备补齐磨损字段（读取建筑 wear/broken 字段之后再补寿命）
    for (const b of this.game.map.buildings.values()) this.initWear(b);
    for (const so of (data.orders || [])) {
      const b = this.game.map.buildingAt(so.x, so.y);
      // 设备已不存在 → 预留备件落到该格地面堆（不丢料），工单不恢复
      const stock = (so.stock && so.stock[SPARE]) ? { [SPARE]: so.stock[SPARE] } : {};
      if (!b || !this.wearsOut(b)) {
        if (stock[SPARE]) this.game.map.pileAdd(so.x, so.y, SPARE, stock[SPARE]);
        continue;
      }
      b.broken = true;
      b.status = 'broken';
      const need = this.sparesNeeded(b);
      const order = {
        id: so.id || ('W' + (this.seq++)),
        x: so.x, y: so.y,
        name: so.name || (b.def.name + ' 维修'),
        priority: MO_VALID_PRIORITIES[so.priority] ? so.priority : 'normal',
        need: Math.max(need, so.need | 0 || need),
        stock,
        state: 'waiting',
        repairTimer: 0,
        createdAt: so.createdAt || 0,
        waiting: false,
        upgrading: false,
      };
      // 检修中读档：退回 ready/waiting 重新判定（无瞬时完成，避免读档即修好）
      if ((so.state === 'ready' || so.state === 'repairing') && (stock[SPARE] || 0) >= order.need) {
        order.state = 'ready';
      }
      // 预留多于新型号需求：多出部分返还
      if ((stock[SPARE] || 0) > order.need) {
        const extra = stock[SPARE] - order.need;
        stock[SPARE] = order.need;
        this.refundToLogistics({ [SPARE]: extra }, so.x, so.y);
      }
      this.orders.push(order);
    }
    this.archived = Array.isArray(data.archived) ? data.archived.slice(0, 30) : [];
  }
};

const MO_TIERS = ['high', 'normal', 'low'];
const MO_VALID_PRIORITIES = { high: 1, normal: 1, low: 1 };
const SPARE = 'sparePart';

/**
 * 维修备件预算池：每 tick 盘点全图自由备件（箱子→地面堆）。
 * 与施工 MaterialPool 同口径：取料即实体移出，被维修预留的备件
 * 不在任何箱子/地面堆中，施工池与按需调度天然盘点不到（无双重计数）。
 */
class SparePool {
  constructor(game) {
    this.game = game;
    this.free = 0;
    this.chests = [];
    for (const b of game.map.buildings.values()) {
      if (!b.def.storage) continue;
      this.chests.push(b);
      for (const s of b.chest) if (s.type === SPARE && s.count > 0) this.free += s.count;
    }
    this.piles = [];
    for (const [k, pile] of game.map.piles) {
      for (const s of pile) if (s.type === SPARE && s.count > 0) {
        this.free += s.count;
        this.piles.push([k, pile]);
      }
    }
  }

  available() { return this.free; }

  /** 取走至多 n 件备件（箱子优先，不足再取地面堆），返回实际取得数 */
  take(item, n) {
    let left = Math.min(n, this.free);
    if (left <= 0) return 0;
    const got = left;
    for (const b of this.chests) {
      if (left <= 0) break;
      for (const s of b.chest) {
        if (left <= 0) break;
        if (s.type === item && s.count > 0) {
          const take = Math.min(left, s.count);
          s.count -= take;
          left -= take;
        }
      }
    }
    if (left > 0) {
      for (const [k, pile] of this.piles) {
        if (left <= 0) break;
        const s = pile.find(x => x.type === item && x.count > 0);
        if (!s) continue;
        const take = Math.min(left, s.count);
        s.count -= take;
        left -= take;
        if (s.count <= 0) pile.splice(pile.indexOf(s), 1);
      }
      for (const [k, pile] of this.piles) {
        if (!pile.length) this.game.map.piles.delete(k);
      }
    }
    this.free -= got;
    return got;
  }
}
