/**
 * 列车详情：状态 / 车载货物 / 运输计划编辑（停靠站、装卸规则、循环/单程）
 */
import { useState } from 'react';
import { FG } from '../../engine';
import { useEventVersion } from '../../hooks';
import { Section, InfoGrid, SlotRow } from './ui.jsx';

const TRAIN_STATE_NAMES = {
  moving: '行驶中', docked: '装卸中', waiting: '等站排队',
  blocked: '堵死/让行', noroute: '断路（待轨网接通）', paused: '已停运', idle: '待命',
};

export default function TrainInfo({ game, tr }) {
  useEventVersion(['selection:change']);
  const ry = game.railway;
  const stations = ry.stationList();
  const solids = FG.Items.list().filter(i => !i.fluid);

  const moveStop = (i, dir) => {
    const j = i + dir;
    if (j < 0 || j >= tr.stops.length) return;
    const arr = tr.stops;
    [arr[i], arr[j]] = [arr[j], arr[i]];
    if (tr.stopIdx === i) tr.stopIdx = j;
    else if (tr.stopIdx === j) tr.stopIdx = i;
    FG.Events.emit('selection:change', tr);
  };

  return (
    <>
      <Section title={`🚆 列车 ${tr.id}`}>
        <InfoGrid rows={[
          ['状态', TRAIN_STATE_NAMES[tr.state] || tr.state,
            tr.state === 'docked' ? 'status-working'
              : (tr.state === 'blocked' || tr.state === 'noroute') ? 'status-blocked' : ''],
          ['位置', `(${tr.x}, ${tr.y})`],
          ['载货', `${tr.cargoTotal()}/${FG.Config.TRAIN_CARGO_CAP}`],
          ['停站', tr.stops.length ? `${tr.stopIdx + 1} / ${tr.stops.length}` : '无计划'],
        ]} />
      </Section>

      <Section title="车载货物">
        {tr.cargo.length === 0 && <div style={{ color: 'var(--text-dim)', fontSize: 11 }}>空车</div>}
        {tr.cargo.map((s, i) => (
          <SlotRow key={i} name={FG.Items.byId(s.type).name} count={s.count} cap={FG.Config.TRAIN_CARGO_CAP} />
        ))}
      </Section>

      <Section title={`运输计划（${tr.plan.loop === false ? '单程：末站卸完待命' : '循环执行'}）`}>
        <label className="cfg-row">
          <input
            type="checkbox"
            checked={tr.plan.loop !== false}
            onChange={(e) => { tr.plan.loop = e.target.checked; FG.Events.emit('selection:change', tr); }}
          />
          <span>循环运输：末站完成后自动返回首站；取消则末站卸完即待命</span>
        </label>

        {stations.length === 0 && (
          <div style={{ color: 'var(--red)', fontSize: 11 }}>
            图上还没有火车站：先在轨道旁建「火车站」，再为其添加停靠动作。
          </div>
        )}

        {tr.stops.map((s, i) => {
          const st = ry.stationById(s.stationId);
          return (
            <div className="bp-plan" key={i} style={{ marginBottom: 6 }}>
              <div className="bp-head">
                <span>第 {i + 1} 站 · {st ? st.stationName : '⚠ 站点已拆除'}</span>
                <span className={'plan-st ' + (s.action === 'load' ? 'st-active' : 'st-waiting')}>
                  {s.action === 'load' ? '装货' : '卸货'}
                </span>
              </div>
              <div className="stop-cfg">
                <select value={s.action} onChange={(e) => tr.updateStop(i, { action: e.target.value })}>
                  <option value="unload">卸货（车→站）</option>
                  <option value="load">装货（站→车）</option>
                </select>
                <select value={s.item || ''} onChange={(e) => tr.updateStop(i, { item: e.target.value || null })}>
                  <option value="">任意物品</option>
                  {solids.map(it => <option key={it.id} value={it.id}>{it.name}</option>)}
                </select>
                <input
                  type="number" min="1" max={FG.Config.TRAIN_CARGO_CAP} className="num-input"
                  defaultValue={s.count}
                  key={s.count}
                  onChange={(e) => {
                    const n = parseInt(e.target.value, 10);
                    tr.updateStop(i, { count: isNaN(n) ? 1 : n });
                  }}
                />
              </div>
              <div className="action-row" style={{ marginTop: 4 }}>
                <button disabled={i === 0} onClick={() => moveStop(i, -1)}>↑</button>
                <button disabled={i === tr.stops.length - 1} onClick={() => moveStop(i, 1)}>↓</button>
                <button onClick={() => { if (i === tr.stopIdx) tr.skip(); else tr.removeStop(i); }}>立即跳过</button>
                <button className="danger" onClick={() => tr.removeStop(i)}>删除</button>
              </div>
            </div>
          );
        })}

        {stations.length > 0 && <AddStop game={game} tr={tr} stations={stations} solids={solids} />}
      </Section>

      <div className="action-row">
        <button onClick={() => tr.setPaused(!tr.plan.paused)}>
          {tr.plan.paused ? '▶ 恢复运行' : '⏸ 停运'}
        </button>
        <button onClick={() => tr.skip()}>跳过当前站</button>
        <button className="danger" onClick={() => game.removeTrainSelection()}>解编（货落地）</button>
        <button onClick={() => { game.selection = null; FG.Events.emit('selection:change'); }}>取消选择</button>
      </div>
    </>
  );
}

function AddStop({ tr, stations, solids }) {
  return (
    <StopAddForm
      onAdd={(sid, act, item, n) => tr.addStop(sid, act, item, isNaN(n) ? 1 : n)}
      stations={stations}
      solids={solids}
    />
  );
}

function StopAddForm({ onAdd, stations, solids }) {
  const [sid, setSid] = useState(stations[0] && stations[0].stationId);
  const [act, setAct] = useState('load');
  const [item, setItem] = useState('');
  const [n, setN] = useState(20);
  return (
    <div className="stop-cfg" style={{ marginTop: 6 }}>
      <select value={sid} onChange={(e) => setSid(e.target.value)}>
        {stations.map(s => <option key={s.stationId} value={s.stationId}>{s.stationName} ({s.x},{s.y})</option>)}
      </select>
      <select value={act} onChange={(e) => setAct(e.target.value)}>
        <option value="load">装货</option>
        <option value="unload">卸货</option>
      </select>
      <select value={item} onChange={(e) => setItem(e.target.value)}>
        <option value="">任意物品</option>
        {solids.map(it => <option key={it.id} value={it.id}>{it.name}</option>)}
      </select>
      <input type="number" className="num-input" min="1" value={n} onChange={(e) => setN(parseInt(e.target.value, 10))} />
      <button onClick={() => onAdd(sid, act, item || null, n)}>＋ 添加停靠</button>
    </div>
  );
}
