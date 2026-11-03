import { defineConfig } from 'vitest/config';

// `base: './'` keeps asset URLs relative so the build works from any
// sub-path (e.g. GitHub Pages at /<repo>/).
export default defineConfig({
  base: './',
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
});
