/**
 * Splits a stream into lines as chunks arrive. A pending line's chunks are
 * kept in a list and joined once, when its newline comes: growing one string
 * and searching it again on every chunk is quadratic, and a CLI's event line
 * can be megabytes (a tool's whole output), which froze the screen for seconds.
 */
export class LineSplitter {
	private parts: string[] = [];

	/** The lines this chunk completes, without their "\n". */
	push(chunk: string): string[] {
		const out: string[] = [];
		let start = 0;
		for (let nl = chunk.indexOf("\n"); nl !== -1; nl = chunk.indexOf("\n", start)) {
			const piece = chunk.slice(start, nl);
			if (this.parts.length) {
				this.parts.push(piece);
				out.push(this.parts.join(""));
				this.parts = [];
			} else out.push(piece);
			start = nl + 1;
		}
		if (start < chunk.length) this.parts.push(start ? chunk.slice(start) : chunk);
		return out;
	}

	/** What came after the last newline (the stream ended without one), and forget it. */
	rest(): string {
		const r = this.parts.join("");
		this.parts = [];
		return r;
	}
}
