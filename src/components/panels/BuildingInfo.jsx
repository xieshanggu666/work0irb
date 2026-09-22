/**
 * 建筑详情：状态/配方/槽位/机械臂规则/供料优先级/磨损/车站/交付站/机务段/操作按钮
 */
import { FG } from '../../engine';
import { useEventVersion } from '../../hooks';
import { Section, InfoGrid, ProgressBar, SlotRow, STATUS_NAMES, PRIO_OPTS } from './ui.jsx';
import MaintenanceBlock from './MaintenanceBlock.jsx';
import DeliveryBlock from './DeliveryBlock.jsx';

export default function BuildingInfo({ game, b }) {
  // 该面板上的操作会就地改变 b；selection:change / recipe:change 已在 SidePanel 订阅，
  // 这里额外监听维修/合同变化即可（节流刷新由 SidePanel 统一处理）。
  useEventVersion(['maintenance:change', 'contracts:change']);

  const isBelt = b.def.beltTier !== undefined;
  const isInserter = b.def.inserterTier !== undefined;
  const isConsumer = b.def.recipeBuilding || b.type === 'lab';

  return (
    <>
      <Section title={b.def.name}>
        <InfoGrid rows={[
          ['状态', STATUS_NAMES[b.status] || b.status, 'status-' + b.status],
          ['坐标', `(${b.x}, ${b.y})`],
          ...(isBelt || isInserter ? [['方向', FG.Utils.dirName(b.dir)]] : []),
          ...(isBelt ? [['物品', `${b.items.length}/${FG.Config.BELT_CAP}`]] : []),
          ...(b.type === 'pipe' ? [['流体', `${(b.level / FG.Config.FLUID_PIPE_CAP * 100).toFixed(0)}%`]] : []),
          ...(isInserter ? [
            ['手持', b.held ? FG.Items.byId(b.held.type).name : '空'],
            ['筛选', b.filter ? FG.Items.byId(b.filter).name : '任意'],
            ['按需供给', b.demandMode ? '开' : '关'],
          ] : []),
          ...(b.type === 'miner' ? [['矿种', b.oreType ? FG.Items.byId(b.oreType).name : '无']] : []),
          ...(b.type === 'miner' && b.oreType ? [['剩余', FG.Utils.fmtNum(game.map.amountAt(b.x, b.y))]] : []),
          ...(isConsumer ? [['供料优先级', { high: '高', normal: '中', low: '低' }[b.priority] || '中']] : []),
          ...(b.def.recipeBuilding ? [['产量', FG.Utils.fmtNum(b.totalCrafted)]] : []),
        ]} />
        <div style={{ color: 'var(--text-dim)', fontSize: 11, marginTop: 6, lineHeight: 1.5 }}>
          {b.def.desc}
        </div>
      </Section>

      {isInserter && <InserterRules game={game} b={b} />}
      {isConsumer && <PriorityPicker b={b} />}
      {game.maintenance && game.maintenance.enabled && game.maintenance.wearsOut(b) && (
        <MaintenanceBlock game={game} b={b} embedded />
      )}

      {b.def.recipeBuilding && <RecipePicker game={game} b={b} />}
      <SlotsBlock game={game} b={b} />
      {b.def.storage && <StorageBlock b={b} />}
      {b.def.railStation && <StationBlock game={game} b={b} />}
      {b.def.delivery && <DeliveryBlock game={game} b={b} />}
      {b.def.railDepot && <DepotBlock game={game} b={b} />}

      <div className="action-row">
        {(isBelt || isInserter) && (
          <button onClick={() => { b.dir = (b.dir + 1) % 4; FG.Events.emit('selection:change', b); }}>旋转</button>
        )}
        <button className="danger" onClick={() => game.removeBuilding(b)}>拆除</button>
        <button onClick={() => { game.selection = null; FG.Events.emit('selection:change'); }}>取消选择</button>
      </div>
    </>
  );
}

