/**
 * 一键流水线选择弹窗：预设产线卡片（含建材成本、科技锁定原因）
 */
import { FG } from '../../engine';
import { useEventVersion } from '../../hooks';
import { useModal } from '../ModalContext.jsx';
import { ModalShell } from './ModalShell.jsx';

export default function PipelinesModal({ game }) {
  const modal = useModal();
  // 研究完成可能改变锁定态
  useEventVersion(['research:complete']);

  if (game.state !== 'playing') return null;
  const presets = FG.Pipelines.list();

  return (
    <ModalShell title="⚡ 一键流水线">
      <div style={{ color: 'var(--text-dim)', fontSize: 11, lineHeight: 1.7, marginBottom: 10 }}>
        选择一套预设产线，系统会<b style={{ color: 'var(--accent2)' }}>自动搜索合适落点</b>（矿机对准矿脉、水泵紧邻水域）并进入预览：<br />
        <b>左键</b> 提交整套施工计划 · <b>R</b> 旋转 · <b>F</b> 重新智能选位 · <b>Esc</b> 取消。<br />
        施工计划自动从<b>箱子/地面物料堆</b>预留建材，缺料时挂起等待，建成即接入生产调度。
      </div>
      <div className="pl-grid">
        {presets.map(p => {
          const bp = FG.Pipelines.blueprintOf(p);
          const cost = FG.Blueprint.costOf(bp);
          const locked = FG.Pipelines.lockedReasons(p, game);
          const costStr = Object.keys(cost).map(k =>
            `${FG.Items.byId(k).name}×${cost[k]}`).join(' · ');
          return (
            <div
              key={p.id}
              className={'pl-card' + (locked.length ? ' locked' : '')}
              onClick={() => {
                if (locked.length) return;
                modal.close();
                game.startPipeline(p);
              }}
            >
              <div className="pl-head">
                <span className="pl-icon">{p.icon}</span>
                <span className="pl-name">{p.name}</span>
                <span className="pl-size">{bp.w}×{bp.h} · {bp.entries.length} 栋</span>
              </div>
              <div className="pl-chain">{p.chain}</div>
              <div className="pl-desc">{p.desc}</div>
              <div className="pl-cost">建材：{costStr || '无'}</div>
              {locked.length
                ? <div className="pl-lock">🔒 {locked.join('、')}</div>
                : <div className="pl-go">点击放置 →</div>}
            </div>
          );
        })}
      </div>
    </ModalShell>
  );
}
