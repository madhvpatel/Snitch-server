import crypto, { scryptSync, timingSafeEqual } from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import pg from 'pg';
import { mergeSeedRecords, seedContributors, seedTariffTable } from './platformRewards.js';

const { Pool } = pg;
const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.SNITCH_DATA_DIR
    ? path.resolve(process.env.SNITCH_DATA_DIR)
    : path.join(moduleDir, 'data');
const DB_FILE = path.join(DATA_DIR, 'platform-db.json');
const DB_BAK_FILE = path.join(DATA_DIR, 'platform-db.bak.json');
const DB_TMP_FILE = path.join(DATA_DIR, 'platform-db.tmp.json');
const ASSET_DIR = path.join(DATA_DIR, 'assets');
const STORE_DRIVER = String(process.env.SNITCH_STORE_DRIVER || 'file').trim().toLowerCase();
const USE_SUPABASE_STORE = STORE_DRIVER === 'supabase' || STORE_DRIVER === 'postgres';
const DATABASE_URL = process.env.DATABASE_URL || process.env.SUPABASE_DATABASE_URL || '';
const DEFAULT_PASSWORD = process.env.SNITCH_DEMO_PASSWORD || 'snitch-demo-2026';
const DEFAULT_USERS = [
    {
        id: 'user_admin_demo',
        orgId: 'org_platform_admin',
        email: 'admin@snitch.local',
        displayName: 'Platform Admin',
        role: 'admin',
        isPlatformAdmin: true,
        totpSecret: 'JBSWY3DPEHPK3PXP',
    },
    {
        id: 'user_label_demo',
        orgId: 'org_label_saregama',
        email: 'label@saregama.demo',
        displayName: 'Saregama Analyst',
        role: 'manager',
        isPlatformAdmin: false,
        totpSecret: 'KRSXG5DSNFXGOIDB',
    },
    {
        id: 'user_collective_demo',
        orgId: 'org_collective_iprs',
        email: 'iprs@snitch.demo',
        displayName: 'IPRS Analyst',
        role: 'manager',
        isPlatformAdmin: false,
        totpSecret: 'MFZXK4TFOI======',
    }
];

export const hashPassword = (password, salt) => scryptSync(password, salt, 64).toString('hex');

export const createPasswordRecord = (password, saltPrefix = 'snitch-user') => {
    const salt = `${saltPrefix}-${crypto.randomUUID()}`;
    return {
        passwordSalt: salt,
        passwordHash: hashPassword(password, salt)
    };
};

const createSeededUsers = () => DEFAULT_USERS.map((user, index) => {
    const salt = `snitch-demo-salt-${index}`;
    return {
        ...user,
        passwordSalt: salt,
        passwordHash: hashPassword(DEFAULT_PASSWORD, salt),
        status: 'active',
        createdAt: new Date().toISOString(),
    };
});

const ensureArray = (value) => (Array.isArray(value) ? value : []);

const normalizePlatformData = (data) => {
    let changed = false;

    if (!data.version || data.version < 4) {
        data.version = 4;
        changed = true;
    }

    const defaultArrays = {
        orgs: defaultDb().orgs,
        orgUsers: createSeededUsers(),
        mobileUsers: [],
        anonymousInstalls: [],
        captureSessions: [],
        submissions: [],
        reports: [],
        venues: [],
        catalogTracks: defaultDb().catalogTracks,
        venueCoverage: [],
        analystReviews: [],
        sourceReviews: [],
        casePackets: [],
        assets: [],
        contributors: seedContributors(),
        merchantMaster: [],
        licenseStatus: [],
        tariffTable: seedTariffTable(),
        caseLedger: [],
        rewardLedger: []
    };

    for (const [key, fallback] of Object.entries(defaultArrays)) {
        if (!Array.isArray(data[key])) {
            data[key] = ensureArray(fallback);
            changed = true;
        }
    }

    const mergedContributors = mergeSeedRecords(data.contributors, seedContributors());
    if (mergedContributors.length !== data.contributors.length) {
        data.contributors = mergedContributors;
        changed = true;
    }

    const mergedTariffs = mergeSeedRecords(data.tariffTable, seedTariffTable());
    if (mergedTariffs.length !== data.tariffTable.length) {
        data.tariffTable = mergedTariffs;
        changed = true;
    }

    return changed;
};