function InserterRules({ game, b }) {
  const wanted = game.sim ? game.sim.inserterWanted(b) : null;
  let needTxt = '—';
  if (wanted === null) needTxt = '任意（终端/箱子）';
  else if (!wanted.size) needTxt = '下游暂不缺料';
  else needTxt = Array.from(wanted).slice(0, 5).map(id => FG.Items.byId(id).name).join('、')
    + (wanted.size > 5 ? '…' : '');

  const solids = FG.Items.list().filter(i => !i.fluid);
  return (
    <Section title="取放规则">
      <label className="cfg-row">
        <input
          type="checkbox"
          checked={!!b.demandMode}
          onChange={(e) => { b.demandMode = e.target.checked; FG.Events.emit('selection:change', b); }}
        />
        <span>按需供给：按下游缺口数量与在途预留联动（沿带追踪 {FG.Config.BELT_TRACE_DEPTH} 格）</span>
      </label>
      <div style={{ fontSize: 11, color: 'var(--text-dim)', margin: '4px 0 6px' }}>
        当前需求：<b style={{ color: 'var(--accent2)' }}>{needTxt}</b>
      </div>
      <div style={{ fontSize: 11, color: 'var(--text-dim)', marginBottom: 4 }}>筛选物品（点击切换，再点取消）：</div>
      <div className="filter-grid">
        <button
          className={'filter-chip' + (b.filter === null ? ' active' : '')}
          onClick={() => { b.filter = null; FG.Events.emit('selection:change', b); }}
        >任意</button>
        {solids.map(i => (
          <button
            key={i.id}
            className={'filter-chip' + (b.filter === i.id ? ' active' : '')}
            onClick={() => { b.filter = b.filter === i.id ? null : i.id; FG.Events.emit('selection:change', b); }}
          >{i.name}</button>
        ))}
      </div>
    </Section>
  );
}

function PriorityPicker({ b }) {
  const cur = b.priority || 'normal';
  return (
    <Section title="生产线供料优先级">
      <div className="prio-row">
        {PRIO_OPTS.map(([id, name, tip]) => (
          <button
            key={id}
            className={'prio-btn prio-' + id + (cur === id ? ' active' : '')}
            title={tip}
            onClick={() => { b.priority = id; FG.Events.emit('selection:change', b); }}
          >{name}</button>
        ))}
      </div>
      <div style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 4, lineHeight: 1.5 }}>
        料源紧张时高优先级产线先得料，同优先级轮转均分；在途货物自动预留，在带面上以青色环标记。
      </div>
    </Section>
  );
}

function RecipePicker({ game, b }) {
  const recipes = FG.Recipes.forBuilding(b.type);
  const r = b.recipe ? FG.Recipes.byId(b.recipe) : null;
  return (
    <Section title="配方">
      {r && (
        <>
          <ProgressBar pct={Math.min(1, b.progress / r.time)} />
          <div style={{ fontSize: 11, color: 'var(--text-dim)' }}>
            {r.name} · {((Math.min(1, b.progress / r.time)) * 100).toFixed(0)}%
          </div>
        </>
      )}
      <div className="recipe-list" style={{ marginTop: 6 }}>
        {recipes.map(rc => {
          const unlocked = game.research.isRecipeUnlocked(rc.id);
          const tech = FG.Research.byId(rc.unlockedBy);
          return (
            <button
              key={rc.id}
              className={'recipe-btn' + (b.recipe === rc.id ? ' selected' : '') + (unlocked ? '' : ' locked')}
              title={unlocked ? '' : '需要研究：' + (tech ? tech.name : rc.unlockedBy)}
              onClick={() => { if (unlocked) game.setRecipe(b, rc.id); }}
            >
              <span className="rc-name">{rc.name}</span>
              <span className="rc-ing">
                {rc.ingredients.map(i => `${FG.Items.byId(i.item).name}×${i.count}`).join(' + ')}
              </span>
            </button>
          );
        })}
      </div>
    </Section>
  );
}

