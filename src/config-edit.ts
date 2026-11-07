/**
 * Edit config.toml in place for `:settings`: change one value and keep
 * everything else (comments, order, other keys) as the user wrote it.
 */

/** A TOML value: strings quoted, booleans and numbers as they are. */
export function tomlValue(v: string | number | boolean): string {
	return typeof v === "string" ? JSON.stringify(v) : String(v);
}

/** A TOML key: bare when it can be, quoted otherwise (`"<leader>n"`). */
export function tomlKey(k: string): string {
	return /^[A-Za-z0-9_-]+$/.test(k) ? k : JSON.stringify(k);
}

const header = /^\s*\[([^\][]+)\]\s*(#.*)?$/;

/**
 * Set `key = value` in `[section]` (or at the top level when section is
 * undefined). A commented-out line for the same key (`# key = …`) is replaced
 * in place, so the setting stays where the template documents it.
 */
export function setTomlValue(text: string, section: string | undefined, key: string, value: string): string {
	const lines = text.length ? text.replace(/\n$/, "").split("\n") : [];
	const line = `${tomlKey(key)} = ${value}`;
	const keyRe = new RegExp(`^(\\s*)(#\\s*)?${escape(tomlKey(key))}\\s*=`);
	// the range of lines that belong to the section
	let start = 0;
	let end = lines.findIndex((l) => header.test(l));
	if (end < 0) end = lines.length;
	if (section) {
		const at = lines.findIndex((l) => header.exec(l)?.[1].trim() === section);
		if (at < 0) {
			// a new section at the end
			const out = [...lines];
			if (out.length && out[out.length - 1].trim() !== "") out.push("");
			out.push(`[${section}]`, line);
			return `${out.join("\n")}\n`;
		}
		start = at + 1;
		end = lines.findIndex((l, i) => i >= start && header.test(l));
		if (end < 0) end = lines.length;
	}
	const live = lines.findIndex((l, i) => i >= start && i < end && keyRe.test(l) && !/^\s*#/.test(l));
	const commented = lines.findIndex((l, i) => i >= start && i < end && keyRe.test(l) && /^\s*#/.test(l));
	const out = [...lines];
	const at = live >= 0 ? live : commented;
	if (at >= 0) {
		out[at] = line;
	} else {
		// after the last non-blank line of the section
		let insert = end;
		while (insert > start && out[insert - 1].trim() === "") insert--;
		out.splice(insert, 0, line);
	}
	return `${out.join("\n")}\n`;
}

function escape(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
