/**
 * FG.Railway —— 铁路货运系统：轨网、区间预留、拥堵绕行与列车调度
 *
 * 模型：
 *  - 轨格图：轨道(rail)与火车站(station)建筑即图节点，四邻相连；机务段(trainDepot)不进图，
 *    只作为发车点（必须邻接轨格）。轨网增删建筑后标记 dirty，下一 tick 重建（站号自动补发）。
 *  - 区间预留（取代旧的逐格抢占）：列车在车头前方沿所选路径一次预留至多 TRAIN_LOOKAHEAD 格
 *    （reserve 表「格 → 列车」，独立于当前物理格 occupy），预留到的格其他车的寻路会主动绕开，
 *    也不能再被其他车预留；车逐格前进时释放身后格、续伸前方预留，追尾/对穿在预留层即被挡住。
 *  - 拥堵绕行：寻路改为带权 Dijkstra，他车当前占用/已预留的格边权 = TRAIN_CONGEST_COST，
 *    有长度可接受的空路时自动选空路；没有任何空路时退回最短拥堵路、在区间外排队等预留释放。
 *    运行中被堵住时按 TRAIN_REROUTE_CD 冷却重新寻路，路网补齐/他车改道后自动绕行自愈。
 *  - 交叉口公平通行：邻接轨格数 ≥3 的节点为交叉口，争用同一交叉口的列车按 FIFO 排队
 *    （gates 表「交叉口格 → 列车 id 队列」），队头未驶过交叉口之前后车不把区间预留伸进
 *    交叉口；队头通过或已不再使用该交叉口后整队前移，任一方向来车都不会被持续饿死。
 *  - 单线会车等待：对向两车在单线区间顶牛时进入「会车等待」（meeting）状态，在区间外让行；
 *    任一方路径变化（进侧线/车站、补出会车线、他车绕行）即自动疏解；超过
 *    TRAIN_MEET_WAIT_MAX 仍无法疏解才标红（blocked）提示改线——对向顶住本身不是立即故障。
 *  - 堵站：站内停靠的列车只占站格（停站期间释放全部前方预留，不长期压住区间），后续列车在
 *    站外排队（等站），装卸完成或最长停站时间到时离站，后车依次进站。
 *  - 断路：目标站不可达（所有路径都被已占用格切断）时列车进入「断路」状态原地等待；轨道
 *    补齐（图重建）后下一 tick 自动重新寻路。计划中的站点被拆除则自动跳过该站。
 *  - 装卸：火车站货位与箱子同构（4 槽），机械臂/传送带可直接与产线转运；列车按各停靠站的
 *    计划动作（装/卸 × 物品 × 数量）在停站期间逐 tick 搬运，到量/清空/最长停站时间到即走。
 *  - 占用释放：停运（暂停）立即释放前方区间预留（保留当前物理格）；改计划（增删/跳过停靠站、
 *    循环切单程、调整站序）立即作废旧路径与全部预留并按新计划重新预留；解编/拆轨释放全部
 *    占用与预留（拆轨只允许拆物理无车的格，被拆预留相关列车图重建时路径作废重新寻路）。
 *  - 存档：列车位置、朝向、载货、运输计划（含停站序号/停靠计时/动作余量）、移动进度与调度
 *    轮转游标全部序列化；占用表与预留表读档后由列车位置惰性重建（跨格中途吸附回已落定格、
 *    moveTimer 清零重新寻路），兼容无铁路字段的旧存档。
 */
