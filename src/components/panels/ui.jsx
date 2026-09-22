/** 右侧面板复用小组件 */
import { FG } from '../../engine';
import { ItemIcon } from '../Icon.jsx';

export function Section({ title, children }) {
  return (
    <div className="panel-sec">
      {title && <h4>{title}</h4>}
      {children}
    </div>
  );
}

export function InfoGrid({ rows }) {
  return (
    <div className="info-grid">
      {rows.map(([k, v, cls], i) => (
        <KV key={i} k={k} v={v} cls={cls} />
      ))}
    </div>
  );
}

function KV({ k, v, cls }) {
  return (<><div className="k">{k}</div><div className={'v' + (cls ? ' ' + cls : '')}>{v}</div></>);
}

export function ProgressBar({ pct, color }) {
  return (
    <div className="progress-bar">
      <div className="fill" style={{
        width: Math.max(0, Math.min(100, pct * 100)).toFixed(1) + '%',
        background: color || undefined,
      }} />
    </div>
  );
}

/** 物料/流体/箱子槽位条 */
export function SlotRow({ name, count, cap, warn }) {
  return (
    <div className={'slot-row' + (warn ? ' slot-warn' : '')}
      title={warn ? '当前配方不再需要，机械臂会将其运走' : undefined}>
      <span className="sl-name">{name}</span>
      <div className="sl-bar">
        <div className="fill" style={{ width: Math.min(100, count / cap * 100).toFixed(0) + '%' }} />
      </div>
      <span className="sl-count">{FG.Utils.fmtNum(count)}/{FG.Utils.fmtNum(cap)}</span>
    </div>
  );
}

export function ItemName({ id }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
      <ItemIcon id={id} size={14} />
      {FG.Items.byId(id).name}
    </span>
  );
}

export const STATUS_NAMES = {
  working: '生产中', starving: '缺料', blocked: '堵塞',
  idle: '闲置', empty: '枯竭', broken: '故障停机',
};

export const PRIO_OPTS = [
  ['high', '高优先', '缺料时优先供料'],
  ['normal', '普通', '同级轮转公平供料'],
  ['low', '低优先', '物料紧张时最后供料'],
];

export const PRIO_NAMES = { high: '高', normal: '中', low: '低' };
