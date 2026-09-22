/**
 * 维修工单区块（建筑详情内嵌版）
 */
import { FG } from '../../engine';
import { Section, InfoGrid, ProgressBar } from './ui.jsx';

export default function MaintenanceBlock({ game, b, embedded }) {
  const mo = game.maintenance;
  const ratio = mo.wearRatio(b);
  const pct = Math.round(ratio * 100);
  const warn = ratio >= FG.Config.WEAR_WARN;

  if (!b.broken) {
    return (
      <Section title="磨损与维修">
        <InfoGrid rows={[['磨损', pct + '%', warn ? 'status-blocked' : '']]} />
        <ProgressBar pct={ratio} color={warn ? 'var(--orange)' : 'var(--green)'} />
        <div style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 3 }}>
          磨损满后故障停机，自动生成维修工单，按优先级预留备件检修。
        </div>
      </Section>
    );
  }

  const o = mo.orderAt(b.x, b.y);
  return (
    <Section title="磨损与维修">
      <div style={{ color: 'var(--red)', fontWeight: 600, marginBottom: 4 }}>🛠 故障停机：等待维修</div>
      {o ? (
        <>
          <InfoGrid rows={[
            ['工单', `${o.id} · ${({ high: '高', normal: '中', low: '低' })[o.priority]}优先`],
            ['状态', o.upgrading ? '设备升级中（暂停备料）'
              : o.state === 'repairing' ? '停机检修中…'
              : o.waiting ? '缺备件等待' : '备件已齐备，待检修'],
            ['备件', `${o.stock.sparePart || 0}/${o.need}`],
          ]} />
          {o.state === 'repairing'
            ? <ProgressBar pct={1 - o.repairTimer / FG.Config.REPAIR_TIME_TICKS} />
            : <ProgressBar pct={(o.stock.sparePart || 0) / o.need} color="var(--orange)" />}
          <div className="prio-row" style={{ marginTop: 5 }}>
            {[['high', '高'], ['normal', '中'], ['low', '低']].map(([id, nm]) => (
              <button key={id}
                className={'prio-btn prio-' + id + (o.priority === id ? ' active' : '')}
                onClick={() => mo.setPriority(o.id, id)}>{nm}</button>
            ))}
          </div>
          <div className="action-row" style={{ marginTop: 4 }}>
            <button className="danger" onClick={() => mo.cancel(o.id)}>取消工单（返还备件）</button>
          </div>
        </>
      ) : (
        <>
          <div style={{ fontSize: 11, color: 'var(--text-dim)', lineHeight: 1.6, marginBottom: 4 }}>
            工单已取消，设备仍停机。备件由组装机生产（齿轮×1+铁板×1）。
          </div>
          <div className="action-row">
            <button onClick={() => mo.report(b)}>重新报修（生成工单）</button>
          </div>
        </>
      )}
    </Section>
  );
}
