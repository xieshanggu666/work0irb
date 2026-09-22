/**
 * 地图画布：
 *  - 初始化 FG.Renderer（纯 Canvas 绘制器，原样复用）
 *  - 全部鼠标 / 滚轮 / 键盘输入（移植自原 js/main.js）
 *  - 悬浮建筑提示（map-tooltip）与蓝图/升级模式提示条（bp-hint）改为 React 状态
 */
import { useEffect, useRef, useState } from 'react';
import { FG } from '../engine';
import { useEventVersion } from '../hooks';
import { buildTooltip } from './mapTooltip.js';
import { BpHint } from './BpHint.jsx';

export default function MapCanvas({ game, onOpenTech }) {
  const canvasRef = useRef(null);
  const wrapRef = useRef(null);
  const tooltipRef = useRef(null);
  const [tip, setTip] = useState(null); // {html, x, y}

  // 蓝图/升级模式变化时刷新提示条；selection 变化不影响提示条
  useEventVersion(['blueprint:mode', 'blueprint:change', 'upgrade:mode', 'upgrade:change']);

  useEffect(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    FG.Renderer.init(canvas, game);

    let panning = false;
    let dragPlace = null;
    let bpDrag = null;
    let upDrag = null;

    // ---------------- 鼠标移动 ----------------
    const onMove = (e) => {
      const rect = canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left, my = e.clientY - rect.top;
      const tile = FG.Renderer.screenToTile(mx, my);
      FG.Renderer.setMouseTile(tile.x, tile.y);
      game._lastMouseTile = tile;

      if (panning) {
        const t = FG.Config.TILE * game.camera.zoom;
        game.camera.x -= e.movementX / t;
        game.camera.y -= e.movementY / t;
      }
      if (bpDrag && game.bpMode === 'select') {
        game.bpSelect = { x0: bpDrag.x, y0: bpDrag.y, x1: tile.x, y1: tile.y };
      }
      if (upDrag && game.upMode === 'select') {
        game.upSelect = { x0: upDrag.x, y0: upDrag.y, x1: tile.x, y1: tile.y };
      }
      // 一键流水线预览：仅当鼠标原点可放置时才解除智能选位锚点
      if (game.bpMode === 'place' && game.pipelineId && game.bpAnchor) {
        if (FG.Blueprint.validate(game, game.blueprint, tile.x, tile.y).ok) {
          game.bpAnchor = null;
          FG.Events.emit('blueprint:change');
        }
      }
      if (dragPlace) {
        const dx = tile.x - dragPlace.lastX, dy = tile.y - dragPlace.lastY;
        if (dx || dy) {
          const ghostDef = FG.Buildings.byId(game.ghost.type);
          if (ghostDef && ghostDef.beltTier !== undefined) {
            game.ghost.dir = dx !== 0 ? (dx > 0 ? 1 : 3) : (dy > 0 ? 2 : 0);
          }
          if (game.placeGhost(tile.x, tile.y)) {
            dragPlace.lastX = tile.x;
            dragPlace.lastY = tile.y;
          }
        }
      }
      updateTooltip(e, tile);
    };

    function updateTooltip(e, tile) {
      const el = tooltipRef.current;
      if (!el) return;
      const m = game.map;
      if (!m || !m.inBounds(tile.x, tile.y) || game.bpMode) {
        setTip(null);
        return;
      }
      const html = buildTooltip(game, tile);
      if (!html) { setTip(null); return; }
      const wr = wrap.getBoundingClientRect();
      setTip({
        html,
        x: Math.min(e.clientX - wr.left + 14, wrap.clientWidth - 260),
        y: Math.min(e.clientY - wr.top + 14, wrap.clientHeight - 120),
      });
    }

    // ---------------- 鼠标按下 ----------------
    const onDown = (e) => {
      const rect = canvas.getBoundingClientRect();
      const tile = FG.Renderer.screenToTile(e.clientX - rect.left, e.clientY - rect.top);
      if (e.button === 2 || e.button === 1) { panning = true; return; }
      if (e.button !== 0) return;
      game._lastMouseTile = tile;

      if (game.upMode === 'select') {
        upDrag = { x: tile.x, y: tile.y };
        game.upSelect = { x0: tile.x, y0: tile.y, x1: tile.x, y1: tile.y };
        return;
      }
      if (game.upMode === 'confirm') { game.confirmUpgrade(); return; }

      if (game.bpMode === 'select') {
        bpDrag = { x: tile.x, y: tile.y };
        game.bpSelect = { x0: tile.x, y0: tile.y, x1: tile.x, y1: tile.y };
        return;
      }
      if (game.bpMode === 'place') {
        const o = game.blueprintOrigin(tile.x, tile.y);
        game.submitBlueprintPlanAt(o.x, o.y);
        return;
      }

      if (game.ghost) {
        const gDef = FG.Buildings.byId(game.ghost.type);
        if (gDef.beltTier !== undefined || gDef.railTier !== undefined) {
          dragPlace = { lastX: tile.x, lastY: tile.y };
        }
        game.placeGhost(tile.x, tile.y);
      } else {
        const tr = game.railway && game.railway.trainAt(tile.x, tile.y);
        if (tr) game.selectBuilding(tr);
        else {
          const b = game.map.buildingAt(tile.x, tile.y);
          if (b) game.selectBuilding(b);
          else { game.selection = null; FG.Events.emit('selection:change'); }
        }
      }
    };

    // ---------------- 鼠标抬起（框选完成） ----------------
    const onUp = (e) => {
      if (e.button === 2 || e.button === 1) panning = false;
      if (e.button !== 0) return;
      dragPlace = null;
      if (upDrag) {
        const r = game.upSelect;
        upDrag = null; game.upSelect = null;
        if (r && game.upMode === 'select') game.previewUpgrade(r.x0, r.y0, r.x1, r.y1);
      }
      if (bpDrag) {
        const r = game.bpSelect;
        bpDrag = null; game.bpSelect = null;
        if (r && game.bpMode === 'select') game.captureBlueprint(r.x0, r.y0, r.x1, r.y1);
      }
    };

    const onContext = (e) => {
      e.preventDefault();
      if (game.upMode) { game.cancelUpgradePreview(); return; }
      if (game.bpMode) { game.exitBlueprintMode(); return; }
      if (game.ghost) game.cancelGhost();
    };

    // ---------------- 滚轮缩放（以鼠标为中心） ----------------
    const onWheel = (e) => {
      e.preventDefault();
      const cam = game.camera;
      const rect = canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left, my = e.clientY - rect.top;
      const factor = e.deltaY > 0 ? 0.88 : 1.14;
      const nz = Math.min(2.5, Math.max(0.4, cam.zoom * factor));
      const t = FG.Config.TILE;
      cam.x = (mx / (t * nz)) - (mx / (t * cam.zoom) - cam.x);
      cam.y = (my / (t * nz)) - (my / (t * cam.zoom) - cam.y);
      cam.zoom = nz;
    };

    // ---------------- 键盘 ----------------
    const onKey = (e) => {
      const techOpenEl = document.getElementById('tech-tree');
      const techIsOpen = !!techOpenEl;
      const modalOpen = !!document.querySelector('.modal-mask');

      // Esc 的弹窗/科技树关闭由 ModalLayer / App 统一处理
      if (e.key === 'Escape') {
        if (modalOpen || techIsOpen) return;
        if (game.upMode) { game.cancelUpgradePreview(); return; }
        if (game.bpMode) { game.exitBlueprintMode(); return; }
        if (game.ghost) { game.cancelGhost(); return; }
        game.selection = null;
        FG.Events.emit('selection:change');
        return;
      }
      if (modalOpen || techIsOpen) return;

      switch (e.key) {
        case 'r': case 'R':
          if (game.bpMode === 'place') game.rotateBlueprint();
          else if (game.ghost) game.rotateGhost();
          else if (game.selection && !game.selection.isTrain
            && (game.selection.def.beltTier !== undefined || game.selection.def.inserterTier !== undefined)) {
            game.selection.dir = (game.selection.dir + 1) % 4;
          }
          break;
        case 'u': case 'U': game.toggleUpgradeMode(); break;
        case 'f': case 'F':
          if (game.bpMode === 'place' && game.pipelineId) game.refindPipelineAnchor();
          break;
        case 'p': case 'P':
          if (game.state === 'playing') {
            // 通过自定义事件请求打开流水线弹窗（避免向画布组件传 modal 上下文）
            window.dispatchEvent(new CustomEvent('fg:open-pipelines'));
          }
          break;
        case 'b': case 'B': game.toggleBlueprintMode(); break;
        case 'Delete': case 'Backspace':
          if (game.selection && game.selection.isTrain) game.removeTrainSelection();
          else if (game.selection) game.removeBuilding(game.selection);
          break;
        case ' ': e.preventDefault(); game.togglePause(); break;
        case 't': case 'T': onOpenTech(); break;
        case 's': case 'S':
          game.showStatus = !game.showStatus;
          FG.Events.emit('ui:show-status');
          break;
        case '1': game.setSpeed(0.5); break;
        case '2': game.setSpeed(1); break;
        case '3': game.setSpeed(2); break;
        case '4': game.setSpeed(4); break;
      }
    };

    const onResize = () => FG.Renderer.resize();

    canvas.addEventListener('mousemove', onMove);
    canvas.addEventListener('mousedown', onDown);
    window.addEventListener('mouseup', onUp);
    canvas.addEventListener('contextmenu', onContext);
    canvas.addEventListener('wheel', onWheel, { passive: false });
    window.addEventListener('keydown', onKey);
    window.addEventListener('resize', onResize);

    return () => {
      canvas.removeEventListener('mousemove', onMove);
      canvas.removeEventListener('mousedown', onDown);
      window.removeEventListener('mouseup', onUp);
      canvas.removeEventListener('contextmenu', onContext);
      canvas.removeEventListener('wheel', onWheel);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', onResize);
    };
  }, [game, onOpenTech]);

  const showHint = game.state === 'playing' && (game.bpMode || game.upMode);

  return (
    <main className="map-wrap" ref={wrapRef}>
      <canvas ref={canvasRef} className="map-canvas" />
      {showHint && <BpHint game={game} />}
      {tip && (
        <div
          ref={tooltipRef}
          id="map-tooltip"
          style={{ left: tip.x, top: tip.y }}
          dangerouslySetInnerHTML={{ __html: tip.html }}
        />
      )}
    </main>
  );
}
