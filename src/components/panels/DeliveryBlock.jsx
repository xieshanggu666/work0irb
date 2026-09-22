/**
 * 交付站信息区块：进行中合同（独立锁付台账）或合同邀约列表
 */
import { FG } from '../../engine';
import { Section, ProgressBar } from './ui.jsx';

export function rewardTxt(reward) {
  return Object.keys(reward).map(k => FG.Items.byId(k).name + '×' + reward[k]).join('　');
}

export default function DeliveryBlock({ game, b }) {
  const cm = game.contracts;
  const c = cm.contractAt(b);

  return (
    <Section title="🤝 供货合同">
      {c ? (
        <ActiveContract game={game} c={c} />
      ) : (
        <>
          <div style={{ fontSize: 11, color: 'var(--text-dim)', lineHeight: 1.6, marginBottom: 6 }}>
            承接后用<b>列车分批</b>把货物运抵本站。卸入的合同货物立即锁付、独立记账（生产/施工不可动用）；交齐发放科研物资，逾期/取消则释放锁付货物。
          </div>
          {cm.getOffers(b).length === 0 && (
            <div style={{ color: 'var(--text-dim)', fontSize: 11 }}>暂无可接合同</div>
          )}
          {cm.getOffers(b).map((o, i) => (
            <div className="bp-plan" key={i} style={{ marginBottom: 6 }}>
              <div className="bp-head">
                <span>{FG.Items.byId(o.item).name} × {o.qty}</span>
                <span className="plan-st st-waiting">期限 {o.duration}s</span>
              </div>
              <div style={{ fontSize: 11, margin: '2px 0' }}>
                奖励：<b style={{ color: 'var(--accent2)' }}>{rewardTxt(o.reward)}</b>
              </div>
              <div className="action-row" style={{ marginTop: 3 }}>
                <button onClick={() => {
                  const st = game.railway.stationById(b.stationId);
                  if (st) cm.acceptOffer(st, i);
                }}>接单</button>
              </div>
            </div>
          ))}
          <div className="action-row" style={{ marginTop: 4 }}>
            <button onClick={() => cm.refreshOffers(b)}>🔄 刷新邀约</button>
          </div>
        </>
      )}
    </Section>
  );
}

export function ActiveContract({ game, c }) {
  const cm = game.contracts;
  const remain = cm.remainSec(c);
  const late = remain <= 30;
  return (
    <div className="bp-plan">
      <div className="bp-head">
        <span>{FG.Items.byId(c.item).name} × {c.qty}</span>
        <span className={'plan-st ' + (late ? 'st-blocked' : 'st-active')}>剩 {FG.Utils.fmtTime(remain)}</span>
      </div>
      <ProgressBar pct={c.delivered / c.qty} color={late ? '#e05c5c' : '#37c9b0'} />
      <div style={{ fontSize: 11, color: 'var(--text-dim)' }}>
        已锁付 {c.delivered}/{c.qty}（列车到站卸货自动计入，不进站货位）
      </div>
      <div style={{ fontSize: 11, marginTop: 3 }}>
        奖励：<b style={{ color: 'var(--accent2)' }}>{rewardTxt(c.reward)}</b>（完成入站货位）
      </div>
      <div className="action-row" style={{ marginTop: 5 }}>
        <button className="danger" onClick={() => cm.cancel(c.id)}>取消合同（释放锁付）</button>
      </div>
    </div>
  );
}
