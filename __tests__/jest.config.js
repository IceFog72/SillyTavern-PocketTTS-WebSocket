export default {
    verbose: true,
    testEnvironment: 'jsdom',
    testMatch: ['**/__tests__/**/*.test.js'],
    transform: {},
    roots: ['<rootDir>/..'],
    moduleFileExtensions: ['js', 'json'],
    moduleNameMapper: {
        '\\.css$': '<rootDir>/empty-module.js',
        '/tts/index\\.js$': '<rootDir>/mocks/tts-mock.js',
    },
};
