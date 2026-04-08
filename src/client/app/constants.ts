import type { BookmarkCategory } from './types';

// Color palette for N VFOs
export const VFO_COLORS = [
	'#ff4444', '#4488ff', '#44cc44', '#ff44ff',
	'#ffaa44', '#44cccc', '#cccc44', '#ff8844',
];

export const makeDefaultVfo = (freq = 100.0) => ({
	enabled: false,
	freq: freq,
	mode: 'wfm',
	bandwidth: 150000,
	snapInterval: 100000,
	deEmphasis: '50us',
	squelchEnabled: false,
	squelchLevel: -100.0,
	noiseReduction: false,
	stereo: false,
	lowPass: true,
	highPass: false,
	rds: false,
	rdsRegion: 'eu',
	volume: 50,
	pocsag: false,
	displayFreq: freq.toFixed(6).padStart(10, '0'),
	focused: false,
});

// Bookmark categories
export const BOOKMARK_CATEGORIES: BookmarkCategory[] = [
	{ value: '', label: 'Uncategorised' },
	{ value: 'marine', label: 'Marine' },
	{ value: 'aviation', label: 'Aviation' },
	{ value: 'fire', label: 'Fire' },
	{ value: 'ambulance', label: 'Ambulance / EMS' },
	{ value: 'police', label: 'Police' },
	{ value: 'emergency', label: 'Emergency Services (Mixed)' },
	{ value: 'pocsag', label: 'POCSAG' },
	{ value: 'amateur', label: 'Amateur Radio' },
	{ value: 'weather', label: 'Weather' },
	{ value: 'military', label: 'Military' },
	{ value: 'radio', label: 'Broadcast Radio' },
	{ value: 'utility', label: 'Utility' },
	{ value: 'mixed', label: 'Mixed / Multiple' },
	{ value: 'other', label: 'Other' },
];

// SDR++ mode defaults
export const MODE_DEFAULTS: Record<string, { bandwidth: number; snapInterval: number; deEmphasis: string; lowPass: boolean }> = {
	wfm: { bandwidth: 150000, snapInterval: 100000, deEmphasis: '50us', lowPass: true },
	nfm: { bandwidth: 12500, snapInterval: 2500, deEmphasis: 'none', lowPass: true },
	am: { bandwidth: 10000, snapInterval: 1000, deEmphasis: 'none', lowPass: false },
	usb: { bandwidth: 2800, snapInterval: 100, deEmphasis: 'none', lowPass: false },
	lsb: { bandwidth: 2800, snapInterval: 100, deEmphasis: 'none', lowPass: false },
	dsb: { bandwidth: 4600, snapInterval: 100, deEmphasis: 'none', lowPass: false },
	cw: { bandwidth: 200, snapInterval: 10, deEmphasis: 'none', lowPass: false },
	raw: { bandwidth: 48000, snapInterval: 2500, deEmphasis: 'none', lowPass: false },
	dsd: { bandwidth: 12500, snapInterval: 2500, deEmphasis: 'none', lowPass: false },
};
