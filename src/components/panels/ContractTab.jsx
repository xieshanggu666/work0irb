/**
 * 合同页：全部进行中合同 + 最近成交
 */
import { FG } from '../../engine';
import { Section, ProgressBar } from './ui.jsx';
import { ActiveContract, rewardTxt } from './DeliveryBlock.jsx';

export default function ContractTab({ game, goTab }) {
  const cm = game.contracts;
  return (
    <>
      <Section title={`进行中的供货合同（${cm.active.length}）`}>
        {cm.active.length === 0 && (
          <div style={{ color: 'var(--text-dim)', fontSize: 11, lineHeight: 1.7 }}>
            研究「供货合同」科技后建造<b>交付站</b>（轨道旁），在交付站面板承接合同，
            再用列车把工厂产品分批运抵交付站。<br />
            锁付货物与生产、施工统一争料却独立记账，完成后发放科研物资。
          </div>
        )}
        {cm.active.map(c => {
          const st = game.railway.stationById(c.stationId);
          return (
            <div className="bp-plan" key={c.id}>
              <div className="bp-head">
                <span title={c.id}>
                  {st ? '📍 ' + st.stationName : '⚠ 站点已拆除'} · {FG.Items.byId(c.item).name}×{c.qty}
                </span>
              </div>
              <ActiveContractBody game={game} c={c} />
              <div className="action-row" style={{ marginTop: 4 }}>
                {st && (
                  <button onClick={() => { game.selectBuilding(st); goTab('info'); }}>定位交付站</button>
                )}
                <button className="danger" onClick={() => cm.cancel(c.id)}>取消</button>
              </div>
            </div>
          );
        })}
      </Section>

      <Section title={`最近成交（${cm.history.length}）`}>
        {cm.history.length === 0 && <div style={{ color: 'var(--text-dim)', fontSize: 11 }}>尚无完成的合同</div>}
        {cm.history.slice(0, 10).map((r, i) => (
          <div className="slot-row" key={i}>
            <span className="sl-name">✅ {FG.Items.byId(r.item).name}×{r.qty}</span>
            <span style={{ color: 'var(--accent2)', fontSize: 11 }}>{rewardTxt(r.reward)}</span>
          </div>
        ))}
      </Section>
    </>
  );
}

// 合同条的进度/剩余时间主体（与交付站面板共用计算）
function ActiveContractBody({ game, c }) {
  const cm = game.contracts;
  const remain = cm.remainSec(c);
  const late = remain <= 30;
  return (
    <>
      <div className="bp-head">
        <span className="plan-st" style={{ visibility: 'hidden' }}>.</span>
        <span className={'plan-st ' + (late ? 'st-blocked' : 'st-active')}>{FG.Utils.fmtTime(remain)}</span>
      </div>
      <ProgressBar pct={c.delivered / c.qty} color={late ? '#e05c5c' : '#37c9b0'} />
      <div style={{ fontSize: 11, color: 'var(--text-dim)' }}>
        已锁付 {c.delivered}/{c.qty} · 奖励 {rewardTxt(c.reward)}
      </div>
    </>
  );
}
