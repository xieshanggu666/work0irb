/**
 * 菜单弹窗
 */
import { FG } from '../../engine';
import { useModal } from '../ModalContext.jsx';
import { ModalShell } from './ModalShell.jsx';

export default function MenuModal({ game }) {
  const modal = useModal();

  function saveAndClose() {
    if (game.saveInfo.slot) game.saveTo(game.saveInfo.slot, null);
    else modal.open('saveLoad');
  }

  return (
    <ModalShell title="☰ 菜单">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, minWidth: 220 }}>
        <button onClick={modal.close}>继续游戏</button>
        <button onClick={saveAndClose}>保存游戏</button>
        <button onClick={() => modal.open('saveLoad')}>存档管理</button>
        <button onClick={() => { modal.close(); window.dispatchEvent(new CustomEvent('fg:open-tech')); }}>
          科技树
        </button>
        <button onClick={() => modal.open('pipelines')}>⚡ 一键流水线</button>
        <button onClick={() => modal.open('newGame')}>新建游戏</button>
        <button onClick={() => modal.open('help')}>帮助</button>
      </div>
    </ModalShell>
  );
}
