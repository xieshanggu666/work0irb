/**
 * FG.Railway —— 铁路货运系统：轨网、闭塞分区预留、列车调度与运输计划
 *
 * 模型（区间预留 + 拥堵绕行）：
 *  - 轨格图：轨道(rail)与火车站(station/deliveryStation)即图节点，四邻相连；机务段(trainDepot)
 *    不进图，只作为发车点（必须邻接轨格）。轨网增删建筑后标记 dirty，下一 tick 重建。
 *  - 闭塞分区（block）：
 *      · 道岔/交叉口（轨格度数 ≠ 2，即尽头或 3/4 岔）与尽头站是「节点边界」，各自独立成
 *        单格道岔分区（junction block）；
 *      · 两个边界之间的连续度数 2 轨格合并为一条「区间分区」（arm block，单线区段）；
 *      · 闭环轨道（无边界）退化为一条 open 区间，门常开（单线死环属布局问题，标红提示）。
 *  - 区间预留（reserve）：列车每 tick 沿计划路径前瞻预留 TRAIN_LOOKAHEAD 格。
 *      · 跨入「区间分区」前先申请该分区的通行门（gate）：
 *        同向行驶的前车不关门（可在其后排队跟进，保持跟驰），对向（会车）或静止堵头
 *        （停靠/停运/待命/堵死）关门——列车在门外（道岔或上一区间末端）等待，绝不顶进单线
 *        区段后再顶住，天然支持「单线会车等待」；
 *      · 道岔/交叉口是独立分区，任何格只要被他人占用或预占即不可再预留——
 *        抢不到交叉口的列车在自己一侧的信号机外等待，交叉口保持清空，对向/垂直方向可通过；
 *      · 各方向按轮转游标 moverSeq 公平申请门与交叉口，任一方向不会被饿死。
 *  - 拥堵绕行：寻路使用加权 Dijkstra，区内有车/会车门关闭 → 高代价（PENALTY_TRAIN），
 *    道岔被预占 → 中代价（PENALTY_JUNC）。当直线最短路径拥堵而存在并行复线/会车侧线时，
 *    列车自动选绕行路径；每 TRAIN_REROUTE_TICKS 或门状态变化时重寻路。完全无路 → noroute；
 *    有路但所有路径都堵在会车门外 → meeting（会车等待）；同向前车停站 → waiting（等站）。
 *  - 占用权（occupy）：列车车头实际占有格（跨格动画期间为跨入的新格），用于拆除保护、
 *    渲染与货物落地；reserve 是计划占用（每 tick 重算），occupy 是物理事实。
 *  - 占用释放：停运 / 解编 / 改计划（增删站点、跳过、改循环、装卸动作）/ 拆轨（图重建）
 *    都会立即或在下一 tick 收回到「仅车头」的预留，释放被锁的区间与交叉口；
 *    占用表在解编时按 id 全量清除，不留幽灵条目。
 *  - 堵死：真正无路可退（如无侧线单线两端同时有车、死胡同）才标 blocked（红色）提示改线。
 *  - 存档：reserve 不序列化（每 tick 由路径重建），只存列车/计划/占用事实；读档后占用表
 *    由列车位置重建、跨格中途吸附回落定格（moveTimer 清零、重新寻路与预留），
 *    兼容无铁路字段、无预留概念的旧存档；同格多车自动疏散。
 */
