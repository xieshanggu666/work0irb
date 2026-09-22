/**
 * 弹窗层：根据 ModalContext 的当前弹窗名渲染对应组件。
 * Esc 关闭；点击遮罩空白处关闭。
 */
import { useEffect } from 'react';
import { useModal } from './ModalContext.jsx';
import NewGameModal from './modals/NewGameModal.jsx';
import SaveLoadModal from './modals/SaveLoadModal.jsx';
import MenuModal from './modals/MenuModal.jsx';
import HelpModal from './modals/HelpModal.jsx';
import PipelinesModal from './modals/PipelinesModal.jsx';

export default function ModalLayer({ game }) {
  const modal = useModal();

  useEffect(() => {
    if (!modal.modal) return;
    const onKey = (e) => { if (e.key === 'Escape') modal.close(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [modal]);

  if (!modal.modal) return null;

  let content = null;
  if (modal.modal === 'newGame') content = <NewGameModal game={game} />;
  else if (modal.modal === 'saveLoad') content = <SaveLoadModal game={game} />;
  else if (modal.modal === 'menu') content = <MenuModal game={game} />;
  else if (modal.modal === 'help') content = <HelpModal />;
  else if (modal.modal === 'pipelines') content = <PipelinesModal game={game} />;

  return (
    <div className="modal-mask" onMouseDown={(e) => { if (e.target === e.currentTarget) modal.close(); }}>
      <div className="modal">{content}</div>
    </div>
  );
}
