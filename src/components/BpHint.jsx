/**
 * 地图顶部蓝图/升级模式提示条（移植自原 FG.Topbar.updateBpHint）
 */
import { FG } from '../engine';

export function BpHint({ game }) {
  let html = '';
  if (game.upMode === 'select') {
    html = '⬆ <b>原地升级</b>：按住左键框选产线，框内建筑批量替换为<b>已解锁的最高级型号</b>'
      + '（配方/库存/在途物料保留） · <span class="bh-key">Esc</span> 退出';
  } else if (game.upMode === 'confirm') {
    const pv = game.upPreview;
    const costTxt = pv ? Object.keys(pv.cost).map(k => FG.Items.byId(k).name + '×' + pv.cost[k]).join(' ') : '';
    html = `⬆ <b>升级预览</b>：${pv ? pv.entries.length : 0} 栋建筑（备料 ${costTxt}）—— `
      + `<span class="bh-key">左键</span>确认提交施工 · <span class="bh-key">右键</span>/<span class="bh-key">Esc</span> 重选`;
  } else if (game.bpMode === 'select') {
    html = '📐 <b>框选产线</b>：按住左键拖出矩形区域，框住已有建筑生成蓝图';
  } else if (game.pipelineId) {
    const p = FG.Pipelines.byId(game.pipelineId);
    const n = game.blueprint ? game.blueprint.entries.length : 0;
    html = `⚡ 一键流水线 <b>${p ? p.name : ''}</b>（${n} 栋）：`
      + `<span class="bh-key">左键</span>提交整套施工 · <span class="bh-key">R</span>旋转 · `
      + `<span class="bh-key">F</span>重新智能选位 · <span class="bh-key">Esc</span>取消`
      + (game.bpAnchor ? '' : '　<span style="color:var(--red)">未找到合适落点，请对准资源后按 F</span>');
  } else {
    html = '📐 <b>蓝图放置</b>：<span class="bh-key">左键</span>提交施工计划 · '
      + '<span class="bh-key">R</span>旋转 · <span class="bh-key">B</span>重新框选 · <span class="bh-key">Esc</span>退出';
  }
  return <div id="bp-hint" dangerouslySetInnerHTML={{ __html: html }} />;
}
