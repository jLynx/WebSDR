/**
 * Lightweight device catalog for the main thread.
 * Contains only USB VID/PID filters and display names — no driver code.
 * The worker thread uses the full driver registrations in devices/*.ts instead.
 */

export interface DeviceCatalogEntry {
	type: string;
	name: string;
	filters: USBDeviceFilter[];
}

export const DEVICE_CATALOG: DeviceCatalogEntry[] = [
	{
		type: 'hackrf',
		name: 'HackRF',
		filters: [
			{ vendorId: 0x1d50, productId: 0x604b },
			{ vendorId: 0x1d50, productId: 0x6089 },
			{ vendorId: 0x1d50, productId: 0xcc15 },
			{ vendorId: 0x1fc9, productId: 0x000c },
		],
	},
	{
		type: 'rtlsdr',
		name: 'RTL-SDR',
		filters: [
			{ vendorId: 0x0bda, productId: 0x2832 },
			{ vendorId: 0x0bda, productId: 0x2838 },
			{ vendorId: 0x0413, productId: 0x6680 },
			{ vendorId: 0x0413, productId: 0x6f0f },
			{ vendorId: 0x0458, productId: 0x707f },
			{ vendorId: 0x0ccd, productId: 0x00a9 },
			{ vendorId: 0x0ccd, productId: 0x00b3 },
			{ vendorId: 0x0ccd, productId: 0x00b4 },
			{ vendorId: 0x0ccd, productId: 0x00b5 },
			{ vendorId: 0x0ccd, productId: 0x00b7 },
			{ vendorId: 0x0ccd, productId: 0x00b8 },
			{ vendorId: 0x0ccd, productId: 0x00b9 },
			{ vendorId: 0x0ccd, productId: 0x00c0 },
			{ vendorId: 0x0ccd, productId: 0x00c6 },
			{ vendorId: 0x0ccd, productId: 0x00d3 },
			{ vendorId: 0x0ccd, productId: 0x00d7 },
			{ vendorId: 0x0ccd, productId: 0x00e0 },
			{ vendorId: 0x1554, productId: 0x5020 },
			{ vendorId: 0x15f4, productId: 0x0131 },
			{ vendorId: 0x15f4, productId: 0x0133 },
			{ vendorId: 0x185b, productId: 0x0620 },
			{ vendorId: 0x185b, productId: 0x0650 },
			{ vendorId: 0x185b, productId: 0x0680 },
			{ vendorId: 0x1b80, productId: 0xd393 },
			{ vendorId: 0x1b80, productId: 0xd394 },
			{ vendorId: 0x1b80, productId: 0xd395 },
			{ vendorId: 0x1b80, productId: 0xd397 },
			{ vendorId: 0x1b80, productId: 0xd398 },
			{ vendorId: 0x1b80, productId: 0xd39d },
			{ vendorId: 0x1b80, productId: 0xd3a4 },
			{ vendorId: 0x1b80, productId: 0xd3a8 },
			{ vendorId: 0x1b80, productId: 0xd3af },
			{ vendorId: 0x1b80, productId: 0xd3b0 },
			{ vendorId: 0x1d19, productId: 0x1101 },
			{ vendorId: 0x1d19, productId: 0x1102 },
			{ vendorId: 0x1d19, productId: 0x1103 },
			{ vendorId: 0x1d19, productId: 0x1104 },
			{ vendorId: 0x1f4d, productId: 0xa803 },
			{ vendorId: 0x1f4d, productId: 0xb803 },
			{ vendorId: 0x1f4d, productId: 0xc803 },
			{ vendorId: 0x1f4d, productId: 0xd286 },
			{ vendorId: 0x1f4d, productId: 0xd803 },
		],
	},
	{
		type: 'airspy',
		name: 'Airspy',
		filters: [{ vendorId: 0x1d50, productId: 0x60a1 }],
	},
	{
		type: 'airspyhf',
		name: 'Airspy HF+',
		filters: [{ vendorId: 0x03eb, productId: 0x800c }],
	},
	{
		type: 'limesdr',
		name: 'LimeSDR',
		filters: [
			{ vendorId: 0x04B4, productId: 0x00F1 },
			{ vendorId: 0x04B4, productId: 0x00F3 },
			{ vendorId: 0x1D50, productId: 0x6108 },
		],
	},
];

/** Get all USB filters for the browser device picker. */
export function getAllCatalogFilters(): USBDeviceFilter[] {
	return DEVICE_CATALOG.flatMap(d => d.filters);
}

/** Match a USB device to a catalog entry by VID/PID. */
export function lookupDevice(device: USBDevice): DeviceCatalogEntry | null {
	for (const entry of DEVICE_CATALOG) {
		for (const filter of entry.filters) {
			if (filter.vendorId !== undefined && filter.vendorId !== device.vendorId) continue;
			if (filter.productId !== undefined && filter.productId !== device.productId) continue;
			return entry;
		}
	}
	return null;
}