FG.Railway = class Railway {
  constructor(game) {
    this.game = game;
    this.trains = [];
    this.occupy = new Map();     // 'x,y' -> trainId（车头物理占有格）
    this.reserve = new Map();    // 'x,y' -> trainId（前瞻预留格）
    this.nodes = new Set();      // 轨格 key（轨道 + 火车站）
    this.deg = new Map();        // 'x,y' -> 轨格度数
    this.blockOf = new Map();    // 'x,y' -> blockId
    this.blocks = new Map();     // blockId -> { id, keys:Set, open, junction }
    this.stationMap = new Map(); // stationId -> 站建筑
    this.graphDirty = true;
    this.moverSeq = 0;           // 交叉口/区间门同级轮转游标
    this.trainSeq = 1;
    this.stationSeq = 1;
  }

  reset() {
    this.trains = [];
    this.occupy.clear();
    this.reserve.clear();
    this.nodes.clear();
    this.deg.clear();
    this.blockOf.clear();
    this.blocks.clear();
    this.stationMap.clear();
    this.graphDirty = true;
    this.moverSeq = 0;
    this.trainSeq = 1;
    this.stationSeq = 1;
  }

  markDirty() { this.graphDirty = true; }

  // ================= 轨网与闭塞分区 =================
  isRailTile(x, y) {
    const b = this.game.map.buildingAt(x, y);
    return !!b && (b.type === 'rail' || !!b.def.railStation);
  }

  rebuildGraph() {
    this.nodes.clear();
    this.deg.clear();
    this.stationMap.clear();
    for (const b of this.game.map.buildings.values()) {
      if (b.type === 'rail' || b.def.railStation) {
        const k = FG.Utils.key(b.x, b.y);
        this.nodes.add(k);
        if (b.def.railStation) {
          if (!b.stationId) b.stationId = 'S' + (this.stationSeq++);
          if (!b.stationName) b.stationName = '站点 ' + b.stationId.slice(1);
          this.stationMap.set(b.stationId, b);
        }
      }
    }
    for (const k of this.nodes) {
      const [x, y] = k.split(',').map(Number);
      let d = 0;
      for (let i = 0; i < 4; i++) {
        const v = FG.Utils.dirVec(i);
        if (this.nodes.has(FG.Utils.key(x + v.x, y + v.y))) d++;
      }
      this.deg.set(k, d);
    }
    this.rebuildBlocks();
    // 图变更后缓存路径全部作废：经过已拆除轨格的列车下一 tick 重新寻路（断路自愈）；
    // 预留也全部作废，由各车按新车体位置重新预留（拆轨即释放区间/交叉口）
    for (const tr of this.trains) { tr.path = null; tr.rerouteCd = 0; }
    this.reserve.clear();
    this.graphDirty = false;
  }

  /**
   * 划分闭塞分区：
   *  度数 2 的轨格按连通边合并为区间分区（arm）；度数 ≠ 2（尽头/道岔/交叉口）各自独立成
   *  道岔分区（junction）。合并结果若无任何边界节点（纯闭环），整条标 open（门常开）。
   */
  rebuildBlocks() {
    this.blockOf.clear();
    this.blocks.clear();
    const parent = new Map();
    const find = (k) => {
      let r = k;
      while (parent.get(r) !== r) r = parent.get(r);
      while (parent.get(k) !== r) { const p = parent.get(k); parent.set(k, r); k = p; }
      return r;
    };
    const union = (a, b) => {
      const ra = find(a), rb = find(b);
      if (ra !== rb) parent.set(rb, ra);
    };
    for (const k of this.nodes) {
      if (this.deg.get(k) === 2) parent.set(k, k);
    }
    for (const k of this.nodes) {
      if (this.deg.get(k) !== 2) continue;
      const [x, y] = k.split(',').map(Number);
      for (let d = 0; d < 4; d++) {
        const v = FG.Utils.dirVec(d);
        const nk = FG.Utils.key(x + v.x, y + v.y);
        if (this.nodes.has(nk) && this.deg.get(nk) === 2) union(k, nk);
      }
    }
    const groups = new Map(); // root -> keys[]
    for (const k of this.nodes) {
      if (this.deg.get(k) !== 2) continue;
      const r = find(k);
      if (!groups.has(r)) groups.set(r, []);
      groups.get(r).push(k);
    }
    let seq = 0;
    const make = (keys, junction) => {
      const id = 'B' + (seq++);
      const set = new Set(keys);
      this.blocks.set(id, { id, keys: set, open: false, junction });
      for (const k of keys) this.blockOf.set(k, id);
      return id;
    };
    // 区间分区：含边界节点（尽头/道岔）相接者正常关门；纯闭环（无边界）门常开
    for (const keys of groups.values()) {
      let touchesBoundary = false;
      for (const k of keys) {
        const [x, y] = k.split(',').map(Number);
        for (let d = 0; d < 4; d++) {
          const v = FG.Utils.dirVec(d);
          const nk = FG.Utils.key(x + v.x, y + v.y);
          if (this.nodes.has(nk) && this.deg.get(nk) !== 2) { touchesBoundary = true; break; }
        }
        if (touchesBoundary) break;
      }
      const id = make(keys, false);
      this.blocks.get(id).open = !touchesBoundary;
    }
    // 道岔/交叉口/尽头：单格独立分区
    for (const k of this.nodes) {
      if (this.deg.get(k) !== 2) make([k], true);
    }
  }

  blockAtKey(k) {
    const id = this.blockOf.get(k);
    return id ? this.blocks.get(id) : null;
  }

  blockAt(x, y) { return this.blockAtKey(FG.Utils.key(x, y)); }

  stationById(id) {
    if (this.graphDirty) this.rebuildGraph();
    return this.stationMap.get(id) || null;
  }

  stationList() {
    if (this.graphDirty) this.rebuildGraph();
    return Array.from(this.stationMap.values());
  }

  trainById(id) { return this.trains.find(t => t.id === id) || null; }
  trainAt(x, y) {
    const id = this.occupy.get(FG.Utils.key(x, y));
    return id ? this.trainById(id) : null;
  }

  /** 列车当前物理占有格（跨格中途为已移交的新格） */
  authorityKey(tr) {
    for (const [k, id] of this.occupy) if (id === tr.id) return k;
    return FG.Utils.key(tr.x, tr.y);
  }

  // ================= 寻路（加权 Dijkstra：拥堵/会车绕行） =================
  /**
   * 加权寻路：返回从起点（不含）到目标格（含）的格坐标数组；无路返回 null。
   * 代价 = 距离 1 + 占用/预留拥堵代价：
   *   · 进入区间分区而会车门关闭（对向/堵头）→ PENALTY_TRAIN（强烈绕行）
   *   · 道岔/交叉口已被他人占用或预占 → PENALTY_JUNC（垂直争用避让）
   *   · 普通格被同向车占用/预占 → PENALTY_TRAIN（堵在队尾，无路绕时仍可排队）
   * 目标站格永远只计基础代价（终点站本身允许在其上排队/停靠）。
   */
  findPath(self, sx, sy, tx, ty) {
    if (this.graphDirty) this.rebuildGraph();
    const tk = FG.Utils.key(tx, ty);
    if (!this.nodes.has(tk)) return null;
    const sk = FG.Utils.key(sx, sy);
    if (sk === tk) return [];
    const dist = new Map([[sk, 0]]);
    const prev = new Map([[sk, null]]);
    const done = new Set();
    // 简单优先队列：轨网规模不大，用有序数组（按 dist 插入）足够
    const queue = [sk];
    while (queue.length) {
      const cur = queue.shift();
      if (cur === tk) break;
      if (done.has(cur)) continue;
      done.add(cur);
      const [cx, cy] = cur.split(',').map(Number);
      for (let d = 0; d < 4; d++) {
        const v = FG.Utils.dirVec(d);
        const nx = cx + v.x, ny = cy + v.y;
        const nk = FG.Utils.key(nx, ny);
        if (!this.nodes.has(nk) || done.has(nk)) continue;
        let w = 1;
        if (nk !== tk) w += this.enterCost(self, cur, nk);
        const nd = dist.get(cur) + w;
        if (!dist.has(nk) || nd < dist.get(nk)) {
          dist.set(nk, nd);
          prev.set(nk, cur);
          // 有序插入
          let lo = 0, hi = queue.length;
          while (lo < hi) { const mid = (lo + hi) >> 1; if (dist.get(queue[mid]) <= nd) lo = mid + 1; else hi = mid; }
          queue.splice(lo, 0, nk);
        }
      }
    }
    if (!prev.has(tk)) return null;
    const path = [];
    let k = tk;
    while (k !== sk) {
      const [x, y] = k.split(',').map(Number);
      path.unshift({ x, y });
      k = prev.get(k);
    }
    return path;
  }

  /** 列车 self 从 fromKey 进入 tileKey 的附加拥堵代价 */
  enterCost(self, fromKey, tileKey) {
    const blk = this.blockAtKey(tileKey);
    if (blk) {
      // 跨入新区间分区：会车门关闭则高代价（绕行复线/侧线）
      if (this.blockOf.get(fromKey) !== blk.id && this.gateClosed(self, blk, tileKey, fromKey)) {
        return FG.Config.TRAIN_PENALTY_TRAIN;
      }
      // 道岔/交叉口：已被他人占用或预占则中代价（让垂直/对向先过）
      if (blk.junction && this.tileHeldByOther(tileKey, self)) {
        return FG.Config.TRAIN_PENALTY_JUNC;
      }
    }
    // 普通格被他人占用/预占（同向队尾）：高代价但仍可达（无路绕时排队）
    if (this.tileHeldByOther(tileKey, self)) return FG.Config.TRAIN_PENALTY_TRAIN;
    return 0;
  }

  tileHeldByOther(k, self) {
    const o = this.occupy.get(k);
    if (o && o !== self.id) return this.trainById(o);
    const r = this.reserve.get(k);
    if (r && r !== self.id) return this.trainById(r);
    return null;
  }

  /**
   * 区间分区通行门是否对 self 关闭（从 fromKey 经 entryKey 进入）：
   *  open 分区（纯闭环）门常开、道岔单格分区不查门（由格预留互斥处理）。
   *  对每一辆与该分区相关的列车（车头在区内，或车头紧临界外、正前方格朝区内）：
   *   · 朝向点积<0 且对向正在行驶/会车/等站 → 关门（信号机外会车等待，不顶进单线）；
   *   · 朝向点积<0 的静止堵头（停靠/停运/待命/堵死）：车头在区间内部才关门；
   *     若它只在边界尽头格上朝区内（如尽头站已完成任务的车头朝界外），允许同向后车
   *     进入尽头站排队，不把整条区间永久锁死；
   *   · 点积≥0（同向/垂直）不关门，同向跟驰由逐格预留保证不追尾。
   */
  gateClosed(self, blk, entryKey, fromKey) {
    if (!blk || blk.open || blk.junction) return false;
    const ev = this.entryVec(entryKey, fromKey); // 本车进入方向（沿行进方向）
    for (const other of this.trains) {
      if (other === self || other._dead) continue;
      const ov = FG.Utils.dirVec(other.dir);
      const headK = FG.Utils.key(other.x, other.y);
      const frontK = FG.Utils.key(other.x + ov.x, other.y + ov.y);
      const headIn = blk.keys.has(headK);
      const facesBlock = headIn || blk.keys.has(frontK);
      if (!facesBlock) continue;
      const dot = ov.x * ev.x + ov.y * ev.y;
      if (dot >= 0) continue; // 同向/垂直：不关门（同向跟驰由逐格预留保证间距）
      const moving = other.state === 'moving' || other.state === 'meeting' || other.state === 'waiting';
      if (moving) return true; // 对向行驶/会车等待中的来车 → 关门
      // 静止堵头（停靠/停运/待命/堵死）：车头在区间内部 → 关门；
      // 仅在边界尽头格上朝区内（headIn=false）时允许后车进入尽头站排队，
      // 不把整条区间永久锁死
      if (headIn) return true;
    }
    return false;
  }

  /** 沿 from→entry 的单位向量（进门方向） */
  entryVec(entryKey, fromKey) {
    const [ex, ey] = entryKey.split(',').map(Number);
    const [fx, fy] = fromKey.split(',').map(Number);
    return { x: Math.sign(ex - fx), y: Math.sign(ey - fy) };
  }

  // ================= 预留（每 tick 同步） =================
  /**
   * 沿 activePath 前瞻重建本车预留集合：
   *  起点恒含物理占有格；之后逐格加入，遇「他人占用/预占」停止；
   *  跨入区间分区前先查会车门——门关闭时连门后第一格（道岔/交叉口）都不预留，
   *  列车停在自己一侧，交叉口保持清空，对向/垂直方向可通过。
   *  返回停止原因：null（一路畅通）、'tile'（格被占）、'gate'（会车门关）。
   */
  syncReserve(tr, activePath, checkGate) {
    if (checkGate === undefined) checkGate = true;
    if (!tr.reserve) tr.reserve = new Set();
    tr.reserve.clear();
    tr.reserve.add(this.authorityKey(tr));
    tr._gateBlock = null; // 本次前瞻被关闭的会车门所在区间（死锁判定用）
    // 停运/待命/无计划：只保留车头占有格，释放全部前瞻区间
    if (tr.plan.paused || (!activePath || !activePath.length)) {
      this.commitReserve(tr);
      return null;
    }
    let cur = this.authorityKey(tr);
    let reason = null;
    for (let i = 0; i < activePath.length && i < FG.Config.TRAIN_LOOKAHEAD; i++) {
      const step = activePath[i];
      const nk = FG.Utils.key(step.x, step.y);
      // 物理占用/他人预留冲突
      const holderId = this.occupy.get(nk) || this.reserve.get(nk);
      if (holderId && holderId !== tr.id) {
        reason = 'tile';
        // 记录冲突双方共处的区间分区（对顶死锁判定）：优先取堵占者车头所在分区
        const holder = this.trainById(holderId);
        if (holder) {
          const hb = this.blockAtKey(FG.Utils.key(holder.x, holder.y))
            || this.blockAtKey(nk);
          if (hb && !hb.junction) tr._gateBlock = hb;
        }
        break;
      }
      const blk = this.blockAtKey(nk);
      // 跨入区间分区前查会车门
      if (checkGate && blk && !blk.junction
          && this.blockOf.get(cur) !== blk.id && this.gateClosed(tr, blk, nk, cur)) {
        reason = 'gate';
        tr._gateBlock = blk;
        break;
      }
      // 跨入道岔/交叉口：必须确认穿过它后进入的下一区间门是开的，否则连交叉口都不预留
      //（车停在自己一侧，交叉口保持清空，对向/垂直方向可正常通过）
      if (checkGate && blk && blk.junction && i + 1 < activePath.length) {
        const beyond = activePath[i + 1];
        const bk = FG.Utils.key(beyond.x, beyond.y);
        const bBlk = this.blockAtKey(bk);
        if (bBlk && !bBlk.junction && this.gateClosed(tr, bBlk, bk, nk)) {
          reason = 'gate';
          tr._gateBlock = bBlk;
          break;
        }
      }
      tr.reserve.add(nk);
      cur = nk;
    }
    this.commitReserve(tr);
    return reason;
  }

  /** 把 tr.reserve 提交到全局预留索引（清除本车旧条目后写入） */
  commitReserve(tr) {
    for (const [k, id] of this.reserve) if (id === tr.id && !tr.reserve.has(k)) this.reserve.delete(k);
    for (const k of tr.reserve) {
      const id = this.reserve.get(k);
      if (!id || id === tr.id) this.reserve.set(k, tr.id);
    }
  }

  /** 收回某车全部前瞻预留（仅保留车头物理占有格）；停运/改计划/图重建时调用 */
  releaseReserve(tr) {
    if (tr.reserve) {
      const keep = this.authorityKey(tr);
      for (const k of tr.reserve) if (k !== keep) this.reserve.delete(k);
      tr.reserve = new Set([keep]);
    }
  }

  // ================= 主循环（两阶段：先公平预留，再按预留行驶） =================
  tick() {
    if (this.graphDirty) this.rebuildGraph();
    const n = this.trains.length;
    if (!n) return;
    const start = this.moverSeq % n;
    const order = [];
    for (let i = 0; i < n; i++) order.push((start + i) % n);

    // 阶段一：按轮转顺序同步预留（后申请者看到先申请者的预留 → 公平、无饿死）
    for (const idx of order) {
      const tr = this.trains[idx];
      if (!tr || tr._dead) continue;
      tr.prepare(this);
    }
    // 阶段二：按同样顺序行驶（只能驶入已预留格）；成功跨过道岔/交叉口者轮转游标推到其后
    for (const idx of order) {
      const tr = this.trains[idx];
      if (!tr || tr._dead) continue;
      const crossedJunction = tr.tick(this);
      if (crossedJunction) this.moverSeq = (idx + 1) % n;
    }
    for (let i = this.trains.length - 1; i >= 0; i--) if (this.trains[i]._dead) this.trains.splice(i, 1);
  }

  // ================= 发车 / 解编 =================
  /** 在机务段相邻的空轨格上发一列新车（无运输计划，处于待命），返回新车或 null */
  spawnTrain(depot) {
    if (this.graphDirty) this.rebuildGraph();
    for (let d = 0; d < 4; d++) {
      const v = FG.Utils.dirVec(d);
      const x = depot.x + v.x, y = depot.y + v.y;
      const k = FG.Utils.key(x, y);
      if (!this.nodes.has(k)) continue;
      if (this.occupy.has(k) || this.reserve.get(k)) continue;
      const tr = new FG.Train('T' + (this.trainSeq++), x, y, d);
      this.trains.push(tr);
      this.occupy.set(k, tr.id);
      tr.reserve = new Set([k]);
      this.reserve.set(k, tr.id);
      return tr;
    }
    return null;
  }

  removeTrain(tr) {
    // 跨格中途（占用权已移交到新格、车体仍在旧格）时 occupy 里的条目不在 tr.x/tr.y：
    // 按 id 清掉该车的全部占用与预留条目，否则会留下幽灵占用/幽灵区间锁
    for (const [k, id] of this.occupy) if (id === tr.id) this.occupy.delete(k);
    for (const [k, id] of this.reserve) if (id === tr.id) this.reserve.delete(k);
    if (tr.reserve) tr.reserve.clear();
    tr._dead = true;
  }

  /** 某轨格/站格是否被列车物理占用（拆除保护） */
  occupiedBy(x, y) { return this.occupy.get(FG.Utils.key(x, y)) || null; }
  /** 某轨格/站格是否被列车前瞻预留（拆除提示/渲染用） */
  reservedBy(x, y) { return this.reserve.get(FG.Utils.key(x, y)) || null; }

  /** 限频日志（每列车每类提示冷却） */
  logOnce(tr, key, text, cls) {
    const k = tr.id + ':' + key;
    if (this._lastLog && this._lastLog[k] === this.game.tickCount) return;
    this._lastLog = this._lastLog || {};
    this._lastLog[k] = this.game.tickCount;
    this.game.logMsg(text, cls || 'info');
  }

  // ================= 存档 =================
  serialize() {
    return {
      trainSeq: this.trainSeq, stationSeq: this.stationSeq, moverSeq: this.moverSeq,
      trains: this.trains.map(t => ({
        id: t.id, x: t.x, y: t.y, dir: t.dir,
        cargo: t.cargo.map(s => ({ type: s.type, count: s.count })),
        stops: t.plan.stops.map(s => ({
          stationId: s.stationId, action: s.action, item: s.item || null, count: s.count,
        })),
        loop: t.plan.loop !== false,
        stopIdx: t.stopIdx, paused: !!t.plan.paused,
        state: t.state, dwell: t.dwell || 0, rem: t.work ? t.work.rem : null,
        cooldown: t.leaveCooldown || 0, clearing: !!t.clearing, moveTimer: t.moveTimer || 0,
      })),
    };
  }

  deserialize(data) {
    this.reset();
    if (!data) return;
    this.trainSeq = data.trainSeq || 1;
    this.stationSeq = data.stationSeq || 1;
    this.moverSeq = data.moverSeq || 0;
    this.rebuildGraph(); // 先建站号映射与分区，供停靠状态恢复校验
    for (const st of (data.trains || [])) {
      const tr = new FG.Train(st.id, st.x, st.y, st.dir || 0);
      tr.cargo = (st.cargo || []).map(s => ({ type: s.type, count: s.count }));
      tr.plan = {
        paused: !!st.paused,
        loop: st.loop !== false,
        stops: (st.stops || []).map(s => ({
          stationId: s.stationId,
          action: s.action === 'load' ? 'load' : 'unload',
          item: s.item || null, count: s.count || 0,
        })),
      };
      tr.stopIdx = st.stopIdx || 0;
      const dockedStop = tr.plan.stops[tr.stopIdx];
      const dockedSt = dockedStop ? this.stationMap.get(dockedStop.stationId) : null;
      if (st.state === 'docked' && dockedSt && dockedSt.x === tr.x && dockedSt.y === tr.y) {
        tr.state = 'docked';
        tr.dwell = st.dwell || 0;
        tr.work = { rem: st.rem != null ? st.rem : (dockedStop.count || 0) };
      } else if (['idle', 'paused', 'blocked', 'waiting', 'meeting', 'noroute'].includes(st.state)) {
        tr.state = st.state;
      } else {
        tr.state = 'moving';
      }
      tr.leaveCooldown = st.cooldown || 0;
      tr.clearing = !!st.clearing;
      // 占用表只以车体当前格为准重建：存档时列车可能正处在跨格中途
      //（moveTimer>0，占用权已在新格、车体仍在旧格），该半格状态无法随档恢复，
      // 统一吸附回已落定格（moveTimer 清零、path 与前瞻预留作废、重新寻路预留），
      // 否则残留的跨格计时会让列车在没有占用权的情况下凭空走入新格，与后车重叠
      tr.moveTimer = 0;
      tr.path = null;
      tr.reserve = null; // 由下一 tick 的 syncReserve 按新车体位置重建（旧档无预留概念也兼容）
      this.trains.push(tr);
      const k = FG.Utils.key(tr.x, tr.y);
      if (this.occupy.has(k)) {
        // 异常/损坏存档中同格出现多车：后读入的车挪到相邻空闲轨格，绝不重建出重叠占用
        const alt = this.freeNeighbor(tr.x, tr.y);
        if (alt) { tr.x = alt.x; tr.y = alt.y; tr.px = alt.x; tr.py = alt.y; }
      }
      this.occupy.set(FG.Utils.key(tr.x, tr.y), tr.id);
    }
  }

  /** (x,y) 相邻的空闲轨格（读档修复异常重叠用），找不到返回 null */
  freeNeighbor(x, y) {
    for (let d = 0; d < 4; d++) {
      const v = FG.Utils.dirVec(d);
      const nx = x + v.x, ny = y + v.y;
      const nk = FG.Utils.key(nx, ny);
      if (this.nodes.has(nk) && !this.occupy.has(nk) && !this.reserve.get(nk)) {
        return { x: nx, y: ny };
      }
    }
    return null;
  }
};

