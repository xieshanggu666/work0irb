import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// React 重构版：UI 由 React 组件驱动；js/ 下的仿真引擎为零依赖的传统脚本，
// 原样保留（现有 600+ 个无头测试直接 node 运行，不经构建）。
//
// 注意：重构前的原版页面归档在 legacy/index.html（纯 <script> 顺序加载，
// 双击即玩，供对照）；React 版入口是根目录 index.html。
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    open: false,
  },
  build: {
    target: 'es2020',
  },
});