const defaultDb = () => ({
    version: 4,
    orgs: [
        {
            id: 'org_platform_admin',
            slug: 'platform-admin',
            type: 'platform',
            jurisdiction: 'IN',
            name: 'Snitch Platform',
            status: 'active',
            portalSettings: { color: 'slate', proCode: null }
        },
        {
            id: 'org_label_saregama',
            slug: 'saregama-demo',
            type: 'label',
            jurisdiction: 'IN',
            name: 'Saregama Demo',
            status: 'active',
            portalSettings: { color: 'amber', proCode: null }
        },
        {
            id: 'org_collective_iprs',
            slug: 'iprs-demo',
            type: 'collective',
            jurisdiction: 'IN',
            name: 'IPRS Demo',
            status: 'active',
            portalSettings: { color: 'emerald', proCode: 'IPRS' }
        }
    ],
    orgUsers: createSeededUsers(),
    mobileUsers: [],
    anonymousInstalls: [],
    captureSessions: [],
    submissions: [],
    reports: [],
    venues: [],
    catalogTracks: [
        {
            id: 'track_demo_1',
            orgId: 'org_label_saregama',
            title: 'Test Song',
            artist: 'The Fixtures',
            isrc: 'IN-SN1-24-00001',
            externalIds: [],
            activeFrom: '2024-01-01',
            activeTo: null,
            createdAt: new Date().toISOString()
        }
    ],
    venueCoverage: [],
    analystReviews: [],
    sourceReviews: [],
    casePackets: [],
    assets: [],
    contributors: seedContributors(),
    merchantMaster: [],
    licenseStatus: [],
    tariffTable: seedTariffTable(),
    caseLedger: [],
    rewardLedger: []
});

const clone = (value) => JSON.parse(JSON.stringify(value));

let mutationQueue = Promise.resolve();
let pgPool = null;
let supabaseStoreReady = false;

export const MEDIA_DIR = ASSET_DIR;

export const createReference = (prefix) => {
    const suffix = crypto.randomBytes(3).toString('hex').toUpperCase();
    return `${prefix}-${suffix}`;
};

export const stableHash = (value) => crypto
    .createHash('sha256')
    .update(typeof value === 'string' ? value : JSON.stringify(value))
    .digest('hex');

export const hashIp = (ip) => stableHash(`${process.env.IP_HASH_SALT || 'snitch-ip'}:${ip || 'unknown'}`);

const ensureStore = async () => {
    await fs.mkdir(DATA_DIR, { recursive: true });
    await fs.mkdir(ASSET_DIR, { recursive: true });

    try {
        await fs.access(DB_FILE);
    } catch {
        await fs.writeFile(DB_FILE, JSON.stringify(defaultDb(), null, 2), 'utf8');
    }
};

const getPgPool = () => {
    if (!USE_SUPABASE_STORE) {
        return null;
    }
    if (!DATABASE_URL) {
        throw new Error('SNITCH_STORE_DRIVER=supabase requires DATABASE_URL or SUPABASE_DATABASE_URL');
    }
    if (!pgPool) {
        pgPool = new Pool({
            connectionString: DATABASE_URL,
            ssl: process.env.PGSSLMODE === 'disable' ? false : { rejectUnauthorized: false },
            max: Number(process.env.PG_POOL_MAX || 4),
            allowExitOnIdle: true,
            idleTimeoutMillis: 30_000,
            connectionTimeoutMillis: 10_000,
        });
    }
    return pgPool;
};

const ensureSupabaseStore = async () => {
    if (supabaseStoreReady) {
        return;
    }
    const pool = getPgPool();
    await pool.query(`
        create extension if not exists pgcrypto;

        create table if not exists public.platform_state (
            id text primary key default 'default',
            version integer not null default 4,
            data jsonb not null default '{}'::jsonb,
            created_at timestamptz not null default now(),
            updated_at timestamptz not null default now(),
            constraint platform_state_singleton check (id = 'default'),
            constraint platform_state_data_is_object check (jsonb_typeof(data) = 'object')
        );

        create or replace function public.set_updated_at()
        returns trigger
        language plpgsql
        as $$
        begin
            new.updated_at = now();
            return new;
        end;
        $$;

        drop trigger if exists set_platform_state_updated_at on public.platform_state;
        create trigger set_platform_state_updated_at
        before update on public.platform_state
        for each row
        execute function public.set_updated_at();
    `);
    supabaseStoreReady = true;
};

const writePlatformDataAtomically = async (serializedData, options = {}) => {
    await ensureStore();
    const { updateBackup = true } = options;

    await fs.writeFile(DB_TMP_FILE, serializedData, 'utf8');

    if (updateBackup) {
        try {
            const existing = await fs.readFile(DB_FILE, 'utf8');
            if (existing.trim()) {
                await fs.writeFile(DB_BAK_FILE, existing, 'utf8');
            }
        } catch {
            // No existing DB yet, nothing to back up.
        }
    }

    await fs.rename(DB_TMP_FILE, DB_FILE);
};

