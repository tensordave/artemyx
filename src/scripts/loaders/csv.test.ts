/**
 * Unit tests for csv.ts
 * Tests delimiter detection and CSV parsing.
 */

import { describe, it, expect } from 'vitest';
import { detectDelimiter, parseCSV } from './csv';

describe('detectDelimiter', () => {
	it('comma-separated header', () => {
		expect(detectDelimiter('name,lat,lng')).toBe(',');
	});

	it('semicolon-separated header', () => {
		expect(detectDelimiter('name;lat;lng')).toBe(';');
	});

	it('tab-separated header', () => {
		expect(detectDelimiter('name\tlat\tlng')).toBe('\t');
	});

	it('pipe-separated header', () => {
		expect(detectDelimiter('name|lat|lng')).toBe('|');
	});

	it('ignores delimiters inside quoted fields', () => {
		// The commas inside quotes should not be counted
		expect(detectDelimiter('"name,with,commas";lat;lng')).toBe(';');
	});

	it('falls back to comma when no delimiters found', () => {
		expect(detectDelimiter('singlecolumn')).toBe(',');
	});

	it('picks the most frequent delimiter', () => {
		// 3 semicolons vs 1 comma inside a value
		expect(detectDelimiter('a;b;c;d')).toBe(';');
	});
});

describe('parseCSV', () => {
	it('basic comma-separated rows', () => {
		const csv = 'name,value\nalpha,1\nbeta,2';
		const rows = parseCSV(csv);
		expect(rows).toHaveLength(2);
		expect(rows[0]).toEqual({ name: 'alpha', value: '1' });
		expect(rows[1]).toEqual({ name: 'beta', value: '2' });
	});

	it('semicolon-separated rows', () => {
		const csv = 'name;value\nalpha;1\nbeta;2';
		const rows = parseCSV(csv);
		expect(rows).toHaveLength(2);
		expect(rows[0]).toEqual({ name: 'alpha', value: '1' });
	});

	it('quoted fields with embedded commas', () => {
		const csv = 'name,desc\nalpha,"has, comma"\nbeta,plain';
		const rows = parseCSV(csv);
		expect(rows[0].desc).toBe('has, comma');
	});

	it('escaped quotes (double-quote)', () => {
		const csv = 'name,desc\nalpha,"says ""hello"""\nbeta,plain';
		const rows = parseCSV(csv);
		expect(rows[0].desc).toBe('says "hello"');
	});

	it('multi-line quoted fields', () => {
		const csv = 'name,desc\nalpha,"line1\nline2"\nbeta,plain';
		const rows = parseCSV(csv);
		expect(rows).toHaveLength(2);
		expect(rows[0].desc).toBe('line1\nline2');
	});

	it('CRLF line endings', () => {
		const csv = 'name,value\r\nalpha,1\r\nbeta,2';
		const rows = parseCSV(csv);
		expect(rows).toHaveLength(2);
		expect(rows[0]).toEqual({ name: 'alpha', value: '1' });
	});

	it('empty rows are skipped', () => {
		const csv = 'name,value\nalpha,1\n\nbeta,2\n';
		const rows = parseCSV(csv);
		expect(rows).toHaveLength(2);
	});

	it('missing values filled as empty string', () => {
		const csv = 'a,b,c\n1,2';
		const rows = parseCSV(csv);
		expect(rows[0]).toEqual({ a: '1', b: '2', c: '' });
	});

	it('empty input returns empty array', () => {
		expect(parseCSV('')).toEqual([]);
	});

	it('header only with no data rows returns empty array', () => {
		expect(parseCSV('name,value')).toEqual([]);
	});

	it('trailing newline handled', () => {
		const csv = 'name,value\nalpha,1\n';
		const rows = parseCSV(csv);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toEqual({ name: 'alpha', value: '1' });
	});

	it('tab-separated data parsed correctly', () => {
		const csv = 'name\tvalue\nalpha\t1';
		const rows = parseCSV(csv);
		expect(rows[0]).toEqual({ name: 'alpha', value: '1' });
	});
});
