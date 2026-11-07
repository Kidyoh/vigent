/** "Did you mean ...?" for typos in action and theme names. */

function distance(a: string, b: string): number {
	const dp = Array.from({ length: b.length + 1 }, (_, i) => i);
	for (let i = 1; i <= a.length; i++) {
		let prev = dp[0];
		dp[0] = i;
		for (let j = 1; j <= b.length; j++) {
			const tmp = dp[j];
			dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
			prev = tmp;
		}
	}
	return dp[b.length];
}

/** The closest candidate within a few edits, or undefined. */
export function closest(name: string, candidates: Iterable<string>): string | undefined {
	let best: string | undefined;
	let bestScore = Math.max(2, Math.floor(name.length / 3)) + 1;
	for (const c of candidates) {
		const d = distance(name.toLowerCase(), c.toLowerCase());
		if (d < bestScore) {
			best = c;
			bestScore = d;
		}
	}
	return best;
}

export function didYouMean(name: string, candidates: Iterable<string>): string {
	const c = closest(name, candidates);
	return c ? ` (did you mean '${c}'?)` : "";
}