function SlotsBlock({ game, b }) {
  const inputs = Object.keys(b.slots.inputs);
  const outputs = Object.keys(b.slots.outputs);
  if (!inputs.length && !outputs.length) return null;
  const recipe = b.recipe ? FG.Recipes.byId(b.recipe) : null;
  const needed = new Set(recipe
    ? recipe.ingredients.filter(i => !FG.Items.isFluid(i.item)).map(i => i.item) : []);
  return (
    <Section title="物料">
      {inputs.map(k => {
        const s = b.slots.inputs[k];
        const orphan = b.def.recipeBuilding && !needed.has(k);
        return <SlotRow key={'in' + k} name={(orphan ? '残留 ' : '输入 ') + FG.Items.byId(k).name}
          count={s.count} cap={s.cap} warn={orphan} />;
      })}
      {outputs.map(k => {
        const s = b.slots.outputs[k];
        return <SlotRow key={'out' + k} name={'输出 ' + FG.Items.byId(k).name} count={s.count} cap={s.cap} />;
      })}
      {Object.keys(b.fluidTanks).length > 0 && Object.entries(b.fluidTanks).map(([k, v]) => (
        <SlotRow key={'f' + k} name={FG.Items.byId(k).name} count={v} cap={FG.Config.FLUID_TANK_CAP} />
      ))}
    </Section>
  );
}

function StorageBlock({ b }) {
  return (
    <Section title={b.def.railStation ? '车站货位（接入产线供料）' : '存储'}>
      {b.chest.map((s, i) => (
        <SlotRow key={i} name={s.type ? FG.Items.byId(s.type).name : '空'} count={s.count} cap={s.cap} />
      ))}
    </Section>
  );
}

function StationBlock({ game, b }) {
  const users = [];
  for (const tr of game.railway.trains) {
    tr.stops.forEach((s, i) => { if (s.stationId === b.stationId) users.push({ tr, i }); });
  }
  return (
    <Section title="火车站">
      <InfoGrid rows={[['站号', b.stationId]]} />
      <label className="cfg-row" style={{ margin: '4px 0' }}>
        站名
        <input
          type="text"
          className="txt-input"
          defaultValue={b.stationName || ''}
          maxLength={12}
          onChange={(e) => { b.stationName = e.target.value.trim() || ('站点 ' + b.stationId.slice(1)); }}
        />
      </label>
      <div style={{ fontSize: 11, color: 'var(--text-dim)', lineHeight: 1.5 }}>
        机械臂/传送带可直接与本站货位转运：到站物料即接入按需物流，供周边产线使用。
      </div>
      {users.length > 0 && (
        <div style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 6 }}>停靠列车：</div>
      )}
      {users.map(({ tr, i }) => (
        <div className="slot-row" key={tr.id + i}>
          <span className="sl-name">🚆 {tr.id}</span>
          <span style={{ color: 'var(--text)' }}>
            第 {i + 1} 站 · {tr.stops[i].action === 'load' ? '装' : '卸'}{' '}
            {tr.stops[i].item ? FG.Items.byId(tr.stops[i].item).name : '任意'}×{tr.stops[i].count}
          </span>
        </div>
      ))}
    </Section>
  );
}

function DepotBlock({ game, b }) {
  return (
    <Section title="机务段">
      <div style={{ fontSize: 11, color: 'var(--text-dim)', lineHeight: 1.5, marginBottom: 6 }}>
        向相邻空轨道编组一列新车；选中列车可编辑其运输计划（站点顺序与装卸规则）。
      </div>
      <div className="action-row">
        <button onClick={() => {
          const tr = game.railway.spawnTrain(b);
          if (tr) {
            game.logMsg('🚆 已编组列车 ' + tr.id + '：选中列车添加停靠站点与装卸规则', 'unlock');
            game.selectBuilding(tr);
          } else {
            game.logMsg('⚠ 机务段四周没有空闲轨道（接轨格被占或未铺轨）', 'error');
          }
        }}>🚆 编组列车</button>
      </div>
      <div style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 4 }}>
        在役列车 {game.railway.trains.length} 列
      </div>
    </Section>
  );
}