/**
 * FG.Train —— 列车运行时实体（单节机车，混堆载货 TRAIN_CARGO_CAP 件）
 * 状态机：idle 待命 → moving 行驶 → docked 装卸 → moving（循环下一站）；
 *   waiting 等站排队（同向前车停站）、meeting 会车等待（单线区间门关闭）、
 *   blocked 堵死（无侧线可绕的对向/死胡同）、noroute 断路、paused 已停运。
 */
FG.Train = class Train {
  constructor(id, x, y, dir) {
    this.isTrain = true;
    this.id = id;
    this.x = x; this.y = y;       // 车头（列车）当前占据格
    this.px = x; this.py = y;     // 上一格（渲染插值）
    this.dir = dir;
    this.cargo = [];             // [{type,count}]
    this.plan = { paused: false, stops: [], loop: true };
    this.stopIdx = 0;
    this.state = 'idle';
    this.path = null;            // 待行驶格（不含当前格）
    this.reserve = null;         // Set<'x,y'> 本车前瞻预留（由 railway.syncReserve 维护）
    this.moveTimer = 0;          // 跨入下一格剩余 tick
    this.dwell = 0;              // 已停站 tick
    this.work = null;            // {rem} 当前停站动作剩余件数
    this.leaveCooldown = 0;      // 离站冷却：>0 时禁止在当前站重新停靠（先驶离）
    this.clearing = false;      // 单程末站清道中（驶离后转待命）
    this.rerouteCd = 0;         // 拥堵重寻路冷却
    this._dead = false;
  }

  get stops() { return this.plan.stops; }

  // ================= 计划编辑（改计划即释放旧路径预留，下 tick 重新预留） =================
  addStop(stationId, action, item, count) {
    this.plan.stops.push({
      stationId,
      action: action === 'load' ? 'load' : 'unload',
      item: item || null,
      count: Math.max(1, Math.min(FG.Config.TRAIN_CARGO_CAP, count || 1)),
    });
    // 待命列车新增计划：从当前位置重新启动（若正停在目标站则直接停靠）
    if (this.state === 'idle') { this.state = 'moving'; this.clearing = false; }
    this.dropRoute();
  }
  removeStop(i) {
    if (i < 0 || i >= this.plan.stops.length) return;
    const wasCurrent = i === this.stopIdx && this.state === 'docked';
    this.plan.stops.splice(i, 1);
    if (i < this.stopIdx) this.stopIdx--;
    // splice 后 stopIdx 自然指向下一站；删掉末站则回到首站
    if (this.stopIdx >= this.plan.stops.length) this.stopIdx = 0;
    if (wasCurrent) {
      this.work = null; this.dwell = 0;
      this.state = this.plan.stops.length ? 'moving' : 'idle';
    }
    if (!this.plan.stops.length) this.state = 'idle';
    this.dropRoute();
  }
  updateStop(i, patch) {
    const s = this.plan.stops[i];
    if (!s) return;
    if (patch.action) s.action = patch.action === 'load' ? 'load' : 'unload';
    if ('item' in patch) s.item = patch.item || null;
    if (patch.count) s.count = Math.max(1, Math.min(FG.Config.TRAIN_CARGO_CAP, patch.count));
    // 改的是当前停靠站的动作/物品/数量：立即重算剩余工作量，不强制离站
    if (i === this.stopIdx && this.state === 'docked') {
      this.work = { rem: s.count || 0 };
      this.dwell = Math.min(this.dwell, FG.Config.TRAIN_DWELL_MAX - 1);
    } else {
      this.dropRoute();
    }
  }
  setLoop(v) {
    this.plan.loop = !!v;
    if (!this.plan.loop && this.state === 'idle') this.clearing = false;
    this.dropRoute();
  }
  /** 上移/下移某个停靠站（改计划：释放旧路径预留，下 tick 按新顺序寻路） */
  reorderStop(i, dir) {
    const j = i + dir;
    if (j < 0 || j >= this.plan.stops.length) return;
    const arr = this.plan.stops;
    [arr[i], arr[j]] = [arr[j], arr[i]];
    if (this.stopIdx === i) this.stopIdx = j;
    else if (this.stopIdx === j) this.stopIdx = i;
    // 当前正停靠的站被换走：按新的当前站重算剩余工作量
    if (this.state === 'docked') {
      const s = this.plan.stops[this.stopIdx];
      this.work = s ? { rem: s.count || 0 } : null;
      this.dwell = 0;
    }
    this.dropRoute();
  }
  setPaused(v) {
    this.plan.paused = !!v;
    if (v) {
      this.state = 'paused';
      // 停运即释放区间/交叉口预留（跨格中途先完成本格跨越，占用权随后只留车头）
    } else if (this.state === 'paused') {
      this.state = this.plan.stops.length ? 'moving' : 'idle';
    }
    this.dropRoute();
  }
  /** 跳过当前站（停靠中立即发车；行驶中直接指向下一站并重新寻路）；单程末站跳过则清道待命 */
  skip() {
    if (!this.plan.stops.length) return;
    this.work = null;
    this.dwell = 0;
    this.leaveCooldown = 2;
    if (this.plan.loop || this.stopIdx < this.plan.stops.length - 1) {
      this.advanceStop();
      this.state = 'moving';
    } else {
      this.clearing = true;
      this.state = 'idle';
    }
    this.dropRoute();
  }
  /** 作废旧路径/预留并立即请求重寻路（下一 tick prepare 阶段重建） */
  dropRoute() {
    this.path = null;
    this.rerouteCd = 0;
  }

  // ================= 载货 =================
  cargoTotal() { return this.cargo.reduce((n, s) => n + s.count, 0); }
  cargoCount(item) {
    if (!item) return this.cargoTotal();
    const s = this.cargo.find(x => x.type === item);
    return s ? s.count : 0;
  }
  /** 列车取出 n 件（指定类型；item=null 任意，按堆顺序），返回实际取出数 */
  pullFromTrain(item, n) {
    let left = n;
    for (const s of this.cargo) {
      if (left <= 0) break;
      if (item && s.type !== item) continue;
      const take = Math.min(left, s.count);
      s.count -= take; left -= take;
    }
    this.cargo = this.cargo.filter(s => s.count > 0);
    return n - left;
  }
  /** 向列车装入 n 件，受载货上限约束，返回实际装入数 */
  pushToTrain(item, n) {
    const room = FG.Config.TRAIN_CARGO_CAP - this.cargoTotal();
    const put = Math.min(n, room);
    if (put <= 0) return 0;
    let s = this.cargo.find(x => x.type === item);
    if (s) s.count += put; else this.cargo.push({ type: item, count: put });
    return put;
  }

  // ================= 阶段一：确定目标 / 寻路 / 预留 =================
  /** 每 tick 行驶前的准备：解析目标站、加权寻路（拥堵绕行）、前瞻预留、设置等待状态 */
  prepare(ry) {
    if (this.plan.paused) { this.state = 'paused'; ry.releaseReserve(this); return; }
    if (this.state === 'docked') { ry.releaseReserve(this); return; }
    if (!this.plan.stops.length) { this.state = 'idle'; this.path = null; ry.releaseReserve(this); return; }

    let stop = this.plan.stops[this.stopIdx];
    let station = ry.stationById(stop.stationId);
    if (!station) {
      ry.logOnce(this, 'miss' + this.stopIdx, '🚆 ' + this.id + '：计划站点已拆除，自动跳过', 'info');
      this.advanceStop();
      ry.releaseReserve(this);
      return;
    }

    // 离站冷却 / 单程末站清道：强制先驶离本站一格（沿用当前 path 或就近选出口）
    if (this.leaveCooldown || this.clearing) {
      if (this.moveTimer > 0) { this.syncMovingReserve(ry); return; }
      if (this.clearing === false && this.state === 'idle') { ry.releaseReserve(this); return; }
      if (!this.path || !this.path.length) {
        let out = null;
        // 优先朝下一目标站驶离（不能踩回本站：冷却必须真正离开）
        const wp = ry.findPath(this, this.x, this.y, station.x, station.y);
        if (wp && wp.length && !(wp[0].x === station.x && wp[0].y === station.y)) out = wp[0];
        // 单站循环等暂不朝目标驶离的情形：就近选任一空闲出口
        if (!out) out = this.neighborRail(ry, this.x, this.y);
        if (!out) { this.state = 'blocked'; ry.releaseReserve(this); return; } // 死胡同
        this.path = [out];
      }
      // 离站/清道的一步调车豁免会车门（只离站一格即停，逐格预留保证安全）
      const reason = ry.syncReserve(this, this.path, false);
      if (reason) { this.state = reason === 'gate' ? 'meeting' : 'blocked'; }
      else if (this.state !== 'moving') this.state = 'moving';
      return;
    }

    if (this.state === 'idle') { ry.releaseReserve(this); return; }

    // 已停在目标站格（含读档/起点重合）→ 直接开停
    if (this.x === station.x && this.y === station.y && !this.leaveCooldown) {
      this.beginDock(station);
      ry.releaseReserve(this);
      return;
    }

    // 跨格动画进行中：沿用旧预留（占用权已在新格），不重寻路
    if (this.moveTimer > 0) { this.syncMovingReserve(ry); return; }

    // 加权寻路：初次 / 路径作废 / 周期性拥堵重寻路（绕行复线或侧线）
    if (this.rerouteCd > 0) this.rerouteCd--;
    if (!this.path || this.rerouteCd === 0) {
      const wp = ry.findPath(this, this.x, this.y, station.x, station.y);
      if (!wp) {
        // 加权 Dijkstra 只要图连通就必返回有限代价路径；返回 null ⇔ 真断路
        this.path = null;
        this.state = 'noroute';
        ry.releaseReserve(this);
        this.rerouteCd = FG.Config.TRAIN_REROUTE_TICKS;
        return;
      }
      this.path = wp;
      this.rerouteCd = FG.Config.TRAIN_REROUTE_TICKS;
    }

    const reason = ry.syncReserve(this, this.path);
    if (reason === 'gate') {
      // 单线对向区间门关闭：默认会车等待（信号机外）；对向车同堵在一个无侧线区间→死锁标红
      this.state = this.deadlockedHeadOn(ry) ? 'blocked' : 'meeting';
      if (this.state === 'blocked') {
        ry.logOnce(this, 'headon', '🚆 ' + this.id + '：单线对向顶住且无会车侧线，请加侧线/拆轨改线', 'error');
      }
    } else if (reason === 'tile') {
      const nk = this.path && this.path.length ? FG.Utils.key(this.path[0].x, this.path[0].y) : null;
      const holder = nk ? ry.trainById(ry.occupy.get(nk) || ry.reserve.get(nk)) : null;
      if (holder && holder.state === 'docked') {
        this.state = 'waiting';                 // 前车在站装卸：正常等站排队
      } else if (this.deadlockedHeadOn(ry)) {
        this.state = 'blocked';                 // 区间内部与对向车逐格顶死
        ry.logOnce(this, 'headon', '🚆 ' + this.id + '：单线对向顶住且无会车侧线，请加侧线/拆轨改线', 'error');
      } else {
        this.state = 'meeting';                 // 同向/其他拥堵：会车/跟车等待
      }
    } else if (this.state !== 'moving') {
      this.state = 'moving';
    }
  }

  /**
   * 是否陷入无会车线的对顶死锁：我被堵的区间分区里有一辆对向、同样处于会车/堵死的列车
   * （车头或其前瞻伸进该分区）。存在会车侧线时对向车的门是开的（它已绕行），不会双方
   * 同时等待，因此该判据只在真·单线对顶时成立。
   */
  deadlockedHeadOn(ry) {
    const blk = this._gateBlock;
    if (!blk || blk.open || blk.junction) return false;
    for (const other of ry.trains) {
      if (other === this || other._dead) continue;
      if (other.state !== 'meeting' && other.state !== 'blocked') continue;
      const ov = FG.Utils.dirVec(other.dir);
      const oHeadIn = blk.keys.has(FG.Utils.key(other.x, other.y));
      const oFrontIn = blk.keys.has(FG.Utils.key(other.x + ov.x, other.y + ov.y));
      const oReserveIn = other.reserve && [...other.reserve].some(rk => blk.keys.has(rk));
      if (oHeadIn || oFrontIn || oReserveIn) return true;
    }
    return false;
  }

  /** 跨格动画期间：只保留占用格 + 已在走向中的下一格，不抢占新区间 */
  syncMovingReserve(ry) {
    if (!this.reserve) this.reserve = new Set();
    const keep = new Set([ry.authorityKey(this)]);
    this.reserve = keep;
    for (const [k, id] of ry.reserve) if (id === this.id && !keep.has(k)) ry.reserve.delete(k);
    for (const k of keep) ry.reserve.set(k, this.id);
    if (this.state !== 'moving' && this.state !== 'meeting' && this.state !== 'waiting') this.state = 'moving';
  }

  // ================= 阶段二：按预留行驶 =================
  /** 每 tick 推进；返回本 tick 是否成功跨过道岔/交叉口（轮转公平用） */
  tick(ry) {
    if (this.plan.paused) { this.state = 'paused'; return false; }
    if (this.state === 'docked') { this.tickDocked(ry); return false; }
    if (!this.plan.stops.length) { this.state = 'idle'; return false; }

    const stop = this.plan.stops[this.stopIdx];
    const station = ry.stationById(stop.stationId);
    if (!station) { this.advanceStop(); return false; }

    // 离站冷却 / 清道驶离
    if (this.leaveCooldown || this.clearing) {
      if (this.moveTimer > 0) {
        this.moveTimer--;
        if (this.moveTimer === 0) {
          const crossed = this.commitArrival(ry);
          return crossed;
        }
        return false;
      }
      if (this.clearing === false && this.state === 'idle') return false;
      return this.stepAlongReserved(ry);
    }

    if (this.state === 'idle') return false;

    if (this.x === station.x && this.y === station.y && !this.leaveCooldown) {
      this.beginDock(station);
      return false;
    }

    if (this.moveTimer > 0) {
      this.moveTimer--;
      if (this.state !== 'moving') this.state = 'moving';
      if (this.moveTimer === 0) return this.commitArrival(ry);
      return false;
    }

    return this.stepAlongReserved(ry);
  }

  /** 若下一格已在本车预留中则跨入；返回是否跨过道岔分区 */
  stepAlongReserved(ry) {
    if (!this.path || !this.path.length) return false;
    // 等待状态（meeting/waiting/blocked/noroute）且下一格未真正预留 → 不动
    if (this.state !== 'moving') return false;
    const next = this.path[0];
    const nk = FG.Utils.key(next.x, next.y);
    if (!this.reserve || !this.reserve.has(nk)) return false;
    const holder = ry.occupy.get(nk);
    if (holder && holder !== this.id) return false;

    const fromBlock = ry.blockAtKey(FG.Utils.key(this.x, this.y));
    // 占用权移交：离开旧格、占住新格、起步
    ry.occupy.delete(FG.Utils.key(this.x, this.y));
    ry.occupy.set(nk, this.id);
    this.px = this.x; this.py = this.y;
    const d = dirFromTo(this.x, this.y, next.x, next.y);
    if (d >= 0) this.dir = d;
    this.path.shift();
    this.moveTimer = FG.Config.TRAIN_MOVE_TICKS - 1;
    this.state = 'moving';
    const toBlock = ry.blockAtKey(nk);
    // 成功跨入/跨出独立道岔分区（交叉口）→ 推进轮转游标，保证各方向公平
    return !!(toBlock && toBlock.junction && (!fromBlock || fromBlock.id !== toBlock.id));
  }

  /** 跨格动画计时结束：车头落到新格 */
  commitArrival(ry) {
    let nx = this.x, ny = this.y;
    for (const [k, id] of ry.occupy) {
      if (id === this.id) { [nx, ny] = k.split(',').map(Number); break; }
    }
    const fromBlk = ry.blockAt(this.x, this.y);
    this.x = nx; this.y = ny;
    const toBlk = ry.blockAt(nx, ny);
    const wasClearing = this.clearing;
    if (this.leaveCooldown > 0) this.leaveCooldown--; // 已驶离至少一格，解除禁停
    if (wasClearing) { this.clearing = false; this.state = 'idle'; this.path = null; ry.releaseReserve(this); return false; }
    if (this.path && this.path.length) return false;        // 冷却驶离途中
    if (!this.path) { this.state = 'moving'; return false; }
    {
      const stop = this.plan.stops[this.stopIdx];
      const station = ry.stationById(stop.stationId);
      if (station && station.x === this.x && station.y === this.y) {
        this.beginDock(station);
        return false;
      }
      this.state = 'noroute'; this.path = null;
    }
    return !!(toBlk && toBlk.junction && (!fromBlk || fromBlk.id !== toBlk.id));
  }

  /** (x,y) 的任一相邻轨格（离站冷却时驶离用） */
  neighborRail(ry, x, y) {
    for (let d = 0; d < 4; d++) {
      const v = FG.Utils.dirVec(d);
      const nx = x + v.x, ny = y + v.y;
      const nk = FG.Utils.key(nx, ny);
      if (!ry.nodes.has(nk)) continue;
      const holder = ry.occupy.get(nk);
      if (holder && holder !== this.id) continue;
      const rv = ry.reserve.get(nk);
      if (rv && rv !== this.id) continue;
      return { x: nx, y: ny };
    }
    return null;
  }

  // ================= 停站装卸 =================
  beginDock(station) {
    this.state = 'docked';
    this.dwell = 0;
    this.moveTimer = 0;
    const stop = this.plan.stops[this.stopIdx];
    this.work = { rem: stop.count || 0 };
  }

  tickDocked(ry) {
    this.dwell++;
    const stop = this.plan.stops[this.stopIdx];
    const station = ry.stationById(stop.stationId);
    if (!station) { this.beginDepart(ry); return; }

    // 逐 tick 装卸（上限 TRANSFER 件）
    if (this.work.rem > 0) {
      const budget = Math.min(FG.Config.TRAIN_TRANSFER, this.work.rem);
      let moved = 0;
      if (stop.action === 'unload') {
        moved = this.unloadToStation(ry, station, stop.item, budget);
      } else {
        moved = this.loadFromStation(station, stop.item, budget);
      }
      this.work.rem = Math.max(0, this.work.rem - moved);
    }

    const settled = this.stopSettled(station, stop);
    if (this.dwell >= FG.Config.TRAIN_DWELL_MAX) {
      if (!settled) ry.logOnce(this, 'dwellmax', '🚆 ' + this.id + '：在「' + (station.stationName || '站点')
        + '」等待超时（' + (stop.action === 'load' ? '装' : '卸') + '料未完成），强制离站防堵站', 'error');
      this.beginDepart(ry);
    } else if (settled && this.dwell >= FG.Config.TRAIN_DWELL_MIN) {
      this.beginDepart(ry);
    }
  }

  /** 停站动作是否已无可推进：
   *  计划数量已完成 → settled（等到最短停站时间即走）；
   *  卸货=车上已无对应货（站满则继续等）；装货=车满或站无货 */
  stopSettled(station, stop) {
    if (this.work.rem <= 0) return true;
    if (stop.action === 'unload') {
      if (this.cargoCount(stop.item) > 0) return false;      // 车上还有但站里塞不下 → 继续等
    } else {
      if (this.cargoTotal() < FG.Config.TRAIN_CARGO_CAP && stationCount(station, stop.item) > 0) return false;
    }
    return true;
  }

  /** 列车 → 交付站/车站，返回实际卸下件数（站满则卸不动；合同锁付不受站库容量限制） */
  unloadToStation(ry, station, item, n) {
    let moved = 0;
    // 交付站供货合同：缺口内的合同货物直接从列车锁付（记入合同独立台账，
    // 实物不进站货位、不占站库容量）——只计本趟列车实际运来的货物，
    // 站货位里的普通库存不算铁路交付；站库满时也能锁付。
    const cm = (station.def.delivery && ry.game.contracts) ? ry.game.contracts : null;
    for (const s of this.cargo) {
      if (moved >= n) break;
      if (item && s.type !== item) continue;
      const want = Math.min(n - moved, s.count);
      let put = 0;
      // 1) 合同缺口内：从列车货位直接锁付（独立记账，移出物流）
      if (cm) put += cm.lockFromTrain(station, s.type, want);
      // 2) 余量（超额部分与非合同货物）照常进入站货位：站里现有同品槽先填，再找空槽
      for (const slot of station.chest) {
        if (put >= want) break;
        if (slot.type === s.type && slot.count < slot.cap) {
          const q = Math.min(want - put, slot.cap - slot.count);
          slot.count += q; put += q;
        }
      }
      for (const slot of station.chest) {
        if (put >= want) break;
        if (slot.count === 0) {
          const q = Math.min(want - put, slot.cap);
          slot.type = s.type; slot.count = q; put += q;
        }
      }
      if (put > 0) { s.count -= put; moved += put; }
      if (put < want) break; // 站库满，本 tick 无能为力（等机械臂/带拉走）
    }
    this.cargo = this.cargo.filter(s => s.count > 0);
    return moved;
  }

  /** 站货位 → 列车，返回实际装件数 */
  loadFromStation(station, item, n) {
    let moved = 0;
    for (const slot of station.chest) {
      if (moved >= n) break;
      if (slot.count <= 0) continue;
      if (item && slot.type !== item) continue;
      const want = Math.min(n - moved, slot.count);
      const put = this.pushToTrain(slot.type, want);
      slot.count -= put;
      moved += put;
      if (slot.count === 0) slot.type = null;
      if (put < want) break; // 列车货满
    }
    return moved;
  }

  advanceStop() {
    if (this.plan.stops.length) this.stopIdx = (this.stopIdx + 1) % this.plan.stops.length;
  }

  beginDepart(ry) {
    this.work = null;
    this.dwell = 0;
    const oneWayEnd = !this.plan.loop && this.stopIdx >= this.plan.stops.length - 1;
    // 冷却期间：循环车继续行驶到下一站；单程末站驶离后待命（不继续占站）
    this.clearing = oneWayEnd;
    this.leaveCooldown = 2;
    if (!this.plan.stops.length) { this.state = 'idle'; }
    else if (!oneWayEnd) {
      this.advanceStop();
      this.state = 'moving';
    } else {
      this.state = 'idle';
    }
    this.dropRoute();
    if (ry) ry.releaseReserve(this);
  }
};

/** 站货位某物品数量（item=null 为总量） */
function stationCount(station, item) {
  let n = 0;
  for (const s of station.chest) {
    if (s.count > 0 && (!item || s.type === item)) n += s.count;
  }
  return n;
}

/** 相邻格方向索引（0~3），不相邻返回 -1 */
function dirFromTo(fx, fy, tx, ty) {
  for (let d = 0; d < 4; d++) {
    const v = FG.Utils.dirVec(d);
    if (fx + v.x === tx && fy + v.y === ty) return d;
  }
  return -1;
}
