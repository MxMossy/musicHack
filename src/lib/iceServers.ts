const METERED_APP = import.meta.env.VITE_METERED_APP;
const METERED_KEY = import.meta.env.VITE_METERED_KEY;

export async function getIceServers(): Promise<RTCIceServer[]> {
	if (!METERED_APP || !METERED_KEY) return [];
	try {
		const res = await fetch(
			`https://${METERED_APP}.metered.live/api/v1/turn/credentials?apiKey=${METERED_KEY}`
		);
		if (!res.ok) return [];
		return await res.json();
	} catch {
		return [];
	}
}
