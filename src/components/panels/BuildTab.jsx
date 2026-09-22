/**
 * 施工页：蓝图剪贴板信息 + 全部施工/升级计划（优先级、前置依赖、分阶段闸门）
 */
import { FG } from '../../engine';
import { useModal } from '../ModalContext.jsx';
import { Section, ProgressBar } from './ui.jsx';
import StagesEditor from './StagesEditor.jsx';

const PRIO_ORDER = { high: 0, normal: 1, low: 2 };
const PRIO_CN = { high: '高', normal: '中', low: '低' };

function planStatus(p) {
  if (p.paused) return { txt: '已暂停', cls: 'st-paused' };
  if (p.blocked) return { txt: '等待前置', cls: 'st-blocked' };
  if (p.stageBlocked) return { txt: '阶段试产', cls: 'st-stage' };
  if (p.waiting) return { txt: '缺料等待', cls: 'st-waiting' };
  return { txt: '施工中', cls: 'st-active' };
}

export default function BuildTab({ game }) {
  const modal = useModal();
  const cons = game.construction;
  const bp = game.blueprint;
  const cost = bp ? FG.Blueprint.costOf(bp) : null;
  const costTxt = cost ? Object.keys(cost).map(k => FG.Items.byId(k).name + '×' + cost[k]).join('　') : '';
  const preset = bp && bp.fromPreset ? FG.Pipelines.byId(bp.fromPreset) : null;

  const sorted = cons.plans.slice().sort((a, b) => PRIO_ORDER[a.priority] - PRIO_ORDER[b.priority]);

  return (
    <>
      <Section title="蓝图">
        <div className="action-row" style={{ marginBottom: 6 }}>
          <button onClick={() => modal.pipelines()}>⚡ 一键流水线 (P)</button>
        </div>
        {bp ? (
          <>
            <div className="info-grid">
              <div className="k">来源</div><div className="v">{preset ? '⚡ ' + preset.name : '框选蓝图'}</div>
              <div className="k">规模</div><div className="v">{bp.entries.length} 栋 · {bp.w}×{bp.h}</div>
              <div className="k">建材</div><div className="v" style={{ fontFamily: 'inherit' }}>{costTxt || '无'}</div>
            </div>
            <div style={{ color: 'var(--text-dim)', fontSize: 11, marginTop: 6, lineHeight: 1.6 }}>
              {preset
                ? <>左键提交整套施工 · <b>R</b> 旋转 · <b>F</b> 重新智能选位 · 可连续盖章。</>
                : <>按 <b>B</b> 放置预览：移动选位、<b>R</b> 旋转、左键提交施工计划；再按 <b>B</b> 重新框选。</>}
            </div>
          </>
        ) : (
          <div style={{ color: 'var(--text-dim)', fontSize: 11, lineHeight: 1.7 }}>
            按 <b>P</b> 选择<b style={{ color: 'var(--accent2)' }}>预设流水线</b>一键铺设，或按 <b>B</b> 框选已有产线生成蓝图。<br />
            施工计划自动从<b>箱子 / 地面物料堆</b>预留建材；缺料时等待，取消时返还。
          </div>
        )}
      </Section>

      <Section title={`施工计划（${cons.plans.length}）`}>
        {cons.plans.length === 0 && (
          <div style={{ color: 'var(--text-dim)', fontSize: 11 }}>暂无进行中的施工计划</div>
        )}
        {sorted.map(p => (
          <PlanCard key={p.id} game={game} p={p} />
        ))}
      </Section>
    </>
  );
}

