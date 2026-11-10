module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  testMatch: ['<rootDir>/tests/**/*.test.ts'],
  testTimeout: 60000,
  collectCoverageFrom: ['src/**/*.ts', '!src/server.ts', '!src/migrate-cli.ts', '!src/reconcile-cli.ts'],
  coverageReporters: ['text', 'text-summary', 'json-summary'],
  coverageThreshold: { global: { statements: 90, branches: 85, functions: 85, lines: 90 } },
  maxWorkers: 1,
};
