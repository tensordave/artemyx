import { codeToHtml } from 'shiki';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Read a YAML config from public/ and return Shiki-highlighted HTML.
 * Runs at build time in Astro frontmatter.
 */
export async function highlightConfigYaml(publicPath: string): Promise<string> {
	const resolved = path.join(process.cwd(), 'public', publicPath);
	const yaml = fs.readFileSync(resolved, 'utf-8');
	return codeToHtml(yaml, { lang: 'yaml', theme: 'github-dark' });
}