const persistCorruptSnapshot = async (rawContent) => {
    if (!rawContent) {
        return;
    }

    const timestamp = new Date().toISOString().replaceAll(':', '-');
    const corruptFile = path.join(DATA_DIR, `platform-db.corrupt.${timestamp}.json`);
    await fs.writeFile(corruptFile, rawContent, 'utf8').catch(() => {});
};

const parsePlatformData = (content) => {
    const data = JSON.parse(content);
    if (normalizePlatformData(data)) {
        return {
            data,
            changed: true
        };
    }

    return {
        data,
        changed: false
    };
};

export const readPlatformData = async () => {
    if (USE_SUPABASE_STORE) {
        await ensureSupabaseStore();
        const pool = getPgPool();
        const result = await pool.query('select data from public.platform_state where id = $1', ['default']);

        if (!result.rowCount) {
            const fresh = defaultDb();
            await writeSupabasePlatformData(fresh);
            return fresh;
        }

        const data = result.rows[0].data;
        if (normalizePlatformData(data)) {
            await writeSupabasePlatformData(data);
        }
        return data;
    }

    await ensureStore();

    const tryRead = async (filename) => {
        const content = await fs.readFile(filename, 'utf8');
        if (!content.trim()) {
            throw new Error('Platform DB file is empty');
        }

        return {
            content,
            ...parsePlatformData(content)
        };
    };

    try {
        const result = await tryRead(DB_FILE);
        if (result.changed) {
            await writePlatformData(result.data);
        }
        return result.data;
    } catch (primaryError) {
        const badContent = await fs.readFile(DB_FILE, 'utf8').catch(() => '');
        await persistCorruptSnapshot(badContent);
        console.warn('Primary platform DB could not be parsed, attempting recovery:', primaryError.message);

        try {
            const backup = await tryRead(DB_BAK_FILE);
            await writePlatformData(backup.data, { updateBackup: false });
            console.warn('Recovered platform DB from backup:', DB_BAK_FILE);
            return backup.data;
        } catch {
            const fresh = defaultDb();
            await writePlatformData(fresh, { updateBackup: false });
            console.warn('No valid platform DB backup was available, reinitialized store.');
            return fresh;
        }
    }
};

const writeSupabasePlatformData = async (data) => {
    await ensureSupabaseStore();
    const pool = getPgPool();
    const version = Number(data?.version || 4);
    await pool.query(
        `
            insert into public.platform_state (id, version, data)
            values ('default', $1, $2::jsonb)
            on conflict (id) do update
            set version = excluded.version,
                data = excluded.data
        `,
        [version, JSON.stringify(data)]
    );
};

export const writePlatformData = async (data, options = {}) => {
    if (USE_SUPABASE_STORE) {
        await writeSupabasePlatformData(data);
        return;
    }

    await writePlatformDataAtomically(JSON.stringify(data, null, 2), options);
};

export const mutatePlatformData = async (mutator) => {
    const nextMutation = mutationQueue.then(async () => {
        const data = await readPlatformData();
        const result = await mutator(data);
        await writePlatformData(data);
        return result;
    });

    mutationQueue = nextMutation.then(() => undefined, () => undefined);
    return nextMutation;
};

const inferExtension = (filename, mimeType) => {
    const fromName = path.extname(filename || '');
    if (fromName) {
        return fromName;
    }

    if (mimeType?.includes('webm')) {
        return '.webm';
    }
    if (mimeType?.includes('wav')) {
        return '.wav';
    }
    if (mimeType?.includes('json')) {
        return '.json';
    }
    if (mimeType?.includes('zip')) {
        return '.zip';
    }
    return '.bin';
};

const buildAssetRecord = ({ assetId, kind, fileName, mimeType, relativePath, sizeBytes, metadata = {}, createdAt }) => ({
    id: assetId,
    kind,
    fileName,
    mimeType,
    relativePath: relativePath.replaceAll('\\', '/'),
    sizeBytes,
    metadata,
    createdAt
});

const writeAssetBuffer = async ({ assetId = crypto.randomUUID(), buffer, fileName, mimeType, kind }) => {
    await ensureStore();

    const extension = inferExtension(fileName, mimeType);
    const relativePath = path.join(kind, `${assetId}${extension}`);
    const absolutePath = path.join(ASSET_DIR, relativePath);

    await fs.mkdir(path.dirname(absolutePath), { recursive: true });
    await fs.writeFile(absolutePath, buffer);

    return {
        assetId,
        fileName: fileName || `${assetId}${extension}`,
        mimeType: mimeType || 'application/octet-stream',
        relativePath,
        sizeBytes: buffer.length,
        createdAt: new Date().toISOString()
    };
};

