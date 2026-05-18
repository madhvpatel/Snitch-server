import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const serverDir = path.resolve(scriptDir, '..');

dotenv.config({ path: path.join(serverDir, '.env') });
dotenv.config({ path: path.join(serverDir, '..', '.env') });

process.env.SNITCH_STORE_DRIVER = 'supabase';

const sourceFile = process.argv[2]
    ? path.resolve(process.cwd(), process.argv[2])
    : path.join(serverDir, 'data', 'platform-db.json');

const raw = await fs.readFile(sourceFile, 'utf8');
const data = JSON.parse(raw);

const { writePlatformData, readPlatformData } = await import('../platformStore.js');

await writePlatformData(data);
const stored = await readPlatformData();

const summary = Object.fromEntries(
    Object.entries(stored)
        .filter(([, value]) => Array.isArray(value))
        .map(([key, value]) => [key, value.length])
);

console.log(JSON.stringify({
    ok: true,
    sourceFile,
    version: stored.version,
    collections: summary,
}, null, 2));
