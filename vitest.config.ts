import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		// Look for test files in src/ with .test.ts extension
		include: ['src/**/*.test.ts'],

		// Use node environment (not browser/jsdom - we're testing pure logic)
		environment: 'node',

		// Show individual test names when running
		reporters: ['verbose'],
	},
});
