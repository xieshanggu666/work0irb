/**
 * 物品资源条：全图盘点 Top10（每秒刷新）
 */
import { FG } from '../engine';
import { useTickThrottle } from '../hooks';
import { ItemIcon } from './Icon.jsx';

export default function ItemStrip({ game }) {
  useTickThrottle(1000);

  if (game.state !== 'playing') return null;
  const counts = game.inventory();
  const entries = Object.entries(counts)
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10);

  return (
    <div className="item-strip">
      {entries.map(([id, n]) => (
        <div className="item-chip" key={id} title={FG.Items.byId(id).name}>
          <ItemIcon id={id} size={16} />
          <span className="qty">{FG.Utils.fmtNum(n)}</span>
        </div>
      ))}
    </div>
  );
}
