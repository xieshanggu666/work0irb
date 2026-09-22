/**
 * 信息页：无选中=工厂概况；选中建筑=建筑详情；选中列车=列车计划
 */
import { FG } from '../../engine';
import { Section, InfoGrid, ProgressBar, SlotRow, STATUS_NAMES, PRIO_OPTS } from './ui.jsx';
import BuildingInfo from './BuildingInfo.jsx';
import TrainInfo from './TrainInfo.jsx';

export default function InfoTab({ game, goTab }) {
  const sel = game.selection;
  if (!sel) return <Overview game={game} goTab={goTab} />;
  if (sel.isTrain) return <TrainInfo game={game} tr={sel} />;
  return <BuildingInfo game={game} b={sel} />;
}

function Overview({ game, goTab }) {
  const ry = game.railway;
  const mo = game.maintenance;
  const rows = [
    ['建筑数', game.totalBuildings()],
    ['列车', ry ? ry.trains.length : 0],
    ['火车站', ry ? ry.stationList().length : 0],
    ['供货合同', game.contracts ? game.contracts.active.length : 0],
    ['待修设备', mo ? mo.orders.length : 0, mo && mo.orders.length ? 'status-broken' : ''],
    ['已研究', `${game.research.completed.size} / ${FG.Research.list().length}`],
    ['游戏时间', FG.Utils.fmtTime(game.playTime)],
  ];
  return (
    <Section title="工厂概况">
      <InfoGrid rows={rows} />
      <div style={{ color: 'var(--text-dim)', fontSize: 11, marginTop: 8, lineHeight: 1.6 }}>
        点击地图上的建筑查看详情。<br />
        拖动右键平移视野，滚轮缩放。<br />
        矿机→熔炉→组装机→科学包，最后发射卫星！<br />
        研究「铁路货运」后铺轨道、建车站，用列车跨区运料。
      </div>
      <div className="action-row">
        <button onClick={() => goTab('build')}>🏗 施工</button>
        <button onClick={() => goTab('repair')}>🔧 维修</button>
        <button onClick={() => goTab('contract')}>🤝 合同</button>
      </div>
    </Section>
  );
}

export { STATUS_NAMES, PRIO_OPTS, Section, ProgressBar, SlotRow };
