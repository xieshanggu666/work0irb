/**
 * 科技树：Canvas 绘制节点与连线，拖拽平移 / 滚轮缩放 / 点击节点查看详情。
 * 详情面板改为 React 状态；打开/关闭/定位通过自定义事件：
 *   fg:open-tech / fg:focus-tech（detail = techId）
 */
import { useEffect, useRef, useState } from 'react';
import { FG } from '../engine';
import { useEventVersion } from '../hooks';

const NODE_R = 27;
const COL_W = 250, ROW_H = 120, M = 50;

function layout() {
  const defs = FG.Research.list();
  const pos = {};
  let maxX = 0, maxY = 0;
  for (const t of defs) {
    pos[t.id] = { x: M + t.col * COL_W, y: M + t.row * ROW_H };
    maxX = Math.max(maxX, t.col);
    maxY = Math.max(maxY, t.row);
  }
  return { pos, w: (maxX + 1) * COL_W + M * 2, h: (maxY + 1) * ROW_H + M * 2 };
}

export default function TechTree({ game, onClose, focusId }) {
  const wrapRef = useRef(null);
  const canvasRef = useRef(null);
  const viewRef = useRef({ zoom: 0.85, panX: 20, panY: 20 });
  const dragRef = useRef(null);
  const movedRef = useRef(false);
  const [hoverId, setHoverId] = useState(null);
  const [selectedId, setSelectedId] = useState(null);
  // 用一个版本号在研究状态变化/窗口缩放后触发重绘
  const [, setDrawV] = useState(0);
  const bumpDraw = () => setDrawV(v => v + 1);

  useEventVersion(['research:start', 'research:complete', 'research:cancel']);

  const nodeState = (id) => {
    const mgr = game.research;
    if (mgr.isDone(id)) return 'done';
    if (mgr.current && mgr.current.id === id) return 'current';
    const t = FG.Research.byId(id);
    return t.prereq.every(p => mgr.isDone(p)) ? 'available' : 'locked';
  };

  const nodeAt = (clientX, clientY) => {
    const canvas = canvasRef.current;
    const rect = canvas.getBoundingClientRect();
    const sx = clientX - rect.left, sy = clientY - rect.top;
    const L = layout();
    const view = viewRef.current;
    for (const [id, p] of Object.entries(L.pos)) {
      const nx = p.x * view.zoom + view.panX;
      const ny = p.y * view.zoom + view.panY;
      if (Math.hypot(sx - nx, sy - ny) < NODE_R * view.zoom + 8) return id;
    }
    return null;
  };

  // 初次打开：适配尺寸
  useEffect(() => {
    const wrap = wrapRef.current, canvas = canvasRef.current;
    const resize = () => {
      const rect = wrap.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      canvas.width = rect.width * dpr;
      canvas.height = rect.height * dpr;
      canvas.style.width = rect.width + 'px';
      canvas.style.height = rect.height + 'px';
      bumpDraw();
    };
    resize();
    // 等一帧让布局完成后再 fit 一次
    const raf = requestAnimationFrame(resize);
    window.addEventListener('resize', resize);
    return () => { cancelAnimationFrame(raf); window.removeEventListener('resize', resize); };
  }, []);

  /** 居中并选中某科技节点 */
  function focusNode(techId) {
    if (!techId) return;
    const L = layout();
    const p = L.pos[techId];
    if (!p) return;
    const rect = wrapRef.current.getBoundingClientRect();
    const view = viewRef.current;
    view.zoom = Math.min(rect.width / L.w, rect.height / L.h, 1);
    view.panX = rect.width / 2 - p.x * view.zoom;
    view.panY = rect.height / 2 - p.y * view.zoom;
    setSelectedId(techId);
    bumpDraw();
  }

  // 外部请求定位某科技节点（工具栏点锁定建筑时）
  useEffect(() => {
    const onFocus = (e) => focusNode(e.detail);
    window.addEventListener('fg:focus-tech', onFocus);
    return () => window.removeEventListener('fg:focus-tech', onFocus);
  }, []);

  // 打开时指定了 focusId（React props 方式）
  useEffect(() => {
    if (focusId) {
      // 等布局完成再定位
      const raf = requestAnimationFrame(() => focusNode(focusId));
      return () => cancelAnimationFrame(raf);
    }
  }, [focusId]);

  // 绘制
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const W = canvas.width / dpr, H = canvas.height / dpr;
    ctx.fillStyle = '#0f121a';
    ctx.fillRect(0, 0, W, H);

    const L = layout();
    const mgr = game.research;
    const view = viewRef.current;

    ctx.save();
    ctx.translate(view.panX, view.panY);
    ctx.scale(view.zoom, view.zoom);

    // 连线
    for (const t of FG.Research.list()) {
      const p = L.pos[t.id];
      for (const pre of t.prereq) {
        const pp = L.pos[pre];
        if (!pp) continue;
        ctx.strokeStyle = mgr.isDone(pre) ? 'rgba(88,194,111,0.7)' : '#3a4150';
        ctx.lineWidth = 2.5;
        ctx.beginPath();
        ctx.moveTo(pp.x + NODE_R, pp.y);
        const midX = (pp.x + p.x) / 2;
        ctx.bezierCurveTo(midX, pp.y, midX, p.y, p.x - NODE_R, p.y);
        ctx.stroke();
      }
    }

    // 节点
    for (const t of FG.Research.list()) {
      const p = L.pos[t.id];
      const st = nodeState(t.id);
      const colors = { done: '#58c26f', available: '#4da3ff', current: '#e8a33d', locked: '#3a4150' };
      const isHover = hoverId === t.id;
      ctx.beginPath();
      ctx.arc(p.x, p.y, NODE_R + (isHover ? 3 : 0), 0, Math.PI * 2);
      ctx.fillStyle = colors[st];
      ctx.globalAlpha = st === 'locked' ? 0.55 : 1;
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.strokeStyle = 'rgba(255,255,255,0.25)';
      ctx.lineWidth = 1.5;
      ctx.stroke();
      if (st === 'current') {
        ctx.strokeStyle = '#ffd27a';
        ctx.lineWidth = 3;
        ctx.beginPath(); ctx.arc(p.x, p.y, NODE_R + 6, 0, Math.PI * 2); ctx.stroke();
      }
      const iconType = t.unlocksB[0];
      if (iconType) {
        const icon = FG.Renderer.buildingIcon(iconType, 34);
        ctx.drawImage(icon, p.x - 17, p.y - 17, 34, 34);
      } else {
        ctx.fillStyle = '#0d0f14';
        ctx.font = '20px sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('★', p.x, p.y + 1);
      }
      ctx.fillStyle = st === 'locked' ? '#7a8194' : '#d6dbe8';
      ctx.font = '11px "Microsoft YaHei", sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(t.name, p.x, p.y + NODE_R + 14);
    }
    ctx.restore();

    // 图例
    ctx.fillStyle = '#8b93a8';
    ctx.font = '11px sans-serif';
    ctx.textAlign = 'left';
    let ly = 20;
    for (const [k, v] of [['已完成', '#58c26f'], ['可研究', '#4da3ff'], ['研究中', '#e8a33d'], ['未解锁', '#3a4150']]) {
      ctx.fillStyle = v;
      ctx.fillRect(12, ly - 9, 12, 12);
      ctx.fillStyle = '#8b93a8';
      ctx.fillText(k, 30, ly);
      ly += 18;
    }
  });

  // 交互
  useEffect(() => {
    const canvas = canvasRef.current;

    const onWheel = (e) => {
      e.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left, my = e.clientY - rect.top;
      const view = viewRef.current;
      const factor = e.deltaY > 0 ? 0.9 : 1.1;
      const nz = Math.min(1.6, Math.max(0.3, view.zoom * factor));
      view.panX = mx - (mx - view.panX) * (nz / view.zoom);
      view.panY = my - (my - view.panY) * (nz / view.zoom);
      view.zoom = nz;
      bumpDraw();
    };

    const onDown = (e) => {
      dragRef.current = { x: e.clientX, y: e.clientY };
      movedRef.current = false;
    };
    const onMove = (e) => {
      const d = dragRef.current;
      if (d) {
        const dx = e.clientX - d.x, dy = e.clientY - d.y;
        if (Math.abs(dx) > 3 || Math.abs(dy) > 3) movedRef.current = true;
        viewRef.current.panX += dx;
        viewRef.current.panY += dy;
        dragRef.current = { x: e.clientX, y: e.clientY };
        bumpDraw();
      }
      const n = nodeAt(e.clientX, e.clientY);
      setHoverId(prev => (prev === n ? prev : n));
    };
    const onUp = (e) => {
      if (dragRef.current && !movedRef.current) {
        const n = nodeAt(e.clientX, e.clientY);
        if (n) setSelectedId(n);
      }
      dragRef.current = null;
    };

    canvas.addEventListener('wheel', onWheel, { passive: false });
    canvas.addEventListener('mousedown', onDown);
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      canvas.removeEventListener('wheel', onWheel);
      canvas.removeEventListener('mousedown', onDown);
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, []);

  // 详情浮层定位
  let detailPos = null;
  if (selectedId) {
    const L = layout();
    const p = L.pos[selectedId];
    const view = viewRef.current;
    const rect = wrapRef.current ? wrapRef.current.getBoundingClientRect() : { width: 800, height: 600 };
    detailPos = {
      left: Math.min(rect.width - 250, p.x * view.zoom + view.panX + 30),
      top: Math.max(10, Math.min(rect.height - 200, p.y * view.zoom + view.panY - 40)),
    };
  }

  return (
    <div className="tech-tree" id="tech-tree">
      <div className="tt-head">
        <h2>🔬 科技树</h2>
        <span style={{ color: 'var(--text-dim)', fontSize: 11 }}>滚轮缩放 · 拖拽平移 · 点击节点研究</span>
        <button onClick={onClose}>关闭 (Esc)</button>
      </div>
      <div className="tech-wrap" ref={wrapRef}>
        <canvas className="tech-canvas" ref={canvasRef} />
        {selectedId && (
          <div id="tech-detail" style={detailPos}>
            <TechDetail game={game} techId={selectedId} state={nodeState(selectedId)}
              onChanged={bumpDraw} onClose={() => setSelectedId(null)} />
          </div>
        )}
      </div>
    </div>
  );
}

