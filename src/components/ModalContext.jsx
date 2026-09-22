/**
 * 弹窗管理：用 React 状态替代原 FG.Modals 的命令式 appendChild。
 * 提供 useModal() 钩子打开/关闭各类弹窗。
 */
import { createContext, useCallback, useContext, useMemo, useState } from 'react';

const ModalContext = createContext(null);

export function ModalProvider({ children }) {
  // name: null | 'newGame' | 'saveLoad' | 'menu' | 'help' | 'pipelines'
  const [modal, setModal] = useState(null);

  const open = useCallback((name) => setModal(name), []);
  const close = useCallback(() => setModal(null), []);

  const value = useMemo(() => ({
    modal,
    open,
    close,
    // 便于命令式调用（与旧 FG.Modals.* 同名）
    newGame: () => open('newGame'),
    saveLoad: () => open('saveLoad'),
    menu: () => open('menu'),
    help: () => open('help'),
    pipelines: () => open('pipelines'),
    closeAll: close,
  }), [modal, open, close]);

  return <ModalContext.Provider value={value}>{children}</ModalContext.Provider>;
}

export function useModal() {
  const ctx = useContext(ModalContext);
  if (!ctx) throw new Error('useModal must be used within ModalProvider');
  return ctx;
}
