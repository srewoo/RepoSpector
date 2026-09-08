const { validatePassword } = require('../src/auth.js');
test('validatePassword accepts a matching hash', () => {
    expect(validatePassword({ passwordHash: 'hashed:pw' }, 'pw')).toBe(true);
});
