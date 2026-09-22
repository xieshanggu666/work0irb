/**
 * 消息 Toast：游戏内 logMsg 触发 'message' 事件时短暂浮现（error 红色 / unlock 金色）
 */
import { useEffect, useState } from 'react';
import { FG } from '../engine';

export default function Toasts({ game }) {
  const [toast, setToast] = useState(null);

  useEffect(() => FG.Events.on('message', (msg) => {
    setToast(msg);
    const timer = setTimeout(() => setToast(null), 2600);
    return () => clearTimeout(timer);
  }), []);

  if (!toast) return null;
  return (
    <div
      key={toast.t + toast.text}
      className={'toast toast-' + (toast.cls || 'info')}
      style={{
        position: 'fixed',
        bottom: 18,
        left: '50%',
        transform: 'translateX(-50%)',
        background: 'rgba(20,24,34,0.95)',
        border: '1px solid var(--border-light)',
        color: toast.cls === 'error' ? 'var(--red)'
          : toast.cls === 'unlock' ? 'var(--accent)' : 'var(--text)',
        borderRadius: 6,
        padding: '7px 16px',
        fontSize: 12,
        zIndex: 120,
        pointerEvents: 'none',
        boxShadow: '0 4px 16px rgba(0,0,0,.5)',
        animation: 'toast-in .2s ease-out',
      }}
    >
      {toast.text}
    </div>
  );
}
