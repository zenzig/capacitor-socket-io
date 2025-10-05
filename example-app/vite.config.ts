import { defineConfig } from 'vite';

export default defineConfig({
  envDir: '..',
  root: './src',
  build: {
    outDir: '../dist',
    minify: false,
    emptyOutDir: true,
  },
});
