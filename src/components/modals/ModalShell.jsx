/** 弹窗通用标题与关闭按钮 */
import { useModal } from '../ModalContext.jsx';

export function ModalShell({ title, children }) {
  const modal = useModal();
  return (
    <>
      <h2>
        {title}
        <span className="m-close" onClick={modal.close} style={{ marginLeft: 12 }}>✕</span>
      </h2>
      {children}
    </>
  );
}
