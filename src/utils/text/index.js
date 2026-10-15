/** `101k`, `1.2k`, `850`. */
const kTokens = (n) => {
	if (n < 1000) {
		return String(Math.round(n));
	}
	const k = n / 1000;
	if (k < 10) {
		return k.toFixed(1).replace(/\.0$/, "") + "k";
	}
	return Math.round(k) + "k";
};

const count = (n) => n.toLocaleString("en-US");

/** A text longer than `head + tail` characters as its head and tail, with a marker between them. */
const headAndTail = (text, head, tail) => {
	if (text.length <= head + tail) {
		return text;
	}
	return text.slice(0, head) + "\n\n[… " + count(text.length - head - tail) + " characters left out …]\n\n" + text.slice(-tail);
};

/** The first line of a text, cut to `max` characters. */
const firstLine = (text, max) => {
	const line = String(text || "").trim().split("\n")[0] || "";
	return clip(line, max);
};

/** A text cut to `max` characters, with an ellipsis when cut. */
const clip = (text, max) => {
	if (text.length <= max) {
		return text;
	}
	return text.slice(0, max) + "…";
};

/** Whitespace runs as single spaces. */
const flat = (text) => String(text || "").replace(/\s+/g, " ").trim();

module.exports = {
	kTokens,
	count,
	headAndTail,
	firstLine,
	clip,
	flat
};
