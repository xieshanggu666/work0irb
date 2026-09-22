/**
 * 仿真引擎引导层
 *
 * js/ 下的核心/数据/逻辑脚本为零依赖传统脚本，全部挂在全局命名空间 window.FG
 * （与重构前 <script> 顺序加载完全一致）。此处仅按依赖顺序引入，
 * 不修改任何引擎代码 —— test/ 下的无头测试仍直接运行原始文件。
 *
 * UI 层（React）通过本模块拿到同一个 FG 单例与事件总线 FG.Events。
 */

// ---- core ----
import '../js/core/config.js';
import '../js/core/utils.js';

// ---- data ----
import '../js/data/items.js';
import '../js/data/recipes.js';
import '../js/data/buildings.js';
import '../js/data/research.js';
import '../js/data/maps.js';
import '../js/data/pipelines.js';

// ---- game logic（顺序即依赖序） ----
import '../js/game/map.js';
import '../js/game/scheduler.js';
import '../js/game/railway.js';
import '../js/game/contracts.js';
import '../js/game/maintenance.js';
import '../js/game/sim.js';
import '../js/game/researchmgr.js';
import '../js/game/stats.js';
import '../js/game/save.js';
import '../js/game/blueprint.js';
import '../js/game/game.js';

// Canvas 渲染器仍是纯 Canvas 绘制器（无 DOM UI 依赖），原样引入
import '../js/ui/renderer.js';

export const FG = window.FG;
export default FG;
