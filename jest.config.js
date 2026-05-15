module.exports = {
  testEnvironment: 'node',
  preset: 'ts-jest',
  roots: ['<rootDir>'],
  testMatch: ['**/__tests__/**/*.test.ts', '**/__tests__/**/*.test.tsx'],
  moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx', 'json'],
  transformIgnorePatterns: ['node_modules/(?!fast-xml-parser)'],
  collectCoverageFrom: [
    'services/**/*.ts',
    '!**/*.d.ts',
    '!**/node_modules/**',
  ],
};
