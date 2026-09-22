/**
 * 分阶段施工编辑器：阶段状态、闸门（建成/试产达标）、切分/合并阶段
 */
import { FG } from '../../engine';

export default function StagesEditor({ game, p }) {
  const cons = game.construction;
  const nStages = p.stages.length;

  const splitOptions = [];
  const firstWait = p.entries.findIndex(e => e.state === 'wait');
  if (firstWait >= 0) {
    for (let i = Math.max(1, firstWait); i < p.entries.length; i++) {
      if (p.stages.some(s => s.cut === i)) continue;
      splitOptions.push(i);
    }
  }

  return (
    <div className="stage-box">
      <div className="stage-title">🧱 分阶段施工（{nStages} 阶段）</div>
      {p.stages.map((stage, k) => (
        <StageRow key={k} game={game} p={p} k={k} />
      ))}
      <div className="stage-add">
        <select value="" onChange={(e) => {
          const cut = parseInt(e.target.value, 10);
          if (cut > 0) game.splitPlanStage(p.id, cut);
        }}>
          <option value="">＋ 在条目前切分新阶段…</option>
          {splitOptions.map(i => {
            const e = p.entries[i];
            const nm = e.from
              ? FG.Buildings.byId(e.from).name + '→' + FG.Buildings.byId(e.type).name
              : FG.Buildings.byId(e.type).name;
            return <option key={i} value={i}>#{i + 1} {nm}（{e.x},{e.y}）前</option>;
          })}
        </select>
      </div>
    </div>
  );
}

function StageRow({ game, p, k }) {
  const cons = game.construction;
  const nStages = p.stages.length;
  const { from, to } = cons.stageRange(p, k);
  const stageEntries = p.entries.slice(from, to);
  const sDone = stageEntries.filter(e => e.state === 'done').length;
  const sSkip = stageEntries.filter(e => e.state === 'skip').length;
  const isActive = (p.activeStage || 0) === k;
  const gate = k < nStages - 1 ? p.stages[k].gate : null;
  const isLast = k === nStages - 1;

  let stateCls = 'stg-done';
  let stateTxt = '✓ 已放行';
  if (isActive && p.stageBlocked) { stateCls = 'stg-trial'; stateTxt = '⏳ 试产中'; }
  else if (isActive) { stateCls = 'stg-active'; stateTxt = '▶ 施工中'; }
  else if (!gate || gate.opened) { stateCls = 'stg-done'; stateTxt = isLast ? '末阶段' : '✓ 已放行'; }
  else { stateCls = 'stg-pending'; stateTxt = '待开工'; }

  function setGateMode(mode) {
    if (mode === 'none') game.setPlanStageGate(p.id, k, null);
    else if (mode === 'built') game.setPlanStageGate(p.id, k, { mode: 'built' });
    else {
      const prev = p.stages[k].gate;
      game.setPlanStageGate(p.id, k, {
        mode: 'trial',
        item: prev && prev.item ? prev.item : null,
        n: prev && prev.n ? prev.n : FG.Config.STAGE_TRIAL_COUNT,
      });
    }
  }

  return (
    <div className={'stage-row' + (isActive ? ' is-active' : '')}>
      <div className="stage-head">
        <span className="stage-name">阶段 {k + 1}</span>
        <span className={'stage-state ' + stateCls}>{stateTxt}</span>
        <span className="stage-cnt">
          {sDone}/{stageEntries.length} 栋{sSkip ? `（跳 ${sSkip}）` : ''}
        </span>
      </div>

      {!isLast && (
        <>
          <div className="gate-row">
            <span className="gate-label">放行：</span>
            <select
              value={gate ? gate.mode : 'none'}
              onChange={(e) => setGateMode(e.target.value)}
            >
              <option value="none">无（建成即放行）</option>
              <option value="built">建成放行</option>
              <option value="trial">试产达标…</option>
            </select>
            {gate && gate.mode === 'trial' && <TrialGate game={game} p={p} k={k} gate={gate} />}
          </div>
          {gate && gate.opened && (
            <div className="gate-hint">已放行：收紧闸门将重新挂起后续施工</div>
          )}
          <b className="stage-rm" title="删除此阶段边界（并入下一阶段、取消该闸门）"
            onClick={() => game.removePlanStage(p.id, k)}>×</b>
        </>
      )}
    </div>
  );
}

function TrialGate({ game, p, k, gate }) {
  const cons = game.construction;
  const trialItems = cons.stageTrialItems(p, k);
  const need = gate.n || FG.Config.STAGE_TRIAL_COUNT;
  return (
    <>
      <select
        value={gate.item || ''}
        title="试产产物（空=任意产物）"
        onChange={(e) => game.setPlanStageGate(p.id, k, {
          mode: 'trial', item: e.target.value || null, n: gate.n || FG.Config.STAGE_TRIAL_COUNT,
        })}
      >
        <option value="">任意产物</option>
        {trialItems.map(it => <option key={it} value={it}>{FG.Items.byId(it).name}</option>)}
      </select>
      <input
        type="number" min="1" max="999" className="gate-n"
        value={need}
        title="需要完成的生产次数"
        onChange={(e) => {
          const n = Math.max(1, Math.min(999, parseInt(e.target.value, 10) || FG.Config.STAGE_TRIAL_COUNT));
          game.setPlanStageGate(p.id, k, { mode: 'trial', item: gate.item || null, n });
        }}
      />
      <span className="gate-prog">{cons.trialProgress(p, k)}/{need}</span>
    </>
  );
}
