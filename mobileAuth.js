import crypto from 'crypto';
import jwt from 'jsonwebtoken';

import {
    createPasswordRecord,
    findMobileUserByEmail,
    readPlatformData,
    mutatePlatformData,
    verifyPassword,
} from './platformStore.js';

const MOBILE_JWT_SECRET = process.env.MOBILE_JWT_SECRET || process.env.PORTAL_JWT_SECRET || 'snitch-mobile-dev-secret';

const buildMobileAuthPayload = (user) => ({
    sub: user.id,
    email: user.email,
    audience: 'mobile',
    trustTier: user.trustTier,
});

const buildMobileUserPublic = (user) => ({
    user_id: user.id,
    email: user.email,
    display_name: user.displayName,
    trust_tier: user.trustTier,
    referral_code: user.referralCode || null,
});

const createMobileToken = (user) => jwt.sign(buildMobileAuthPayload(user), MOBILE_JWT_SECRET, { expiresIn: '30d' });

export const signupMobileUser = async ({ email, password, displayName, display_name, referralCode, referral_code }) => {
    const normalizedEmail = String(email || '').trim().toLowerCase();
    if (!normalizedEmail || !password) {
        throw new Error('Email and password are required');
    }

    const existing = await findMobileUserByEmail(normalizedEmail);
    if (existing) {
        throw new Error('Email already registered');
    }

    const now = new Date().toISOString();
    const passwordRecord = createPasswordRecord(password, 'mobile-user');
    const user = await mutatePlatformData((data) => {
        const nextUser = {
            id: `mobile_${crypto.randomUUID()}`,
            email: normalizedEmail,
            displayName: displayName?.trim() || display_name?.trim() || normalizedEmail.split('@')[0],
            referralCode: referralCode?.trim() || referral_code?.trim() || null,
            trustTier: 'new',
            status: 'active',
            createdAt: now,
            updatedAt: now,
            restrictions: [],
            submissionCount: 0,
            confirmedCount: 0,
            totalRewardsInr: 0,
            ...passwordRecord,
        };

        data.mobileUsers.push(nextUser);
        return nextUser;
    });

    return {
        token: createMobileToken(user),
        ...buildMobileUserPublic(user),
    };
};

export const loginMobileUser = async ({ email, password }) => {
    const user = await findMobileUserByEmail(String(email || '').trim().toLowerCase());
    if (!user || user.status !== 'active') {
        throw new Error('Invalid credentials');
    }
    if (!verifyPassword(user, password)) {
        throw new Error('Invalid credentials');
    }

    return {
        token: createMobileToken(user),
        ...buildMobileUserPublic(user),
    };
};

const parseAuthToken = (req) => {
    const header = req.headers.authorization || '';
    if (!header.startsWith('Bearer ')) {
        return null;
    }

    return header.slice('Bearer '.length);
};

export const requireMobileAuth = async (req, res, next) => {
    try {
        const token = parseAuthToken(req);
        if (!token) {
            return res.status(401).json({ error: 'Authentication required' });
        }

        const claims = jwt.verify(token, MOBILE_JWT_SECRET);
        const data = await readPlatformData();
        const user = data.mobileUsers.find((item) => item.id === claims.sub);
        if (!user || user.status !== 'active') {
            return res.status(401).json({ error: 'Account is unavailable' });
        }

        req.mobileUser = user;
        next();
    } catch {
        return res.status(401).json({ error: 'Invalid or expired token' });
    }
};

export const toMobileUserPublic = buildMobileUserPublic;
