/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/tests'],
  testMatch: ['**/*.test.ts'],
  globals: {
    'ts-jest': {
      tsconfig: '<rootDir>/tsconfig.test.json',
      isolatedModules: true,
    },
  },
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/src/$1',
  },
  collectCoverageFrom: [
    'src/services/keeper-service.ts',
    'src/routes/auth.ts',
    'src/services/db2-direct-service.ts',
  ],
  coverageReporters: ['text', 'lcov'],
  clearMocks: true,
};
