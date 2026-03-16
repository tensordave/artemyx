import type { Highlighter } from 'shiki';
import { getSingletonHighlighter } from 'shiki';

let highlighterPromise: Promise<Highlighter> | null = null;
let highlighterInstance: Highlighter | null = null;

export function getHighlighter(): Promise<Highlighter> {
	if (highlighterInstance) return Promise.resolve(highlighterInstance);
	if (!highlighterPromise) {
		highlighterPromise = getSingletonHighlighter({
			themes: ['github-dark'],
			langs: ['yaml'],
		}).then((hl) => {
			highlighterInstance = hl;
			return hl;
		});
	}
	return highlighterPromise;
}

export function highlightSync(yaml: string): string | null {
	if (!highlighterInstance) return null;
	return highlighterInstance.codeToHtml(yaml, { lang: 'yaml', theme: 'github-dark' });
}

export async function highlightAsync(yaml: string): Promise<string> {
	const hl = await getHighlighter();
	return hl.codeToHtml(yaml, { lang: 'yaml', theme: 'github-dark' });
}
