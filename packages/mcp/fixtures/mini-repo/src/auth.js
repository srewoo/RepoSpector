export function validatePassword(user, password) {
    return hashPassword(password) === user.passwordHash;
}

export function hashPassword(password) {
    return `hashed:${password}`;
}
