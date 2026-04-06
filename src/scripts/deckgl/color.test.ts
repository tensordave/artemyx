import { describe, it, expect } from 'vitest';
import { hexToRGBA, rgbaToHex, buildDeckColorProps } from './color';

describe('hexToRGBA', () => {
	it('converts #RRGGBB to RGBA with full opacity', () => {
		expect(hexToRGBA('#ff0000')).toEqual([255, 0, 0, 255]);
		expect(hexToRGBA('#00ff00')).toEqual([0, 255, 0, 255]);
		expect(hexToRGBA('#0000ff')).toEqual([0, 0, 255, 255]);
	});

	it('converts shorthand #RGB', () => {
		expect(hexToRGBA('#f00')).toEqual([255, 0, 0, 255]);
		expect(hexToRGBA('#0f0')).toEqual([0, 255, 0, 255]);
	});

	it('converts #RRGGBBAA', () => {
		expect(hexToRGBA('#ff000080')).toEqual([255, 0, 0, 128]);
	});

	it('applies alpha override', () => {
		expect(hexToRGBA('#ff0000', 51)).toEqual([255, 0, 0, 51]);
	});

	it('alpha override takes precedence over inline alpha', () => {
		expect(hexToRGBA('#ff000080', 200)).toEqual([255, 0, 0, 200]);
	});

	it('works without # prefix', () => {
		expect(hexToRGBA('3388ff')).toEqual([51, 136, 255, 255]);
	});
});

describe('rgbaToHex', () => {
	it('converts RGBA to #RRGGBB (drops alpha)', () => {
		expect(rgbaToHex([255, 0, 0, 255])).toBe('#ff0000');
		expect(rgbaToHex([51, 136, 255, 128])).toBe('#3388ff');
	});

	it('pads single-digit hex values', () => {
		expect(rgbaToHex([0, 0, 0, 255])).toBe('#000000');
		expect(rgbaToHex([1, 2, 3, 0])).toBe('#010203');
	});
});

describe('buildDeckColorProps', () => {
	it('builds fill and line color props from hex', () => {
		const props = buildDeckColorProps('#ff0000', 0.5, 1.0);
		expect(props.getFillColor).toEqual([255, 0, 0, 128]);
		expect(props.getLineColor).toEqual([255, 0, 0, 255]);
	});

	it('uses default opacities when not specified', () => {
		const props = buildDeckColorProps('#00ff00');
		expect(props.getFillColor).toEqual([0, 255, 0, 51]);  // 0.2 * 255 = 51
		expect(props.getLineColor).toEqual([0, 255, 0, 153]); // 0.6 * 255 ≈ 153
	});
});
