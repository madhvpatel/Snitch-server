import { parse } from 'csv-parse/sync';

export const readCsvRecords = (input) => {
    const text = Buffer.isBuffer(input) ? input.toString('utf8') : String(input || '');
    if (!text.trim()) {
        return [];
    }

    return parse(text, {
        columns: true,
        skip_empty_lines: true,
        trim: true,
    });
};

