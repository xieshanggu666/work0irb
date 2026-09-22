/**
 * Canvas 图标 → React 元素
 * 引擎的 Renderer.itemIcon / buildingIcon 会生成离屏 canvas，
 * 这里在 useMemo 中生成一次，通过 dangerouslySetInnerHTML 挂载 canvas 元素。
 */
import { useMemo } from 'react';
import { FG } from '../engine';

export function ItemIcon({ id, size = 16 }) {
  const html = useMemo(() => {
    const cv = FG.Renderer.itemIcon(id, size);
    return cv.outerHTML;
  }, [id, size]);
  return (
    <span
      style={{ display: 'inline-flex', width: size, height: size, flex: '0 0 auto' }}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

export function BuildingIcon({ type, size = 40, dir }) {
  const html = useMemo(() => {
    const cv = FG.Renderer.buildingIcon(type, size, dir);
    return cv.outerHTML;
  }, [type, size, dir]);
  return (
    <span
      style={{ display: 'inline-flex', width: size, height: size, flex: '0 0 auto' }}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
