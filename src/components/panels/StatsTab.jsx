/**
 * 统计页：全局状态 / 瓶颈分析 / 产出消耗曲线（Canvas）/ 累计产量
 */
import { useEffect, useRef, useState } from 'react';
import { FG } from '../../engine';
import { useTickThrottle } from '../../hooks';
import { Section } from './ui.jsx';

export default function StatsTab({ game }) {
  useTickThrottle(500);
  const stats = game.stats;
  const ids = stats.itemIds().slice(0, 16);
  const [chartItems, setChartItems] = useState(() => ids.slice(0, 4));

  const canvasRef = useRef(null);

  // 每帧重画图表（数据随 tick 变化；组件已被 500ms 节流式地重渲染）
  useEffect(() => {
    drawChart(canvasRef.current, stats, chartItems);
  });

  const defs = stats.deficits();
  const hasIssues = defs.length || stats.agg.starveCount || stats.agg.blockCount;

  function toggleItem(id) {
    setChartItems(prev => {
      if (prev.includes(id)) return prev.filter(i => i !== id);
      if (prev.length >= 5) return prev;
      return [...prev, id];
    });
  }

  return (
    <>
      <Section title="全局状态">
        <div className="info-grid">
          <div className="k">建筑</div><div className="v">{game.totalBuildings()}</div>
          <div className="k">缺料</div>
          <div className="v" style={{ color: stats.agg.starveCount ? 'var(--red)' : undefined }}>
            {stats.agg.starveCount}
          </div>
          <div className="k">堵塞</div>
          <div className="v" style={{ color: stats.agg.blockCount ? 'var(--orange)' : undefined }}>
            {stats.agg.blockCount}
          </div>
        </div>
      </Section>

      <Section title="瓶颈分析（近 30s 消耗>产出）">
        {!hasIssues && <div style={{ color: 'var(--text-dim)', fontSize: 11 }}>暂无瓶颈，流水线运转良好</div>}
        {defs.slice(0, 8).map(d => (
          <div className="bottleneck-item warn" key={d.id}>
            <span>{FG.Items.byId(d.id).name}</span>
            <span className="gap">缺口 {FG.Utils.fmtRate(d.gap)}</span>
          </div>
        ))}
        {Object.entries(stats.agg.starveByItem).map(([item, n]) => (
          <div className="bottleneck-item warn" key={'s' + item}>
            <span>🔴 缺料：{FG.Items.byId(item).name}</span><span className="gap">{n} 座</span>
          </div>
        ))}
        {Object.entries(stats.agg.blockByItem).map(([item, n]) => (
          <div className="bottleneck-item warn" key={'b' + item}>
            <span>🟠 堵塞：{FG.Items.byId(item).name}</span><span className="gap">{n} 座</span>
          </div>
        ))}
      </Section>

      <Section title="产量 / 消耗曲线（近 4 分钟）">
        <div className="stats-toolbar">
          {ids.map(id => (
            <span
              key={id}
              className={'chip-item' + (chartItems.includes(id) ? ' active' : '')}
              onClick={() => toggleItem(id)}
            >{FG.Items.byId(id).name}</span>
          ))}
        </div>
        <div className="chart-box"><canvas ref={canvasRef} style={{ width: '100%', height: 110 }} /></div>
        <div style={{ fontSize: 10, color: 'var(--text-dim)' }}>
          <span style={{ color: 'var(--green)' }}>■ 产出</span> &nbsp;{' '}
          <span style={{ color: 'var(--red)' }}>■ 消耗</span>
        </div>
      </Section>

      <Section title="累计产量">
        {ids.length === 0 && <div style={{ color: 'var(--text-dim)', fontSize: 11 }}>尚无生产记录</div>}
        {ids.map(id => {
          const t = stats.total(id);
          const r = stats.rate(id);
          return (
            <div className="rate-row" key={id}>
              <span className="rk">{FG.Items.byId(id).name}</span>
              <span className="rv">
                {FG.Utils.fmtNum(t.p)} 累计 · {FG.Utils.fmtRate(r.p)} 产出 · {FG.Utils.fmtRate(r.c)} 消耗
              </span>
            </div>
          );
        })}
      </Section>
    </>
  );
}

function drawChart(cv, stats, chartItems) {
  if (!cv) return;
  const dpr = window.devicePixelRatio || 1;
  const W = cv.clientWidth, H = cv.clientHeight;
  if (!W || !H) return;
  cv.width = W * dpr;
  cv.height = H * dpr;
  const ctx = cv.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = '#12151d';
  ctx.fillRect(0, 0, W, H);
  if (!chartItems.length) return;

  let maxV = 1;
  const hist = stats.history;
  for (const id of chartItems) {
    for (const bk of hist) maxV = Math.max(maxV, bk.p[id] || 0, bk.c[id] || 0);
  }
  const pad = 4;
  const step = hist.length > 1 ? (W - pad * 2) / (hist.length - 1) : W;

  ctx.strokeStyle = 'rgba(255,255,255,0.06)';
  ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const y = pad + (H - pad * 2) * (i / 4);
    ctx.beginPath(); ctx.moveTo(pad, y); ctx.lineTo(W - pad, y); ctx.stroke();
  }

  for (const id of chartItems) {
    const color = FG.Items.byId(id).color;
    ctx.lineWidth = 2;
    ctx.strokeStyle = color;
    ctx.beginPath();
    hist.forEach((bk, i) => {
      const x = pad + i * step;
      const y = H - pad - ((bk.p[id] || 0) / maxV) * (H - pad * 2);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.stroke();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = 'rgba(224,92,92,0.85)';
    ctx.beginPath();
    hist.forEach((bk, i) => {
      const x = pad + i * step;
      const y = H - pad - ((bk.c[id] || 0) / maxV) * (H - pad * 2);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.stroke();
  }

  ctx.fillStyle = '#8b93a8';
  ctx.font = '10px Consolas';
  ctx.textAlign = 'left';
  chartItems.forEach((id, i) => {
    const r = stats.rate(id);
    ctx.fillText(`${FG.Items.byId(id).name} 产出${FG.Utils.fmtRate(r.p)}`, pad + 4, 14 + i * 12);
  });
}
