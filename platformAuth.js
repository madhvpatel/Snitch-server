import crypto from 'crypto';
import jwt from 'jsonwebtoken';

import { findUserByEmail, readPlatformData, verifyPassword } from './platformStore.js';

const JWT_SECRET = process.env.PORTAL_JWT_SECRET || 'snitch-dev-jwt-secret';
const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

const buildAuthPayload = (user) => ({
    sub: user.id,
    email: user.email,
    orgId: user.orgId,
    role: user.role,
    isPlatformAdmin: Boolean(user.isPlatformAdmin)
});

const decodeBase32 = (value) => {
    const normalized = (value || '')
        .toUpperCase()
        .replace(/=+$/g, '')
        .replace(/[^A-Z2-7]/g, '');

    let bits = '';
    for (const char of normalized) {
        const index = BASE32_ALPHABET.indexOf(char);
        if (index === -1) {
            throw new Error('Invalid base32 secret');
        }
        bits += index.toString(2).padStart(5, '0');
    }

    const bytes = [];
    for (let offset = 0; offset + 8 <= bits.length; offset += 8) {
        bytes.push(Number.parseInt(bits.slice(offset, offset + 8), 2));
    }

    return Buffer.from(bytes);
};

const generateTotpCode = (secret, timestamp = Date.now(), digits = 6, periodSeconds = 30) => {
    const key = decodeBase32(secret);
    const counter = BigInt(Math.floor(timestamp / 1000 / periodSeconds));
    const message = Buffer.alloc(8);
    message.writeBigUInt64BE(counter);

    const hmac = crypto.createHmac('sha1', key).update(message).digest();
    const offset = hmac[hmac.length - 1] & 0x0f;
    const binary = (
        ((hmac[offset] & 0x7f) << 24)
        | (hmac[offset + 1] << 16)
        | (hmac[offset + 2] << 8)
        | hmac[offset + 3]
    );

    return String(binary % (10 ** digits)).padStart(digits, '0');
};

const verifyTotpCode = (token, secret, windowSteps = 1) => {
    if (!token || !secret) {
        return false;
    }

    const normalizedToken = String(token).trim();
    if (!/^\d{6}$/.test(normalizedToken)) {
        return false;
    }

    const now = Date.now();
    for (let offset = -windowSteps; offset <= windowSteps; offset += 1) {
        const candidate = generateTotpCode(secret, now + (offset * 30 * 1000));
        if (crypto.timingSafeEqual(Buffer.from(normalizedToken), Buffer.from(candidate))) {
            return true;
        }
    }

    return false;
};

export const getCurrentTotpCode = (secret, timestamp = Date.now()) => generateTotpCode(secret, timestamp);

export const getTotpExpiryEpochMs = (timestamp = Date.now(), periodSeconds = 30) => (
    Math.floor(timestamp / 1000 / periodSeconds) * periodSeconds * 1000
) + (periodSeconds * 1000);

export const loginPortalUser = async ({ email, password, totpCode }) => {
    const user = await findUserByEmail(email);
    if (!user || user.status !== 'active') {
        throw new Error('Invalid credentials');
    }

    if (!verifyPassword(user, password)) {
        throw new Error('Invalid credentials');
    }

    if (!verifyTotpCode(totpCode, user.totpSecret)) {
        throw new Error('Invalid TOTP code');
    }

    const token = jwt.sign(buildAuthPayload(user), JWT_SECRET, { expiresIn: '8h' });
    const data = await readPlatformData();
    const org = data.orgs.find((item) => item.id === user.orgId) || null;

    return {
        token,
        user: {
            id: user.id,
            email: user.email,
            displayName: user.displayName,
            role: user.role,
            isPlatformAdmin: Boolean(user.isPlatformAdmin),
            org
        }
    };
};

const parseAuthToken = (req) => {
    const header = req.headers.authorization || '';
    if (!header.startsWith('Bearer ')) {
        return null;
    }

    return header.slice('Bearer '.length);
};

export const requireAuth = async (req, res, next) => {
    try {
        const token = parseAuthToken(req);
        if (!token) {
            return res.status(401).json({ error: 'Authentication required' });
        }

        const claims = jwt.verify(token, JWT_SECRET);
        const data = await readPlatformData();
        const user = data.orgUsers.find((item) => item.id === claims.sub);
        const org = data.orgs.find((item) => item.id === claims.orgId) || null;

        if (!user || user.status !== 'active') {
            return res.status(401).json({ error: 'Account is unavailable' });
        }

        req.portalUser = {
            ...claims,
            displayName: user.displayName,
            org
        };

        next();
    } catch {
        return res.status(401).json({ error: 'Invalid or expired token' });
    }
};

export const requirePlatformAdmin = (req, res, next) => {
    if (!req.portalUser?.isPlatformAdmin) {
        return res.status(403).json({ error: 'Platform admin access required' });
    }

    next();
};
