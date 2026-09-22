/**
 * 维修页：备件库存 / 工单列表（优先级）/ 高磨损预警 / 归档记录
 */
import { FG } from '../../engine';
import { useTickThrottle } from '../../hooks';
import { Section, ProgressBar } from './ui.jsx';

const PRIO_ORDER = { high: 0, normal: 1, low: 2 };
const PRIO_CN = { high: '高', normal: '中', low: '低' };
const ARCHIVE_TXT = { done: '✅ 已修复', canceled: '取消', demolished: '设备拆除' };

export default function RepairTab({ game, goTab }) {
  useTickThrottle(300);
  const mo = game.maintenance;

  if (!mo.enabled) {
    return (
      <Section title="🔧 预测性维护">
        <div style={{ color: 'var(--text-dim)', fontSize: 11, lineHeight: 1.8 }}>
          在科技树研究「<b style={{ color: 'var(--accent2)' }}>预测性维护</b>」（前置：高级电子学）后开启：<br />
          · 生产设备随运转积累磨损，磨损满后<b style={{ color: 'var(--red)' }}>故障停机</b>并自动生成维修工单；<br />
          · 工单按<b>高/中/低优先级</b>从全图物流（箱子/地面堆）预留<b>备件</b>，同级轮转公平；<br />
          · 备件齐备后停机检修 2 秒，更换备件、磨损清零、恢复生产；<br />
          · 取消工单或拆除设备返还未用备件；设备升级衔接工单状态；全部状态随存档保存。
        </div>
      </Section>
    );
  }

  const inv = game.inventory();
  const spareN = inv.sparePart || 0;
  const sorted = mo.orders.slice().sort((a, b) => PRIO_ORDER[a.priority] - PRIO_ORDER[b.priority]);

  const warns = [];
  for (const b of game.map.buildings.values()) {
    if (!mo.wearsOut(b) || b.broken) continue;
    if (mo.wearRatio(b) >= FG.Config.WEAR_WARN) warns.push(b);
  }
  warns.sort((a, b) => mo.wearRatio(b) - mo.wearRatio(a));

  return (
    <>
      <Section title={<>备件库存：<span style={{ color: 'var(--accent2)' }}>{FG.Utils.fmtNum(spareN)}</span></>}>
        <div style={{ color: 'var(--text-dim)', fontSize: 11, lineHeight: 1.6 }}>
          备件由<b>组装机</b>生产（齿轮×1 + 铁板×1），经传送带/箱子接入全图物流。<br />
          故障工单自动从箱子/地面堆按优先级预留备件，预留即移出物流。
        </div>
      </Section>

      <Section title={`维修工单（${mo.orders.length}）`}>
        {mo.orders.length === 0 && (
          <div style={{ color: 'var(--text-dim)', fontSize: 11 }}>暂无故障设备，产线运转正常</div>
        )}
        {sorted.map(o => {
          const b = game.map.buildingAt(o.x, o.y);
          const have = o.stock.sparePart || 0;
          const stTxt = o.upgrading ? { t: '升级中挂起', c: 'st-blocked' }
            : o.state === 'repairing' ? { t: '检修中', c: 'st-active' }
            : o.waiting ? { t: '缺备件', c: 'st-waiting' }
            : { t: '待检修', c: 'st-stage' };
          return (
            <div className="bp-plan" key={o.id}>
              <div className="bp-head">
                <span title={o.id}>🛠 {b ? b.def.name : '设备已拆除'}（{o.x},{o.y}）</span>
                <span className={'plan-st ' + stTxt.c}>{stTxt.t}</span>
              </div>
              <ProgressBar
                pct={have / o.need}
                color={o.state === 'repairing' ? 'var(--green)' : 'var(--orange)'}
              />
              <div style={{ fontSize: 11, color: 'var(--text-dim)' }}>
                备件 {have}/{o.need}
                {o.state === 'repairing' ? ' · 停机检修中' : ''}
                {o.upgrading ? ' · 设备升级中，暂停备料（不占料）' : ''}
              </div>
              <div className="prio-row plan-prio">
                {['high', 'normal', 'low'].map(id => (
                  <button key={id}
                    className={'prio-btn prio-' + id + (o.priority === id ? ' active' : '')}
                    onClick={() => mo.setPriority(o.id, id)}>{PRIO_CN[id]}</button>
                ))}
              </div>
              <div className="action-row">
                <button onClick={() => {
                  const bd = game.map.buildingAt(o.x, o.y);
                  if (bd) { game.selectBuilding(bd); goTab('info'); }
                }}>定位设备</button>
                <button className="danger" onClick={() => mo.cancel(o.id)}>取消（返还备件）</button>
              </div>
            </div>
          );
        })}
      </Section>

      <Section title={`高磨损预警（${warns.length}）`}>
        {warns.length === 0 && (
          <div style={{ color: 'var(--text-dim)', fontSize: 11 }}>
            暂无磨损超过 {Math.round(FG.Config.WEAR_WARN * 100)}% 的设备
          </div>
        )}
        {warns.slice(0, 12).map(b => {
          const pct = Math.round(mo.wearRatio(b) * 100);
          return (
            <div className="slot-row" key={b.x + ',' + b.y} style={{ cursor: 'pointer' }}
              onClick={() => { game.selectBuilding(b); goTab('info'); }}>
              <span className="sl-name">{b.def.name}（{b.x},{b.y}）</span>
              <div className="sl-bar"><div className="fill" style={{ width: pct + '%', background: 'var(--orange)' }} /></div>
              <span className="sl-count">{pct}%</span>
            </div>
          );
        })}
      </Section>

      {mo.archived.length > 0 && (
        <Section title={`维修记录（${mo.archived.length}）`}>
          {mo.archived.slice(0, 10).map((a, i) => (
            <div className="slot-row" key={i}>
              <span className="sl-name">{ARCHIVE_TXT[a.state] || a.state} · {a.name}（{a.x},{a.y}）</span>
              <span style={{ color: 'var(--text-dim)', fontSize: 11 }}>
                {a.id} · {FG.Utils.fmtTime(a.at || 0)}
              </span>
            </div>
          ))}
        </Section>
      )}
    </>
  );
}
