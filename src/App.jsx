/**
 * App：游戏单例生命周期 + 整体布局 + rAF 主循环。
 * 游戏状态全部在命令式的 FG.game 中，React 只负责 UI 呈现与转发操作。
 */
import { useEffect, useMemo, useState } from 'react';
import { FG } from './engine';
import { ModalProvider } from './components/ModalContext.jsx';
import { useEventVersion } from './hooks.js';
import Topbar from './components/Topbar.jsx';
import ItemStrip from './components/ItemStrip.jsx';
import Toolbar from './components/Toolbar.jsx';
import MapCanvas from './components/MapCanvas.jsx';
import SidePanel from './components/SidePanel.jsx';
import ModalLayer from './components/ModalLayer.jsx';
import ModalBridge from './components/ModalBridge.jsx';
import TechTree from './components/TechTree.jsx';
import Toasts from './components/Toasts.jsx';

// 模块级单例：StrictMode 双渲染与热更新都复用同一个 Game
let gameInstance = null;
function getGame() {
  if (!gameInstance) {
    gameInstance = new FG.Game();
    // 暴露到全局（与重构前 main.js 的 FG.game 一致，便于控制台调试与存档兼容）
    FG.game = gameInstance;
  }
  return gameInstance;
}

export default function App() {
  // 全应用共享同一个 Game 实例（构造无副作用，不依赖 DOM）
  const game = useMemo(getGame, []);
  const [techOpen, setTechOpen] = useState(false);
  const [techFocus, setTechFocus] = useState(null);

  // game:start 时重渲染整个 UI（从菜单进入游戏）
  useEventVersion('game:start');

  const openTech = (focusId) => {
    setTechFocus(focusId || null);
    setTechOpen(true);
  };

  // 全局自定义事件：菜单/快捷键打开科技树
  useEffect(() => {
    const onOpenTech = () => openTech();
    const onFocusTech = (e) => openTech(e.detail);
    window.addEventListener('fg:open-tech', onOpenTech);
    window.addEventListener('fg:focus-tech', onFocusTech);
    return () => {
      window.removeEventListener('fg:open-tech', onOpenTech);
      window.removeEventListener('fg:focus-tech', onFocusTech);
    };
  }, []);

  // Esc 关闭科技树（优先级：弹窗 > 科技树 > 游戏内状态，后者由 MapCanvas 处理）
  useEffect(() => {
    if (!techOpen) return;
    const onKey = (e) => {
      if (e.key === 'Escape' && !document.querySelector('.modal-mask')) setTechOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [techOpen]);

  // rAF 主循环：固定步长仿真 + Canvas 渲染（renderer 内部自己读 game）
  useEffect(() => {
    let last = performance.now();
    let raf = 0;
    const loop = (now) => {
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      game.update(dt);
      FG.Renderer.render();
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [game]);

  const playing = game.state === 'playing';

  return (
    <ModalProvider>
      <ModalBridge />
      <Topbar game={game} onOpenTech={() => openTech()} />
      {playing && <ItemStrip game={game} />}
      <div className="app-layout">
        {playing && <Toolbar game={game} onOpenTech={openTech} />}
        <MapCanvas game={game} onOpenTech={() => openTech()} />
        {playing && <SidePanel game={game} />}
      </div>
      <ModalLayer game={game} />
      {techOpen && <TechTree game={game} focusId={techFocus} onClose={() => setTechOpen(false)} />}
      <Toasts game={game} />
    </ModalProvider>
  );
}
