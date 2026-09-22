/**
 * 地图悬浮提示内容生成（移植自原 js/main.js 的 updateTooltip，去掉 DOM 操作）。
 * 返回 HTML 字符串；无内容时返回 null。
 */
import { FG } from '../engine';

const TRAIN_STATUS = {
  moving: '行驶中', docked: '装卸中', waiting: '等站排队',
  blocked: '堵死/让行', noroute: '断路', paused: '已停运', idle: '待命',
};
const BUILDING_STATUS = {
  working: '生产中/流动', starving: '缺料', blocked: '堵塞',
  idle: '闲置', empty: '枯竭', broken: '故障停机',
};

export function buildTooltip(game, tile) {
  const m = game.map;
  const b = m.buildingAt(tile.x, tile.y);
  const tr = !b && game.railway ? game.railway.trainAt(tile.x, tile.y)
    : (game.railway && b && (b.type === 'rail' || b.def.railStation))
      ? game.railway.trainAt(tile.x, tile.y) : null;
  const pile = !b ? m.pileAt(tile.x, tile.y) : null;
  const planEntry = !b && game.construction ? game.construction.entryAt(tile.x, tile.y) : null;

  let html = '';

  if (tr) {
    html += `<div class="tt-title">🚆 列车 ${tr.id}</div>`;
    html += `<div class="tt-row">状态：<b>${TRAIN_STATUS[tr.state] || tr.state}</b></div>`;
    html += `<div class="tt-row">载货 <b>${tr.cargoTotal()}/${FG.Config.TRAIN_CARGO_CAP}</b> 件 · 停靠 ${tr.stopIdx + 1}/${Math.max(1, tr.stops.length)}</div>`;
    const stop = tr.stops[tr.stopIdx];
    if (stop) {
      const st = game.railway.stationById(stop.stationId);
      html += `<div class="tt-row">目标：<b>${st ? st.stationName : '站点已拆除'}</b> · ${stop.action === 'load' ? '装' : '卸'} ${stop.item ? FG.Items.byId(stop.item).name : '任意'}×${stop.count}</div>`;
    }
    if (tr.cargo.length) {
      html += `<div class="tt-row">${tr.cargo.slice(0, 4).map(s => FG.Items.byId(s.type).name + '×' + s.count).join('、')}${tr.cargo.length > 4 ? '…' : ''}</div>`;
    }
    return html;
  }

  if (b) {
    html += `<div class="tt-title">${b.def.name}</div>`;
    html += `<div class="tt-row">状态：<b${b.status === 'broken' ? ' style="color:#e05c5c"' : ''}>${BUILDING_STATUS[b.status] || b.status}</b></div>`;

    if (game.maintenance && game.maintenance.enabled && game.maintenance.wearsOut(b)) {
      if (b.broken) {
        const o = game.maintenance.orderAt(b.x, b.y);
        html += `<div class="tt-row" style="color:#e05c5c">🛠 故障：${o
          ? '工单 ' + o.id + ' · 备件 ' + (o.stock.sparePart || 0) + '/' + o.need
            + (o.state === 'repairing' ? ' · 检修中' : o.waiting ? ' · 缺件等待' : '')
          : '工单已取消，可在信息页重新报修'}</div>`;
      } else {
        const pct = Math.round(game.maintenance.wearRatio(b) * 100);
        html += `<div class="tt-row">磨损 <b style="color:${pct >= 95 ? '#e05c5c' : pct >= 70 ? '#e8a33d' : 'inherit'}">${pct}%</b></div>`;
      }
    }

    if (b.recipe) {
      const r = FG.Recipes.byId(b.recipe);
      const p = Math.min(1, b.progress / r.time);
      html += `<div class="tt-row">${r.name} <b>${(p * 100).toFixed(0)}%</b></div>`;
    }
    if (b.def.beltTier !== undefined) {
      let merge = 0;
      for (const side of [2, 3]) {
        const sv = FG.Map.beltSideVec(b.dir, side);
        const nb = m.buildingAt(b.x + sv.x, b.y + sv.y);
        if (nb && nb.def.beltTier !== undefined && FG.Map.beltFeedsInto(nb, b)) merge++;
      }
      html += `<div class="tt-row">方向 <b>${FG.Utils.dirName(b.dir)}</b> · ${b.items.length}/${FG.Config.BELT_CAP}${merge ? ` · ${merge} 路汇入` : ''}</div>`;
    }
    if (b.def.inserterTier !== undefined) {
      html += `<div class="tt-row">方向 <b>${FG.Utils.dirName(b.dir)}</b> · 筛选 <b>${b.filter ? FG.Items.byId(b.filter).name : '任意'}</b>${b.demandMode ? ' · 按需' : ''}</div>`;
    }
    if (b.type === 'pipe') {
      html += `<div class="tt-row">流体 <b>${(b.level / FG.Config.FLUID_PIPE_CAP * 100).toFixed(0)}%</b></div>`;
    }
    if (b.type === 'rail') {
      const held = game.railway.occupiedBy(b.x, b.y);
      html += `<div class="tt-row">轨道${held ? ` · <b style="color:#e05c5c">${held} 占用</b>` : ''}</div>`;
    }
    if (b.def.railStation) {
      const held = game.railway.occupiedBy(b.x, b.y);
      const tag = b.def.delivery ? '交付站' : '站号';
      html += `<div class="tt-row">${tag} <b>${b.stationId}</b>${held ? ` · <b style="color:#58c26f">${held} 停靠中</b>` : ''}</div>`;
      const cargo = b.chest.reduce((n, s) => n + s.count, 0);
      html += `<div class="tt-row">货位 <b>${cargo}/${FG.Config.STATION_SLOTS * FG.Config.STATION_SLOT_CAP}</b></div>`;
      if (b.def.delivery && game.contracts) {
        const c = game.contracts.contractAt(b);
        if (c) {
          html += `<div class="tt-row">合同 <b>${FG.Items.byId(c.item).name} ${c.delivered}/${c.qty}</b>
            · 剩 <b>${FG.Utils.fmtTime(game.contracts.remainSec(c))}</b></div>`;
        }
      }
    }
    if (b.def.railDepot) {
      const near = FG.Utils.dirs.map(v => {
        const nb = m.buildingAt(b.x + v.x, b.y + v.y);
        return nb && (nb.type === 'rail' || nb.def.railStation);
      }).filter(Boolean).length;
      html += `<div class="tt-row">接轨 <b>${near}</b> 侧 · 选中可编组发车</div>`;
    }
    if (b.type === 'miner' && b.oreType) {
      html += `<div class="tt-row">${FG.Items.byId(b.oreType).name} <b>${FG.Utils.fmtNum(m.amountAt(b.x, b.y))}</b></div>`;
    }
    return html;
  }

  if (pile) {
    html += `<div class="tt-title">地面物料</div>`;
    for (const s of pile.slice(0, 6)) {
      html += `<div class="tt-row">${FG.Items.byId(s.type).name} <b>×${FG.Utils.fmtNum(s.count)}</b></div>`;
    }
    html += `<div class="tt-row" style="margin-top:3px">在此格放置建筑可回收</div>`;
    return html;
  }

  if (planEntry) {
    const p = planEntry.plan, e = planEntry.entry;
    const def = FG.Buildings.byId(e.type);
    const cost = FG.Buildings.costOf(e.type);
    const eIdx = p.entries.indexOf(e);
    const sIdx = game.construction.stageOfEntry(p, eIdx);
    const activeTo = p.stages && p.stages.length
      ? p.stages[Math.min(p.activeStage || 0, p.stages.length - 1)].cut : p.entries.length;
    html += `<div class="tt-title">🏗 ${p.name}</div>`;
    html += `<div class="tt-row">待建：<b>${def.name}</b>（${FG.Utils.dirName(e.dir)}） · 阶段 ${sIdx + 1}/${p.stages.length}</div>`;
    const stTxt = p.paused ? '已暂停（预留已返还）'
      : p.blocked ? '等待前置计划'
      : p.stageBlocked ? (p.stageReason || '等待前置阶段放行')
      : (eIdx >= activeTo) ? '等待前置阶段放行（不占料）'
      : p.waiting ? '缺料等待（可建部分先行）'
      : '施工中';
    html += `<div class="tt-row">状态：<b>${stTxt}</b></div>`;
    const parts = Object.keys(cost).map(k =>
      `${FG.Items.byId(k).name} ${Math.min(e.stock[k] || 0, cost[k])}/${cost[k]}`);
    if (parts.length) html += `<div class="tt-row">建材：${parts.join(' · ')}</div>`;
    return html;
  }

  // 地形
  const ore = m.ores[tile.y][tile.x];
  if (ore) {
    html += `<div class="tt-title">${FG.Items.byId(ore.type).name}</div>`;
    html += `<div class="tt-row">储量 <b>${FG.Utils.fmtNum(ore.amount)}</b></div>`;
    return html;
  }
  if (m.isOil(tile.x, tile.y)) {
    return `<div class="tt-title">油田</div><div class="tt-row">放置抽油机抽取原油</div>`;
  }
  if (m.isWater(tile.x, tile.y)) {
    return `<div class="tt-title">水域</div><div class="tt-row">放置水泵取水</div>`;
  }
  return null;
}