function TechDetail({ game, techId, state, onChanged, onClose }) {
  const mgr = game.research;
  const t = FG.Research.byId(techId);

  return (
    <div>
      <h4>
        {t.name}
        <b style={{ float: 'right', cursor: 'pointer', color: 'var(--text-dim)' }} onClick={onClose}>×</b>
      </h4>
      {state === 'current' && (
        <>
          <div style={{ color: 'var(--accent)', margin: '4px 0' }}>
            研究中 … {(mgr.progress() * 100).toFixed(0)}%
          </div>
          {Object.entries(mgr.packProgress()).map(([pack, v]) => (
            <div className="td-cost" key={pack}>{FG.Items.byId(pack).name} {v.have}/{v.need}</div>
          ))}
          <button onClick={() => { game.cancelResearch(); onChanged(); }}>取消研究</button>
        </>
      )}
      {state === 'available' && (
        <>
          <div className="td-cost">
            {Object.entries(t.cost).map(([pack, n]) => `${FG.Items.byId(pack).name} × ${n} `).join('')}
          </div>
          <div className="td-desc">{t.desc}</div>
          <div className="td-desc">
            解锁：{[
              ...t.unlocksB.map(b => FG.Buildings.byId(b).name),
              ...t.unlocksR.map(r => FG.Recipes.byId(r).name),
            ].join('、')}
          </div>
          <button style={{ marginTop: 8 }} onClick={() => { game.startResearch(techId); onChanged(); }}>
            开始研究
          </button>
        </>
      )}
      {state === 'done' && (
        <>
          <div style={{ color: 'var(--green)', margin: '4px 0' }}>✅ 已完成</div>
          <div className="td-desc">{t.desc}</div>
        </>
      )}
      {state === 'locked' && (
        <>
          <div style={{ color: 'var(--red)', margin: '4px 0' }}>
            🔒 需先完成：{t.prereq.filter(pr => !mgr.isDone(pr)).map(pr => FG.Research.byId(pr).name).join('、')}
          </div>
          <div className="td-desc">{t.desc}</div>
        </>
      )}
    </div>
  );
}
