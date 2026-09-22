/**
 * 右侧面板：信息 / 统计 / 施工 / 维修 / 合同 / 日志
 */
import { useEffect, useState } from 'react';
import { FG } from '../engine';
import { useEventVersion, useTickThrottle } from '../hooks';
import InfoTab from './panels/InfoTab.jsx';
import StatsTab from './panels/StatsTab.jsx';
import BuildTab from './panels/BuildTab.jsx';
import RepairTab from './panels/RepairTab.jsx';
import ContractTab from './panels/ContractTab.jsx';
import LogTab from './panels/LogTab.jsx';

const TABS = [
  { id: 'info', name: '信息' },
  { id: 'stats', name: '统计' },
  { id: 'build', name: '施工' },
  { id: 'repair', name: '维修' },
  { id: 'contract', name: '合同' },
  { id: 'log', name: '日志' },
];

export default function SidePanel({ game }) {
  const [tab, setTab] = useState('info');

  // 信息页需要高频刷新（进度条/槽位），150ms 节流跟随 sim:tick
  useTickThrottle(150);
  // 各页数据变化事件
  useEventVersion([
    'selection:change', 'recipe:change',
    'construction:change', 'blueprint:change',
    'contracts:change', 'contracts:complete',
    'maintenance:change', 'maintenance:breakdown', 'maintenance:repaired',
    'message',
  ]);

  // 合同完成/故障发生时自动跳转到对应页签（与原版即时反馈一致）
  useEffect(() => FG.Events.on('maintenance:breakdown', () => setTab('repair')), []);

  if (game.state !== 'playing') return null;

  return (
    <aside className="sidepanel">
      <div className="sp-tabs">
        {TABS.map(t => (
          <button key={t.id} className={tab === t.id ? 'active' : ''} onClick={() => setTab(t.id)}>
            {t.name}
          </button>
        ))}
      </div>
      <div className="sp-body">
        {tab === 'info' && <InfoTab game={game} goTab={setTab} />}
        {tab === 'stats' && <StatsTab game={game} />}
        {tab === 'build' && <BuildTab game={game} />}
        {tab === 'repair' && <RepairTab game={game} goTab={setTab} />}
        {tab === 'contract' && <ContractTab game={game} goTab={setTab} />}
        {tab === 'log' && <LogTab game={game} />}
      </div>
    </aside>
  );
}
