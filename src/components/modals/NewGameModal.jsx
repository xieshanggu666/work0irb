/**
 * 新建游戏：地图场景 / 尺寸 / 随机种子 / 工厂名 / 槽位
 */
import { useMemo, useState } from 'react';
import { FG } from '../../engine';
import { useModal } from '../ModalContext.jsx';
import { ModalShell } from './ModalShell.jsx';

export default function NewGameModal({ game }) {
  const modal = useModal();
  const [preset, setPreset] = useState('greenfield');
  const [size, setSize] = useState('medium');
  const [seedInput, setSeedInput] = useState('');
  const [name, setName] = useState('我的工厂');
  const [slot, setSlot] = useState('1');

  // 槽位信息只在挂载时读一次即可
  const slotsInfo = useMemo(() => FG.Save.listSlots(), []);

  function start() {
    const parsed = parseInt(seedInput, 10);
    const seed = (parsed && parsed > 0) ? parsed : Math.floor(Math.random() * 99999);
    const finalName = name.trim() || '我的工厂';
    modal.close();
    game.newGame(preset, size, seed, slot, finalName);
    game.saveTo(slot, finalName);
  }

  return (
    <ModalShell title="🏭 新建工厂">
      <h3>选择地图场景</h3>
      <div id="ng-maps" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {FG.Maps.PRESETS.map(p => (
          <div
            key={p.id}
            className="map-card"
            style={{ borderColor: preset === p.id ? 'var(--accent)' : undefined }}
            onClick={() => setPreset(p.id)}
          >
            <div className="mc-name">{p.name}</div>
            <div className="mc-desc">{p.desc}</div>
          </div>
        ))}
      </div>

      <h3>地图尺寸</h3>
      <div style={{ display: 'flex', gap: 6 }}>
        {Object.entries(FG.Config.MAP_SIZES).map(([k, v]) => (
          <button key={k} className={size === k ? 'active' : ''} onClick={() => setSize(k)}>
            {v.label} ({v.w}×{v.h})
          </button>
        ))}
      </div>

      <h3>随机种子</h3>
      <div className="seed-row">
        <input type="text" placeholder="留空随机" value={seedInput}
          onChange={(e) => setSeedInput(e.target.value)} />
        <button onClick={() => setSeedInput(String(Math.floor(Math.random() * 99999)))}>🎲</button>
      </div>

      <h3>工厂名称</h3>
      <div className="seed-row">
        <input type="text" value={name} onChange={(e) => setName(e.target.value)} />
      </div>

      <h3>保存槽位</h3>
      <div style={{ display: 'flex', gap: 6 }}>
        {['1', '2', '3'].map(s => {
          const info = slotsInfo.find(x => x.id === s);
          return (
            <button key={s} className={slot === s ? 'active' : ''} onClick={() => setSlot(s)}>
              {s}{info && info.exists ? '（已有存档）' : ''}
            </button>
          );
        })}
      </div>

      <div className="m-btns">
        <button className="active" onClick={start}>开始游戏</button>
      </div>
    </ModalShell>
  );
}
