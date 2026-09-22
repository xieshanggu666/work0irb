/**
 * 弹窗桥：
 *  - 首次启动根据是否有存档弹出帮助 / 新建游戏
 *  - 游戏内快捷键 P、菜单按钮派发的 fg:open-pipelines 事件 → 打开流水线弹窗
 */
import { useEffect } from 'react';
import { FG } from '../engine';
import { useModal } from './ModalContext.jsx';

export default function ModalBridge() {
  const modal = useModal();

  useEffect(() => {
    const onInit = (e) => modal.open(e.detail);
    const onPipelines = () => {
      if (FG.game && FG.game.state === 'playing') modal.pipelines();
    };
    window.addEventListener('fg:init-modal', onInit);
    window.addEventListener('fg:open-pipelines', onPipelines);
    // 挂载后立即检查初始引导（事件先于本组件挂载时也能兜底）
    const hasSave = FG.Save.listSlots().some(s => s.exists);
    // 用 timeout=0 确保在首帧渲染后弹出
    const t = setTimeout(() => modal.open(hasSave ? 'help' : 'newGame'), 0);
    return () => {
      window.removeEventListener('fg:init-modal', onInit);
      window.removeEventListener('fg:open-pipelines', onPipelines);
      clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return null;
}
