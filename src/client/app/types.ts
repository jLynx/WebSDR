export interface Vfo {
	enabled: boolean;
	freq: number;
	mode: string;
	bandwidth: number;
	snapInterval: number;
	deEmphasis: string;
	squelchEnabled: boolean;
	squelchLevel: number;
	noiseReduction: boolean;
	stereo: boolean;
	lowPass: boolean;
	highPass: boolean;
	rds: boolean;
	rdsRegion: string;
	volume: number;
	pocsag: boolean;
	displayFreq: string;
	focused: boolean;
}

export interface RadioState {
	centerFreq: number;
	sampleRate: number;
	fftSize: number;
}

export interface DisplayState {
	minDB: number;
	maxDB: number;
}

export type GainState = Record<string, number>;

export type LockState = Record<string, boolean>;

export interface WhisperState {
	panelOpen: boolean;
	active: boolean;
	status: string;
	loadProgress: number;
	loadPhase: string;
	loadFile: string;
	loadFilesDone: number;
	loadFilesTotal: number;
	model: string;
	chunkSeconds: number;
	log: Array<{ time: string; freq: string; text: string; duration: string; transcribeTime?: string; vfoIndex?: number | null }>;
	statusMsg: string;
	recording: boolean;
	transcribing: boolean;
	recordStart: Date | null;
	recordDuration: number;
	pendingChunks: number;
}

export interface PocsagState {
	panelOpen: boolean;
	log: Array<{ time: string; freq: string; vfoIndex: number; capcode: string; type: string; text: string; baud: number }>;
}

export interface ViewState {
	zoomScale: number;
	zoomOffset: number;
	locked: boolean;
}

export interface BookmarkModal {
	show: boolean;
	type: string;
	name: string;
	category: string;
}

export interface BookmarkImportModal {
	show: boolean;
}

export interface BookmarkEdit {
	show: boolean;
	index: number;
	type: string;
	name: string;
	category: string;
	freq: number;
	mode: string;
	bandwidth: number;
	snapInterval: number;
	deEmphasis: string;
	squelchEnabled: boolean;
	squelchLevel: number;
	noiseReduction: boolean;
	stereo: boolean;
	lowPass: boolean;
	highPass: boolean;
	rds: boolean;
	rdsRegion: string;
	volume: number;
	centerFreq: number;
	sampleRate: number;
	vfos: Vfo[];
	activeVfoIndex: number;
}

export interface Snackbar {
	show: boolean;
	message: string;
}

export interface BookmarkCategory {
	value: string;
	label: string;
}

export interface Bookmark {
	type: string;
	name: string;
	category: string;
	id?: string;
	freq?: number;
	mode?: string;
	bandwidth?: number;
	snapInterval?: number;
	deEmphasis?: string;
	squelchEnabled?: boolean;
	squelchLevel?: number;
	noiseReduction?: boolean;
	stereo?: boolean;
	lowPass?: boolean;
	highPass?: boolean;
	rds?: boolean;
	rdsRegion?: string;
	volume?: number;
	// group fields
	centerFreq?: number;
	sampleRate?: number;
	vfos?: Vfo[];
	activeVfoIndex?: number;
}

export interface VfoConflictDialog {
	show: boolean;
	vfoIndex: number;
	requestedFreq: number;
	previousFreq: number;
	optionA: { centerFreq: number; description: string } | null;
	optionB: { centerFreq: number; description: string; excludedVfos: number[] } | null;
}

// Use `any` for the full AppInstance type since it's complex with Vue internals
export type AppInstance = any;