FG.Railway = class Railway {
  constructor(game) {
    this.game = game;
    this.trains = [];
    this.occupy = new Map();    // 'x,y' -> trainId（列车当前物理占用格，跨格时为目标格）
    this.reserve = new Map();   // 'x,y' -> trainId（前方区间预留，不含当前物理格）
    this.nodes = new Set();     // 轨格 key（轨道 + 火车站）
    this.junctions = new Set(); // 交叉口格 key（邻接轨格 ≥3）
    this.gates = new Map();     // 'x,y' -> [trainId] 交叉口 FIFO 等待队列
    this.stationMap = new Map();// stationId -> 站建筑
    this.graphDirty = true;
    this.moverSeq = 0;          // 同级轮转游标（兜底公平：每 tick 成功跨格者排到队尾）
    this.trainSeq = 1;
    this.stationSeq = 1;
  }

  reset() {
    this.trains = [];
    this.occupy.clear();
    this.reserve.clear();
    this.nodes.clear();
    this.junctions.clear();
    this.gates.clear();
    this.stationMap.clear();
    this.graphDirty = true;
    this.moverSeq = 0;
    this.trainSeq = 1;
    this.stationSeq = 1;
  }

  markDirty() { this.graphDirty = true; }

  // ================= 轨网 =================
  isRailTile(x, y) {
    const b = this.game.map.buildingAt(x, y);
    return !!b && (b.type === 'rail' || !!b.def.railStation);
  }

  rebuildGraph() {
    this.nodes.clear();
    this.junctions.clear();
    this.stationMap.clear();
    for (const b of this.game.map.buildings.values()) {
      if (b.type === 'rail' || b.def.railStation) {
        this.nodes.add(FG.Utils.key(b.x, b.y));
        if (b.def.railStation) {
          if (!b.stationId) b.stationId = 'S' + (this.stationSeq++);
          if (!b.stationName) b.stationName = '站点 ' + b.stationId.slice(1);
          this.stationMap.set(b.stationId, b);
        }
      }
    }
    // 交叉口：轨网中邻接轨格 ≥3 的节点
    for (const k of this.nodes) {
      const [x, y] = k.split(',').map(Number);
      let deg = 0;
      for (const v of FG.Utils.dirs) if (this.nodes.has(FG.Utils.key(x + v.x, y + v.y))) deg++;
      if (deg >= 3) this.junctions.add(k);
    }
    // 图变更后缓存路径与区间预留全部作废：经过已拆除/新增轨格的列车下一 tick 重新寻路，
    // 并按新车流重新预留（旧预留可能指向已不存在的格，不能保留）
    this.reserve.clear();
    this.gates.clear();
    for (const tr of this.trains) { tr.path = null; tr.rerouteCd = 0; }
    this.graphDirty = false;
  }

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

  isJunction(x, y) { return this.junctions.has(FG.Utils.key(x, y)); }

  /** 带权 Dijkstra 寻路：返回从起点（不含）到目标格（含）的格坐标数组；不可达返回 null。
   *  他车占用/预留的格边权为 TRAIN_CONGEST_COST（拥堵代价），自有占用/预留视为本车通路；
   *  因此存在长度可接受的空路时列车自动绕行避堵，没有空路时才退回排队等在拥堵区间外。 */
  findRoute(sx, sy, tx, ty, selfId) {
    if (this.graphDirty) this.rebuildGraph();
    const tk = FG.Utils.key(tx, ty);
    if (!this.nodes.has(tk)) return null;
    const sk = FG.Utils.key(sx, sy);
    if (sk === tk) return [];
    const CONG = FG.Config.TRAIN_CONGEST_COST;
    const tileCost = (k) => {
      if (k === sk || k === tk) return 1;          // 起点与目标（站格）不计拥堵
      const o = this.occupy.get(k);
      if (o && o !== selfId) return CONG;
      const r = this.reserve.get(k);
      if (r && r !== selfId) return CONG;
      return 1;
    };
    // 简单二叉堆（按距离）
    const dist = new Map([[sk, 0]]);
    const prev = new Map([[sk, null]]);
    const heap = [[0, sk]];
    const pushHeap = (e) => {
      heap.push(e);
      let i = heap.length - 1;
      while (i > 0) {
        const p = (i - 1) >> 1;
        if (heap[p][0] <= heap[i][0]) break;
        [heap[p], heap[i]] = [heap[i], heap[p]];
        i = p;
      }
    };
    const popHeap = () => {
      const top = heap[0], last = heap.pop();
      if (heap.length) {
        heap[0] = last;
        let i = 0;
        for (;;) {
          let l = i * 2 + 1, r = l + 1, m = i;
          if (l < heap.length && heap[l][0] < heap[m][0]) m = l;
          if (r < heap.length && heap[r][0] < heap[m][0]) m = r;
          if (m === i) break;
          [heap[m], heap[i]] = [heap[i], heap[m]];
          i = m;
        }
      }
      return top;
    };
    let found = false;
    let explored = 0;
    const EXPLORE_CAP = this.nodes.size * 4 + 64; // 节点封顶：超大轨网下寻路开销有界
    while (heap.length && explored < EXPLORE_CAP) {
      const [d, cur] = popHeap();
      if (d !== dist.get(cur)) continue;          // 过期堆项
      explored++;
      if (cur === tk) { found = true; break; }
      const [cx, cy] = cur.split(',').map(Number);
      for (let dir = 0; dir < 4; dir++) {
        const v = FG.Utils.dirVec(dir);
        const nk = FG.Utils.key(cx + v.x, cy + v.y);
        if (!this.nodes.has(nk) || nk === sk) continue;
        const nd = d + tileCost(nk);
        if (nd < (dist.has(nk) ? dist.get(nk) : Infinity)) {
          dist.set(nk, nd);
          prev.set(nk, cur);
          pushHeap([nd, nk]);
        }
      }
    }
    if (!found && dist.has(tk)) found = true;      // 堆耗尽但目标已松弛
    if (!found) return null;
    const path = [];
    let k = tk;
    while (k !== sk) {
      const [x, y] = k.split(',').map(Number);
      path.unshift({ x, y });
      k = prev.get(k);
      if (!k) return null;
    }
    return path;
  }

  /** 旧接口兼容：无主寻路（不豁免任何占用/预留），主要给测试/外部调用 */
  findPath(sx, sy, tx, ty) { return this.findRoute(sx, sy, tx, ty, null); }

  // ================= 交叉口 FIFO =================
  /** 列车的既定路径是否使用（穿过）交叉口格 jk：jk 在当前物理格之后的路径里 */
  trainUsesJunction(tr, jk) {
    if (FG.Utils.key(tr.x, tr.y) === jk) return true;
    if (tr.path) for (const p of tr.path) if (FG.Utils.key(p.x, p.y) === jk) return true;
    return false;
  }

  /**
   * 交叉口等待队列维护（公平通行核心）：
   * 队列只收录「已经物理抵达交叉口入口、正被挡住」的列车——按物理抵达先后 FIFO；
   * 仅仅在远处把交叉口纳入区间预留的车不排队（否则远车会挡住已在口上的近车，造成假死锁）。
   * 队头驶过交叉口（物理格越过或路径不再经过）后整队前移；改道/解编/改计划的成员出列。
   */
  updateGate(jk, tr) {
    let q = this.gates.get(jk);
    if (!q) { q = []; this.gates.set(jk, q); }
    // 入口判定：本车物理格与交叉口相邻，且路径首格（下一格）正是交叉口
    const [jx, jy] = jk.split(',').map(Number);
    const adjacent = adjacentTo(tr.x, tr.y, jx, jy);
    const atMouth = adjacent && tr.path && tr.path[0] && FG.Utils.key(tr.path[0].x, tr.path[0].y) === jk;
    const i = q.indexOf(tr.id);
    if (atMouth) {
      if (i < 0) q.push(tr.id);            // 物理抵达入口：按先后入队
    } else if (i >= 0 && !this.trainUsesJunction(tr, jk)) {
      q.splice(i, 1);                       // 已不使用该交叉口（改道/通过后路径不再经过）→ 出队
    }
    return q[0] === tr.id;
  }

  /** 清理/推进交叉口队列：剔除已解编/已不使用该交叉口的等待者（队头让过后整队前移） */
  sweepGates() {
    if (!this.gates.size) return;
    for (const [jk, q] of this.gates) {
      for (let i = q.length - 1; i >= 0; i--) {
        const t = this.trainById(q[i]);
        if (!t || t._dead || !this.trainUsesJunction(t, jk)) q.splice(i, 1);
      }
      if (!q.length) this.gates.delete(jk);
    }
  }

  // ================= 区间预留 =================
  /** 释放某列车的全部前方预留（不停用其当前物理占用） */
  releaseReservations(tr) {
    for (const [k, id] of this.reserve) if (id === tr.id) this.reserve.delete(k);
  }

  /**
   * 沿 path 在车头前方维持至多 TRAIN_LOOKAHEAD 格的区间预留（增量式）：
   *  - 已持有的合法预留一律保留（绝不主动放弃，避免两车在同一区间反复伸缩抢位）；
   *  - 只向前续伸：遇他车占用/预留、或遇到「本车不在队头」的交叉口即停止；
   *  - 仅释放不再属于当前窗口的尾部残留（物理已驶过的格）。
   * path 为空（如已抵达站格）时清空全部前方预留。
   */
  rebook(tr, path) {
    // 1) 计算当前窗口：物理格 + 其后至多 LOOKAHEAD 个路径格
    const want = new Set([FG.Utils.key(tr.x, tr.y)]);
    if (path && path.length) {
      for (let i = 0; i < path.length && want.size <= FG.Config.TRAIN_LOOKAHEAD; i++) {
        want.add(FG.Utils.key(path[i].x, path[i].y));
      }
    }
    // 2) 释放窗口之外、物理格之上的自有残留
    for (const [k, id] of this.reserve) {
      if (id === tr.id && !want.has(k)) this.reserve.delete(k);
    }
    if (!path || !path.length) return;
    // 3) 沿路径向前续伸（注意：path[0] 可能正是跨格目标——物理已占用但仍在 path 里，
    //    必须照常推进窗口游标，否则会把身后格误算进预留窗口）
    let held = 0; // 窗口内已确认属于本车（物理占用或已预留）的格数（含物理格）
    let cx = tr.x, cy = tr.y;
    for (let i = 0; i < path.length; i++) {
      const p = path[i];
      const pk = FG.Utils.key(p.x, p.y);
      const isPhys = pk === FG.Utils.key(cx, cy);
      if (!isPhys) {
        const mine = this.reserve.get(pk) === tr.id;
        if (!mine) {
          const holder = this.occupy.get(pk);
          if (holder && holder !== tr.id) break;
          const booked = this.reserve.get(pk);
          if (booked && booked !== tr.id) break;
          // 交叉口规则（公平通行核心）：
          //  1) 区间预留不得在远处「预占」交叉口——只有已物理抵达交叉口入口
          //     （上一持有格与交叉口相邻）的列车才允许把预留伸进交叉口，
          //     否则远车会提前锁死交叉口、饿死已经到口的垂直方向近车；
          //  2) 抵达入口后还要过 FIFO 闸门：同交叉口争用按物理抵达先后排队，非队头止步。
          if (this.junctions.has(pk)) {
            if (!adjacentTo(cx, cy, p.x, p.y)) break; // (cx,cy) 即上一持有格
            const q = this.gates.get(pk);
            if (q && q.length && q[0] !== tr.id) break;
          }
          this.reserve.set(pk, tr.id);
        } else if (this.junctions.has(pk)) {
          // 已持有交叉口预留但本轮 FIFO 已不是队头（垂直方向近车先到入口）→
          // 立即交出交叉口预留，退回入口外等待，避免远车预留压住交叉口造成假死锁
          const q = this.gates.get(pk);
          const atMouth = adjacentTo(cx, cy, p.x, p.y);
          if (atMouth && q && q.length && q[0] !== tr.id) {
            this.reserve.delete(pk);
            break;
          }
        }
        held++;
        if (held >= FG.Config.TRAIN_LOOKAHEAD) break;
      }
      cx = p.x; cy = p.y;
    }
  }

  /** 尝试把一格新预留纳入本车（移动起步用，含交叉口闸门判定）；返回 true=可踏入 */
  canEnter(tr, nk) {
    const holder = this.occupy.get(nk);
    if (holder && holder !== tr.id) return false;
    const booked = this.reserve.get(nk);
    if (booked && booked !== tr.id) return false;
    if (this.junctions.has(nk)) {
      const q = this.gates.get(nk);
      if (q && q.length && q[0] !== tr.id) return false;
    }
    return true;
  }

  // ================= 主循环（轮转公平 × 区间预留 × 交叉口 FIFO） =================
  tick() {
    if (this.graphDirty) this.rebuildGraph();
    const n = this.trains.length;
    if (!n) { this.sweepGates(); return; }
    const start = this.moverSeq % n;
    for (let i = 0; i < n; i++) {
      const idx = (start + i) % n;
      const tr = this.trains[idx];
      if (tr._dead) continue;
      if (!tr.ry) tr.ry = this; // 外部（测试/存档工具）直接构造的列车补挂路网引用
      if (tr.tick(this)) this.moverSeq = (idx + 1) % n; // 成功跨格者下轮排在后面
    }
    this.sweepGates();
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
      if (this.occupy.has(k) || this.reserve.has(k)) continue;
      const tr = new FG.Train('T' + (this.trainSeq++), x, y, d);
      tr.ry = this;
      this.trains.push(tr);
      this.occupy.set(k, tr.id);
      return tr;
    }
    return null;
  }

  removeTrain(tr) {
    // 释放物理占用与全部区间预留，并退出所有交叉口等待队列
    for (const [k, id] of this.occupy) if (id === tr.id) this.occupy.delete(k);
    this.releaseReservations(tr);
    for (const q of this.gates.values()) {
      const i = q.indexOf(tr.id);
      if (i >= 0) q.splice(i, 1);
    }
    tr._dead = true;
  }

  /** 某轨格/站格是否被列车物理占用（拆除保护；仅前方预留不阻止拆除） */
  occupiedBy(x, y) { return this.occupy.get(FG.Utils.key(x, y)) || null; }
  /** 某轨格/站格是否被列车物理占用或区间预留（发车选位用） */
  claimedBy(x, y) {
    return this.occupy.get(FG.Utils.key(x, y)) || this.reserve.get(FG.Utils.key(x, y)) || null;
  }

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
        waitTicks: t.waitTicks || 0,
      })),
    };
  }

  deserialize(data) {
    this.reset();
    if (!data) return;
    this.trainSeq = data.trainSeq || 1;
    this.stationSeq = data.stationSeq || 1;
    this.moverSeq = data.moverSeq || 0;
    this.rebuildGraph(); // 先建站号映射，供停靠状态恢复校验
    for (const st of (data.trains || [])) {
      const tr = new FG.Train(st.id, st.x, st.y, st.dir || 0);
      tr.ry = this;
      tr.cargo = (st.cargo || []).map(s => ({ type: s.type, count: s.count }));
      tr.plan = {
        paused: !!st.paused,
        loop: st.loop !== false,
        stops: (st.stops || []).map(s => ({
          stationId: s.stationId, action: s.action === 'load' ? 'load' : 'unload',
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
      tr.waitTicks = st.waitTicks || 0;
      // 占用表只以车体当前格为准重建：存档时列车可能正处在跨格中途
      //（moveTimer>0，占用权已在新格、车体仍在旧格），该半格状态无法随档恢复，
      // 统一吸附回已落定格（moveTimer 清零、path 作废重新寻路、区间预留由首个 tick 惰性重建），
      // 否则残留的跨格计时会让列车在没有占用权的情况下凭空走入新格，与后车重叠
      tr.moveTimer = 0;
      tr.path = null;
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

  /** (x,y) 相邻的空闲（无物理占用也无区间预留）轨格（读档修复异常重叠用），找不到返回 null */
  freeNeighbor(x, y) {
    for (let d = 0; d < 4; d++) {
      const v = FG.Utils.dirVec(d);
      const nx = x + v.x, ny = y + v.y;
      const nk = FG.Utils.key(nx, ny);
      if (this.nodes.has(nk) && !this.occupy.has(nk) && !this.reserve.has(nk)) return { x: nx, y: ny };
    }
    return null;
  }
};

/**
 * FG.Train —— 列车运行时实体（单节机车，混堆载货 TRAIN_CARGO_CAP 件）
 * 状态机：idle 待命 → moving 行驶 → docked 装卸 → moving（循环下一站）；
 *         waiting 等站/交叉口排队、meeting 单线会车等待、blocked 堵死、
 *         noroute 断路、paused 已停运。
 */
FG.Train = class Train {
  constructor(id, x, y, dir) {
    this.isTrain = true;
    this.id = id;
    this.x = x; this.y = y;       // 车头（列车）当前物理占据格
    this.px = x; this.py = y;     // 上一格（渲染插值）
    this.dir = dir;
    this.cargo = [];             // [{type,count}]
    this.plan = { paused: false, stops: [], loop: true };
    this.stopIdx = 0;
    this.state = 'idle';
    this.path = null;            // 待行驶格（不含当前格；含跨格目标，起步时 shift）
    this.moveTimer = 0;          // 跨入下一格剩余 tick
    this.dwell = 0;              // 已停站 tick
    this.work = null;            // {rem} 当前停站动作剩余件数
    this.leaveCooldown = 0;      // 离站冷却：>0 时禁止在当前站重新停靠（先驶离）
    this.clearing = false;       // 单程末站清道中（驶离后转待命）
    this.waitTicks = 0;          // 连续未前进 tick（会车超时标红 / 交叉口超时兜底）
    this.rerouteCd = 0;          // 拥堵绕行重寻路冷却
    this.ry = null;              // 所属铁路网（计划变更时释放预留用；发车/读档时注入）
    this._dead = false;
  }

  get stops() { return this.plan.stops; }

  // ================= 计划编辑（改计划即释放旧占用、按新计划重新预留） =================
  /** 作废当前行驶路径与全部区间预留（保留物理格），下一 tick 按新计划重新寻路预留 */
  invalidateRoute() {
    const ry = this.ry;
    this.path = null;
    this.moveTimer = 0;  // 改计划时打断跨格中途：物理格吸附回占用权所在格，避免走旧路径
    if (ry) {
      // 车体吸附到占用权实际所在格（可能正处在跨格中途）
      for (const [k, id] of ry.occupy) {
        if (id === this.id) { const [x, y] = k.split(',').map(Number); this.x = x; this.y = y; this.px = x; this.py = y; break; }
      }
      ry.releaseReservations(this);
      for (const q of ry.gates.values()) {
        const i = q.indexOf(this.id);
        if (i >= 0) q.splice(i, 1);
      }
    }
    this.rerouteCd = 0;
    this.waitTicks = 0;
  }

  addStop(stationId, action, item, count) {
    this.plan.stops.push({
      stationId,
      action: action === 'load' ? 'load' : 'unload',
      item: item || null,
      count: Math.max(1, Math.min(FG.Config.TRAIN_CARGO_CAP, count || 1)),
    });
    // 清道中（刚跳过单程末站）又追加计划：取消清道，直接以新站为当前目标
    if (this.clearing) {
      this.clearing = false;
      this.leaveCooldown = 0;
      this.stopIdx = this.plan.stops.length - 1;
    }
    // 待命列车新增计划：从当前位置重新启动（若正停在目标站则直接停靠）
    if (this.state === 'idle') this.state = 'moving';
    if (!this.plan.paused && this.state !== 'docked') this.invalidateRoute();
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
      if (this.plan.stops.length && !this.plan.paused) this.invalidateRoute();
    } else if (this.plan.stops.length && !this.plan.paused && this.state !== 'docked') {
      this.invalidateRoute();
    }
    if (!this.plan.stops.length) { this.state = 'idle'; this.invalidateRoute(); }
  }
  /** 交换两个停靠站顺序（UI 上移/下移） */
  reorderStops(i, j) {
    if (i < 0 || i >= this.plan.stops.length || j < 0 || j >= this.plan.stops.length) return;
    const arr = this.plan.stops;
    [arr[i], arr[j]] = [arr[j], arr[i]];
    if (this.stopIdx === i) this.stopIdx = j;
    else if (this.stopIdx === j) this.stopIdx = i;
    if (!this.plan.paused && this.state !== 'docked') this.invalidateRoute();
  }
  updateStop(i, patch) {
    const s = this.plan.stops[i];
    if (!s) return;
    const affectsRoute = i === this.stopIdx && (patch.stationId !== undefined);
    if (patch.stationId) s.stationId = patch.stationId;
    if (patch.action) s.action = patch.action === 'load' ? 'load' : 'unload';
    if ('item' in patch) s.item = patch.item || null;
    if (patch.count) s.count = Math.max(1, Math.min(FG.Config.TRAIN_CARGO_CAP, patch.count));
    // 改动作/物品/数量不影响行驶路径；改当前站站号才需要重新寻路
    if (affectsRoute && !this.plan.paused && this.state !== 'docked') this.invalidateRoute();
  }
  /** 循环 ⇄ 单程：末站语义变化，路径与预留立即重算 */
  setLoop(v) {
    this.plan.loop = !!v;
    if (!this.plan.paused && ['moving', 'waiting', 'meeting', 'blocked', 'noroute'].includes(this.state)) {
      this.invalidateRoute();
      this.state = 'moving';
    }
  }
  setPaused(v) {
    this.plan.paused = !!v;
    if (v) {
      this.state = 'paused';
      // 停运：保留当前物理格占用，释放全部前方区间预留与交叉口排队，
      // 其他列车下一 tick 即可重新寻路绕开/通过（不长期压住区间）
      this.invalidateRoute();
    } else if (this.state === 'paused') {
      this.invalidateRoute();
      this.state = this.plan.stops.length ? 'moving' : 'idle';
    }
  }
  /** 跳过当前站：
   *  - 停靠中：等同正常发车（beginDepart：推进下一站或单程末站清道，含冷却/预留重算）；
   *  - 行驶中：作废当前目标的路径/预留，直接指向下一站重新寻路；单程末站则就地待命。
   *  单程末站清道后又追加停靠站（addStop），清道自动取消、以新站为目标继续行驶。 */
  skip() {
    if (!this.plan.stops.length) return;
    if (this.state === 'docked') { this.beginDepart(this.ry); return; }
    this.work = null;
    this.dwell = 0;
    if (this.plan.loop || this.stopIdx < this.plan.stops.length - 1) {
      this.advanceStop();
      this.clearing = false;
      this.state = 'moving';
    } else {
      this.clearing = true;
      this.leaveCooldown = 2;
      this.state = 'idle';
    }
    this.invalidateRoute(); // 行驶中跳站：旧路径/预留指向作废的目标站
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

  // ================= 仿真 =================
  /** 每 tick 推进；返回本 tick 是否成功跨入新格（轮转游标用） */
  tick(ry) {
    if (this.plan.paused) { this.state = 'paused'; return false; }
    if (this.state === 'docked') { this.tickDocked(ry); return false; }
    if (!this.plan.stops.length) { this.state = 'idle'; this.path = null; return false; }

    // 确定目标站（站点缺失则自动跳过）
    let stop = this.plan.stops[this.stopIdx];
    let station = ry.stationById(stop.stationId);
    if (!station) {
      ry.logOnce(this, 'miss' + this.stopIdx, '🚆 ' + this.id + '：计划站点已拆除，自动跳过', 'info');
      this.advanceStop();
      return false;
    }

    // 刚离站的冷却 / 单程末站清道：强制先驶离本站一格
    //（循环单站不瞬时重入；单程末站驶离后转待命，不继续占站）
    if (this.leaveCooldown || this.clearing) {
      if (this.moveTimer > 0) {
        this.moveTimer--;
        if (this.moveTimer === 0) this.commitArrival(ry);
        return false;
      }
      // 清道已完成（clearing 在到达时被清除）的待命车理论上冷却已清零；
      // 兜底：保持待命、不寻路（新增停靠站会重置状态与冷却重新唤起）
      if (!this.clearing && this.state === 'idle') return false;
      // 冷却中但尚未起步（无 path）：先驶到本站任一相邻空闲轨格，之后再寻路/待命
      if (!this.path || !this.path.length) {
        const out = this.neighborRail(ry, this.x, this.y);
        if (!out) { this.state = 'blocked'; return false; } // 死胡同：无法驶离（需改线）
        this.claimToward(ry, out);
        this.waitTicks = 0;
        return true;
      }
    }

    // 单程计划已驶离末站（clearing 结束、冷却走完）→ 回待命，不再自动行驶；
    // 新增停靠站后由 addStop 唤起
    if (this.state === 'idle') return false;

    // 已停在目标站格（含读档/起点重合）→ 直接开停；
    // 刚从该站发车（leaveCooldown 内）必须先驶离，避免同一站单站计划瞬时重入
    if (this.x === station.x && this.y === station.y && !this.leaveCooldown) {
      this.beginDock(station, ry);
      return false;
    }

    // 寻路（断路时每 tick 重试；带拥堵边权：有空路自动绕行）
    if (!this.path) {
      this.path = ry.findRoute(this.x, this.y, station.x, station.y, this.id);
      if (!this.path) { this.state = 'noroute'; return false; }
      ry.rebook(this, this.path);
    }

    // 正在跨格中：动画走完落到新格；途中续伸预留（path 首格即跨格目标，已物理占用）
    if (this.moveTimer > 0) {
      this.moveTimer--;
      if (this.state !== 'moving') this.state = 'moving';
      if (this.moveTimer === 0) {
        this.commitArrival(ry);
        this.waitTicks = 0;
      } else {
        ry.rebook(this, this.path);
      }
      return false;
    }

    if (this.rerouteCd > 0) this.rerouteCd--;

    // 申请下一区间（必须在自己的区间预留内；预留段耗尽则等待/绕行）
    const next = this.path[0];
    const nk = FG.Utils.key(next.x, next.y);
    if (!ry.canEnter(this, nk)) {
      this.handleBlockedTile(ry, next, nk, station);
      return false;
    }

    // 占用权移交：离开旧格、占住新格、起步；身后预留随物理移动自然释放
    ry.occupy.delete(FG.Utils.key(this.x, this.y));
    const oldReserve = ry.reserve.get(nk);
    if (oldReserve === this.id) ry.reserve.delete(nk); // 预留格转为物理占用
    ry.occupy.set(nk, this.id);
    this.px = this.x; this.py = this.y;
    const d = dirFromTo(this.x, this.y, next.x, next.y);
    if (d >= 0) this.dir = d;
    this.path.shift();
    this.moveTimer = FG.Config.TRAIN_MOVE_TICKS - 1;
    this.state = 'moving';
    // 起步后续伸区间预留
    ry.rebook(this, this.path);
    this.waitTicks = 0;
    return true;
  }

  /** 前方格进不去时的分类等待/绕行处理：
   *  等站排队（前车装卸/排队进站）· 会车等待（单线对向顶住）· 交叉口 FIFO · 拥堵绕行 · 断路 */
  handleBlockedTile(ry, next, nk, station) {
    const holderId = ry.occupy.get(nk) || ry.reserve.get(nk) || null;
    const holder = holderId ? ry.trainById(holderId) : null;
    // 交叉口公平闸门：物理抵达入口的列车按先后 FIFO，非队头排队等队头驶过（不饿死任一方向）。
    // 队头自身被对向顶住时由下面的会车/绕行逻辑处理；队头长时间不动（交叉死锁）则超时标红。
    if (ry.junctions.has(nk)) {
      const isHead = ry.updateGate(nk, this);
      if (!isHead) {
        this.state = 'waiting';
        // 交叉口排队给更长的超时（队头可能只是在等站），到点才按交叉死锁标红
        this.bumpWait(ry, FG.Config.TRAIN_MEET_WAIT_MAX * 2);
        return;
      }
    }
    // 拥堵绕行：尝试按当前车流重新寻路；找到首格不同（即不立即顶住当前格）的空路则改道
    if (this.rerouteCd === 0) {
      this.rerouteCd = FG.Config.TRAIN_REROUTE_CD;
      const alt = ry.findRoute(this.x, this.y, station.x, station.y, this.id);
      if (alt && alt.length) {
        const ak = FG.Utils.key(alt[0].x, alt[0].y);
        if (ak !== nk && ry.canEnter(this, ak)) {
          this.path = alt;
          ry.rebook(this, alt);
          ry.logOnce(this, 'detour', '🚆 ' + this.id + '：前方区间拥堵，改走绕行线路', 'info');
          this.state = 'moving';
          this.waitTicks = 0;
          return;
        }
      }
    }
    // 对向顶住（单线会车）：先会车等待；同侧跟车/前车装卸 → 等站排队（正常排队永不标红）
    const headOn = holder ? this.isHeadOn(ry, holder, nk) : false;
    if (headOn) {
      this.state = 'meeting';
      this.bumpWait(ry, FG.Config.TRAIN_MEET_WAIT_MAX);
    } else {
      this.state = 'waiting';
      this.bumpWait(ry, 0);
    }
  }

  /** 连续等待计时；waitTicks 达 limit（tick）仍未疏解则升级为标红提示；limit=0 永不标红
   *  （等站排队属正常排队；只有单线会车与交叉口 FIFO 死锁才超时提示改线） */
  bumpWait(ry, limit) {
    this.waitTicks++;
    if (limit > 0 && this.waitTicks >= limit) {
      this.state = 'blocked';
      ry.logOnce(this, 'meetmax', '🚆 ' + this.id + '：区间长时间无法疏解（会车/交叉口死锁），请铺设会车线/复线或改计划', 'error');
    }
  }

  /**
   * 本车要进 nk 而 holder 持有/预留 nk：判断是否对向会车。
   *  - holder 已物理占住 nk（停在该格）：它要么朝本车方向即将离开（对向顶牛），
   *    要么本车在它身后/侧方（排队、交叉口汇入）——用 holder 的朝向 + 本车来侧判断；
   *  - holder 只在 nk 前方预留：取它路径/预留上最靠近 nk 的格作为其来侧；
   *  两车分居 nk 相反侧（方向向量点积为 -1）即对向。
   */
  isHeadOn(ry, holder, nk) {
    const [tx, ty] = nk.split(',').map(Number);
    let hx = holder.x, hy = holder.y;
    if (hx === tx && hy === ty) {
      // holder 正占住 nk：它朝向（dir）的反方向即其「来侧」。
      // 对向 ⇔ 本车来侧方向 == holder 朝 nk 外的前进方向（即 holder 车头正对着本车）
      const v = FG.Utils.dirVec(holder.dir);
      const fx = tx + v.x, fy = ty + v.y;
      // holder 前方（可能驶向的格）若是本车来侧 → 对向
      let mx = this.x, my = this.y;
      if (!adjacentTo(mx, my, tx, ty)) {
        const i = this.path ? this.path.findIndex(p => FG.Utils.key(p.x, p.y) === nk) : -1;
        if (i > 0) { mx = this.path[i - 1].x; my = this.path[i - 1].y; }
        else return false;
      }
      return mx === fx && my === fy;
    }
    // holder 最靠近 nk 的已持有格：物理格优先，其次路径中、再其次预留中与 nk 相邻的格
    if (!adjacentTo(hx, hy, tx, ty)) {
      let best = null;
      if (holder.path) for (const p of holder.path) {
        if (adjacentTo(p.x, p.y, tx, ty)) { best = p; break; }
      }
      if (!best) {
        for (const [rk, rid] of ry.reserve) {
          if (rid !== holder.id) continue;
          const [rx, ry2] = rk.split(',').map(Number);
          if (adjacentTo(rx, ry2, tx, ty)) { best = { x: rx, y: ry2 }; break; }
        }
      }
      if (best) { hx = best.x; hy = best.y; }
    }
    // 本车来侧：物理格（与 nk 相邻时），否则取路径中 nk 前一格
    let mx = this.x, my = this.y;
    if (!adjacentTo(mx, my, tx, ty)) {
      const i = this.path ? this.path.findIndex(p => FG.Utils.key(p.x, p.y) === nk) : -1;
      if (i > 0) { mx = this.path[i - 1].x; my = this.path[i - 1].y; }
      else return false;
    }
    if (!adjacentTo(mx, my, tx, ty) || !adjacentTo(hx, hy, tx, ty)) return false;
    // 两车分居 nk 的相反侧（两车相对 nk 的方向向量点积为 -1）→ 对向顶牛
    return (mx - tx) * (hx - tx) + (my - ty) * (hy - ty) === -1;
  }

  /** 跨格动画计时结束：车头落到新格 */
  commitArrival(ry) {
    // 由起步时记录的目标推进（path 已 shift；用占用反推）
    let nx = this.x, ny = this.y;
    for (const [k, id] of ry.occupy) {
      if (id === this.id) { const [x, y] = k.split(',').map(Number); nx = x; ny = y; break; }
    }
    this.x = nx; this.y = ny;
    const wasClearing = this.clearing;
    // 单程末站清道：驶离一格即结束并待命，不再寻路回站（冷却清零，避免在区间外残留禁停）
    if (wasClearing) {
      this.clearing = false;
      this.leaveCooldown = 0;
      this.state = 'idle'; this.path = null; ry.releaseReservations(this);
      return;
    }
    if (this.leaveCooldown > 0) this.leaveCooldown--; // 已驶离一格（循环车防单站瞬时重入）
    if (this.path && this.path.length) { ry.rebook(this, this.path); return; } // 行驶途中：续伸预留
    if (!this.path) { this.state = 'moving'; return; }
    {
      const stop = this.plan.stops[this.stopIdx];
      const station = ry.stationById(stop.stationId);
      if (station && station.x === this.x && station.y === this.y) this.beginDock(station, ry);
      else { this.state = 'noroute'; this.path = null; }
    }
  }

  /** (x,y) 的任一相邻空闲（无他车物理占用/预留）轨格（离站冷却时驶离用） */
  neighborRail(ry, x, y) {
    for (let d = 0; d < 4; d++) {
      const v = FG.Utils.dirVec(d);
      const nx = x + v.x, ny = y + v.y;
      const nk = FG.Utils.key(nx, ny);
      if (!ry.nodes.has(nk)) continue;
      if (!ry.canEnter(this, nk)) continue;
      return { x: nx, y: ny };
    }
    return null;
  }

  /** 申请向某相邻轨格起步（离站冷却强制驶离用：含区间预留/交叉口闸门），返回是否成功 */
  claimToward(ry, next) {
    const nk = FG.Utils.key(next.x, next.y);
    if (!ry.canEnter(this, nk)) { this.state = 'blocked'; return false; }
    ry.occupy.delete(FG.Utils.key(this.x, this.y));
    const oldReserve = ry.reserve.get(nk);
    if (oldReserve === this.id) ry.reserve.delete(nk);
    ry.occupy.set(nk, this.id);
    this.px = this.x; this.py = this.y;
    const d = dirFromTo(this.x, this.y, next.x, next.y);
    if (d >= 0) this.dir = d;
    if (this.path && this.path.length && this.path[0].x === next.x && this.path[0].y === next.y) this.path.shift();
    this.moveTimer = FG.Config.TRAIN_MOVE_TICKS - 1;
    this.state = 'moving';
    return true;
  }

  // ================= 停站装卸 =================
  beginDock(station, ry) {
    this.state = 'docked';
    this.dwell = 0;
    this.moveTimer = 0;
    // 停站期间释放全部前方区间预留与交叉口排队：只占站格，不长期压住区间供后续列车通行/绕行
    if (ry) {
      ry.releaseReservations(this);
      for (const q of ry.gates.values()) {
        const i = q.indexOf(this.id);
        if (i >= 0) q.splice(i, 1);
      }
    }
    const stop = this.plan.stops[this.stopIdx];
    this.work = { rem: stop.count || 0 };
    this.waitTicks = 0;
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
    this.path = null;
    const oneWayEnd = !this.plan.loop && this.stopIdx >= this.plan.stops.length - 1;
    // 冷却期间：循环车继续行驶到下一站；单程末站驶离后待命（不继续占站）
    this.clearing = oneWayEnd;
    this.leaveCooldown = 2;
    if (!this.plan.stops.length) { this.state = 'idle'; return; }
    if (!oneWayEnd) {
      this.advanceStop();
      this.state = 'moving';
    } else {
      this.state = 'idle';
    }
    // 发车即按新目标重新寻路与区间预留（旧停靠路径已在 beginDock 时释放）
    if (ry) { ry.releaseReservations(this); this.rerouteCd = 0; }
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

/** (ax,ay) 与 (bx,by) 是否四邻相邻 */
function adjacentTo(ax, ay, bx, by) {
  return Math.abs(ax - bx) + Math.abs(ay - by) === 1;
}

/** 相邻格方向索引（0~3），不相邻返回 -1 */
function dirFromTo(fx, fy, tx, ty) {
  for (let d = 0; d < 4; d++) {
    const v = FG.Utils.dirVec(d);
    if (fx + v.x === tx && fy + v.y === ty) return d;
  }
  return -1;
}
