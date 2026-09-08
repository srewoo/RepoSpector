import { validatePassword } from './auth.js';

export function login(user, password) {
    if (!validatePassword(user, password)) return null;
    return { userId: user.id, issuedAt: 0 };
}
