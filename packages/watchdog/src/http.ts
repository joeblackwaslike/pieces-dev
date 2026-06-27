/** A minimal HTTP response shape — just what the watchdog inspects. */
export interface HttpResponse {
	status: number;
	body: string;
}

export type HttpGet = (url: string) => Promise<HttpResponse>;
export type HttpPost = (url: string) => Promise<HttpResponse>;

/** Real `fetch`-backed GET. Injected so the engine stays unit-testable. */
export const httpGet: HttpGet = async (url) => {
	const res = await fetch(url);
	return { status: res.status, body: await res.text() };
};

/** Real `fetch`-backed POST (no body — Pieces' `/os/restart` takes none). */
export const httpPost: HttpPost = async (url) => {
	const res = await fetch(url, { method: 'POST' });
	return { status: res.status, body: await res.text() };
};
