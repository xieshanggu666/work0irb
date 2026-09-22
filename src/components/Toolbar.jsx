/**
 * 左侧建筑工具栏：分类 + 建筑按钮（未解锁置灰，点击跳转科技树）
 */
import { useState } from 'react';
import { FG } from '../engine';
import { useEventVersion } from '../hooks';
import { BuildingIcon } from './Icon.jsx';

const HINTS = {
  extraction: '左键放置；右键/Esc 取消。矿机需放在矿脉上，水泵放水域旁。',
  production: '放置后用右侧面板选择配方；用机械臂连接传送带与建筑。',
  logistics: '传送带按住拖拽可连成直线；机械臂 R 旋转；管道连接产液与用液建筑。轨道拖拽铺设，车站旁建机务段发车；交付站可承接供货合同。',
  science: '实验室需要科学包，由组装机生产；研究在 🔬 科技树中选择。',
};

export default function Toolbar({ game, onOpenTech }) {
  const [cat, setCat] = useState('extraction');
  // 科技完成 / 幽灵变化 / 开局都要重绘锁定态与选中态
  useEventVersion(['research:complete', 'ghost:change', 'game:start']);

  return (
    <nav className="toolbar">
      <div className="tb-cats">
        {FG.Buildings.CATS.map((c) => (
          <button key={c.id} className={c.id === cat ? 'active' : ''} onClick={() => setCat(c.id)}>
            {c.name}
          </button>
        ))}
      </div>
      <div className="tb-buildings">
        {FG.Buildings.byCat(cat).map((def) => {
          const unlocked = game.research.isBuildingUnlocked(def.id);
          const selected = game.ghost && game.ghost.type === def.id;
          const tech = FG.Research.byId(def.unlockedBy);
          return (
            <button
              key={def.id}
              className={'bld-btn' + (unlocked ? '' : ' locked') + (selected ? ' selected' : '')}
              title={unlocked ? def.desc : '需要研究：' + (tech ? tech.name : def.unlockedBy)}
              onClick={() => {
                if (!unlocked) {
                  if (tech) onOpenTech(def.unlockedBy);
                  return;
                }
                if (game.ghost && game.ghost.type === def.id) game.cancelGhost();
                else game.setGhost(def.id);
              }}
            >
              <BuildingIcon type={def.id} size={40} />
              <span className="bld-name">{def.name}</span>
            </button>
          );
        })}
      </div>
      <div className="tb-hint">{HINTS[cat]}</div>
    </nav>
  );
}
