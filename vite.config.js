import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  base: './',
  plugins: [react()],
  optimizeDeps: { exclude: ['@electric-sql/pglite'] },
  worker: { format: 'es' },
  build: { target: 'es2022', assetsInlineLimit: 0, chunkSizeWarningLimit: 4000,
    // artifact 版只能是一个 JS: 按需加载的模块 (Excel 导出) 也内联进去
    rollupOptions: process.env.VITE_ARTIFACT === '1' ? { output: { inlineDynamicImports: true } } : {} },
});
