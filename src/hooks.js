/**
 * React ↔ 引擎桥接 hooks
 *
 * 引擎（FG.Game 等）是命令式的可变对象，通过 FG.Events 事件总线广播状态变化。
 * React 组件不持有游戏状态，只在收到事件后重渲染并直接读取 game 实例。
 */
import { useEffect, useReducer, useRef } from 'react';
import { FG } from './engine';

/**
 * 订阅一个或多个引擎事件，事件触发时强制组件重渲染。
 * @param {string|string[]} names
 */
export function useEventVersion(names) {
  const [, bump] = useReducer((v) => v + 1, 0);
  useEffect(() => {
    const list = Array.isArray(names) ? names : [names];
    const unbinds = list.map((n) => FG.Events.on(n, bump));
    return () => unbinds.forEach((off) => off());
  }, [Array.isArray(names) ? names.join(',') : names]);
}

/**
 * 按时间间隔跟随 sim:tick 节流刷新（用于时间、研究进度等高频面板）。
 * @param {number} intervalMs
 */
export function useTickThrottle(intervalMs = 200) {
  const [, bump] = useReducer((v) => v + 1, 0);
  const lastRef = useRef(0);
  useEffect(() => FG.Events.on('sim:tick', () => {
    const now = performance.now();
    if (now - lastRef.current >= intervalMs) {
      lastRef.current = now;
      bump();
    }
  }), [intervalMs]);
}

/** 订阅「消息」事件，返回最新一条（toast 用） */
export function useLatestMessage() {
  const [, bump] = useReducer((v) => v + 1, 0);
  useEffect(() => FG.Events.on('message', bump), []);
  return FG.game && FG.game.log.length ? FG.game.log[FG.game.log.length - 1] : null;
}
