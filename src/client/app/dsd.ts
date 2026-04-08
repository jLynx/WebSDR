/*
 * DSD (Digital Speech Decoder) UI methods for the Vue app.
 */

import type { AppInstance } from './types';

export const dsdMethods = {
	_onDsdStatus(this: AppInstance, vfoIndex: number, status: any) {
		if (!this.dsdStatus) this.dsdStatus = [];
		this.dsdStatus[vfoIndex] = status;
	},
};
