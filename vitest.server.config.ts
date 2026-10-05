import { defineConfig } from 'vitest/config';
export default defineConfig({ root: '.', test: { include: ['server/tests/**/*.test.ts'], environment: 'node' } });