function PlanCard({ game, p }) {
  const cons = game.construction;
  const total = p.entries.length;
  const done = p.entries.filter(e => e.state === 'done').length;
  const skipped = p.entries.filter(e => e.state === 'skip').length;
  let head = null;
  for (let i = p.cursor; i < total; i++) {
    if (p.entries[i].state === 'wait') { head = p.entries[i]; break; }
  }
  if (!head) head = p.entries.find(e => e.state === 'wait') || null;
  const st = planStatus(p);

  // 可设置为前置的其他计划（排除会成环的）
  const canDeps = cons.plans.filter(q => q.id !== p.id && !p.deps.includes(q.id) && !dependsOn(game, q, p.id));

  return (
    <div className={'bp-plan' + (p.paused ? ' is-paused' : '')}>
      <div className="bp-head">
        <span title={p.id}>
          {p.kind === 'upgrade' && <span className="up-badge">升级</span>}
          {p.name}
        </span>
        <span className={'plan-st ' + st.cls}>{st.txt}</span>
      </div>
      <ProgressBar pct={done / total} />
      <div style={{ fontSize: 11, color: 'var(--text-dim)' }}>
        进度 {done}/{total} 栋{skipped ? ` · 跳过 ${skipped}` : ''}
      </div>

      <StagesEditor game={game} p={p} />

      <div className="prio-row plan-prio">
        {['high', 'normal', 'low'].map(id => (
          <button key={id}
            className={'prio-btn prio-' + id + (p.priority === id ? ' active' : '')}
            onClick={() => game.setPlanPriority(p.id, id)}>{PRIO_CN[id]}</button>
        ))}
      </div>

      <div className="dep-row">
        {p.deps.map(id => {
          const d = cons.byId(id);
          if (!d) return null;
          return (
            <span className="dep-chip" key={id}>
              ⛓ {d.name} <b title="移除前置" onClick={() => game.removePlanDep(p.id, id)}>×</b>
            </span>
          );
        })}
        {canDeps.length > 0 && (
          <select className="dep-select" value="" onChange={(e) => {
            if (e.target.value) game.addPlanDep(p.id, e.target.value);
          }}>
            <option value="">＋ 设前置…</option>
            {canDeps.map(q => <option key={q.id} value={q.id}>{q.name}</option>)}
          </select>
        )}
      </div>

      {head && head.state === 'wait' && <HeadEntry game={game} p={p} head={head} />}

      <div className="action-row">
        <button onClick={() => game.togglePlanPaused(p.id)}>{p.paused ? '▶ 继续' : '⏸ 暂停'}</button>
        <button className="danger" onClick={() => game.cancelConstruction(p.id)}>取消并返还建材</button>
      </div>
    </div>
  );
}

function HeadEntry({ game, p, head }) {
  const cons = game.construction;
  const def = FG.Buildings.byId(head.type);
  const cost = FG.Buildings.costOf(head.type);
  const parts = Object.keys(cost).map(k =>
    `${FG.Items.byId(k).name} ${Math.min(head.stock[k] || 0, cost[k])}/${cost[k]}`);
  const headName = head.from
    ? FG.Buildings.byId(head.from).name + ' → ' + def.name
    : def.name;
  return (
    <>
      <div style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 3 }}>
        {head.from ? '待换' : '待建'}：{headName}（{head.x},{head.y}）{parts.length ? ' · ' + parts.join(' · ') : ''}
      </div>
      {!p.paused && !p.blocked && p.waiting && (
        <div style={{ fontSize: 10, color: 'var(--text-dim)', marginTop: 2 }}>前沿缺料：后续能凑齐建材的建筑会先行建成</div>
      )}
      {p.blocked && (
        <div style={{ fontSize: 10, color: 'var(--text-dim)', marginTop: 2 }}>
          等待前置计划完工：{p.deps.map(id => cons.byId(id) ? cons.byId(id).name : null).filter(Boolean).join('、')}
        </div>
      )}
      {!p.paused && !p.blocked && p.stageBlocked && (
        <div style={{ fontSize: 10, color: '#7fc7ff', marginTop: 2 }}>⏳ {p.stageReason || '等待前置阶段放行'}</div>
      )}
    </>
  );
}

/** q 是否（经依赖链传递）依赖 planId */
function dependsOn(game, q, planId) {
  const cons = game.construction;
  const stack = q.deps.slice();
  const seen = new Set();
  while (stack.length) {
    const id = stack.pop();
    if (id === planId) return true;
    if (seen.has(id)) continue;
    seen.add(id);
    const d = cons.byId(id);
    if (d) stack.push(...d.deps);
  }
  return false;
}