export const registerAssetRecord = async (assetRecord) => mutatePlatformData((data) => {
    const existing = data.assets.find((asset) => asset.id === assetRecord.id) || null;
    if (existing) {
        return existing;
    }

    data.assets.push(assetRecord);
    return assetRecord;
});

export const saveAsset = async ({ buffer, fileName, mimeType, kind, metadata = {} }) => {
    const file = await writeAssetBuffer({ buffer, fileName, mimeType, kind });
    const assetRecord = buildAssetRecord({
        assetId: file.assetId,
        kind,
        fileName: file.fileName,
        mimeType: file.mimeType,
        relativePath: file.relativePath,
        sizeBytes: file.sizeBytes,
        metadata,
        createdAt: file.createdAt
    });

    await registerAssetRecord(assetRecord);
    return assetRecord;
};

export const removeAsset = async (assetId) => {
    await mutatePlatformData(async (data) => {
        const index = data.assets.findIndex((asset) => asset.id === assetId);
        if (index === -1) {
            return;
        }

        const [asset] = data.assets.splice(index, 1);
        await fs.rm(path.join(ASSET_DIR, asset.relativePath), { force: true });
    });
};

export const getAssetRecord = async (assetId) => {
    const data = await readPlatformData();
    return data.assets.find((asset) => asset.id === assetId) || null;
};

export const getAssetAbsolutePath = async (assetId) => {
    const asset = await getAssetRecord(assetId);
    if (!asset) {
        return null;
    }

    return path.join(ASSET_DIR, asset.relativePath);
};

export const ensureAssetRecord = async ({ assetId, kind, fileName, mimeType, metadata = {} }) => {
    if (!assetId || !kind) {
        return null;
    }

    const existing = await getAssetRecord(assetId);
    if (existing) {
        return existing;
    }

    const kindDir = path.join(ASSET_DIR, kind);
    const entries = await fs.readdir(kindDir).catch(() => []);
    const match = entries.find((entry) => entry === assetId || entry.startsWith(`${assetId}.`));
    if (!match) {
        return null;
    }

    const absolutePath = path.join(kindDir, match);
    const stats = await fs.stat(absolutePath);
    const assetRecord = buildAssetRecord({
        assetId,
        kind,
        fileName: fileName || match,
        mimeType: mimeType || 'application/octet-stream',
        relativePath: path.join(kind, match),
        sizeBytes: stats.size,
        metadata,
        createdAt: new Date(stats.birthtimeMs || stats.mtimeMs).toISOString()
    });

    await registerAssetRecord(assetRecord);
    return assetRecord;
};

export const buildAssetUrl = (req, asset) => `${req.protocol}://${req.get('host')}/media/${asset.relativePath}`;

export const findUserByEmail = async (email) => {
    const data = await readPlatformData();
    return data.orgUsers.find((user) => user.email.toLowerCase() === email.toLowerCase()) || null;
};

export const findMobileUserByEmail = async (email) => {
    const data = await readPlatformData();
    return data.mobileUsers.find((user) => user.email.toLowerCase() === email.toLowerCase()) || null;
};

export const findMobileUserById = async (userId) => {
    const data = await readPlatformData();
    return data.mobileUsers.find((user) => user.id === userId) || null;
};

export const verifyPassword = (user, password) => {
    const expected = Buffer.from(user.passwordHash, 'hex');
    const provided = Buffer.from(hashPassword(password, user.passwordSalt), 'hex');
    return expected.length === provided.length && timingSafeEqual(expected, provided);
};

export const listDemoUsers = async () => {
    const data = await readPlatformData();
    return data.orgUsers.map((user) => {
        const org = data.orgs.find((item) => item.id === user.orgId);
        return {
            email: user.email,
            role: user.role,
            org: org?.name || user.orgId,
            totpSecret: user.totpSecret
        };
    });
};

export const toPublicReport = (req, data, report) => {
    const org = report.rightsOwnerOrgId
        ? data.orgs.find((item) => item.id === report.rightsOwnerOrgId) || null
        : null;
    const submission = data.submissions.find((item) => item.id === report.submissionId) || null;
    const venue = report.venueId ? data.venues?.find?.((item) => item.id === report.venueId) ?? null : null;
    const asset = submission?.rawVideoAssetId
        ? data.assets.find((item) => item.id === submission.rawVideoAssetId) || null
        : null;

    return {
        ...clone(report),
        org,
        submission: submission ? {
            ...clone(submission),
            rawVideoUrl: asset ? buildAssetUrl(req, asset) : null,
        } : null,
        venue
    };
};
