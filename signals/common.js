export const cleanString = (value) => String(value || '').trim().toLowerCase();

export const pickBooleanLike = (value) => (value === true || value === false ? value : null);

export const pickNumberLike = (value) => {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : null;
};

export const pickStringLike = (value) => (typeof value === 'string' && value.trim() ? value.trim() : null);

export const parseMaybeJson = (value) => {
    if (value == null) {
        return null;
    }

    if (typeof value === 'object') {
        return value;
    }

    if (typeof value !== 'string') {
        return null;
    }

    try {
        return JSON.parse(value);
    } catch {
        return null;
    }
};

export const scoreZeroToOne = (value, fallback = 0) => {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) {
        return fallback;
    }

    return Math.max(0, Math.min(1, numeric));
};

export const includesAnyPattern = (text, patterns = []) => patterns.some((pattern) => pattern.test(text));
