const FALLBACK_JUDGEMENTS = new Set(["blocked", "clean", "replaced"]);
const REVIEW_JUDGEMENTS = new Set(["clean", "reject"]);
const MAX_OUTPUT_CHARS = 12000;
const MAX_REASON_CHARS = 300;

function sourceText(value) {
    return String(value ?? "").replace(/^\uFEFF/u, "").trim();
}

function objectStart(text) {
    return text.indexOf("{");
}

function strictParseObject(text) {
    const start = objectStart(text);
    if (start < 0)
        return null;
    const candidate = text.slice(start);
    try {
        return JSON.parse(candidate);
    }
    catch {
        const end = candidate.lastIndexOf("}");
        if (end > 0) {
            try {
                return JSON.parse(candidate.slice(0, end + 1));
            }
            catch {
                return null;
            }
        }
        return null;
    }
}

// Fallback models occasionally omit the closing quote/brace or embed raw
// newlines inside JSON strings. This repair only fixes those transport-level
// defects; malformed field values are still rejected by the normalizers below.
function repairObjectText(text) {
    const start = objectStart(text);
    if (start < 0)
        return null;
    let output = "";
    let inString = false;
    let escaped = false;
    let depth = 0;
    let opened = false;
    for (let index = start; index < text.length; index += 1) {
        const char = text[index];
        if (inString) {
            if (escaped) {
                output += char;
                escaped = false;
                continue;
            }
            if (char === "\\") {
                output += char;
                escaped = true;
                continue;
            }
            if (char === "\"") {
                inString = false;
                output += char;
                continue;
            }
            if (char === "\n") {
                output += "\\n";
                continue;
            }
            if (char === "\r") {
                output += "\\r";
                continue;
            }
            if (char === "\t") {
                output += "\\t";
                continue;
            }
            if (char.charCodeAt(0) < 0x20) {
                output += `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`;
                continue;
            }
            output += char;
            continue;
        }
        if (char === "\"") {
            inString = true;
            output += char;
            continue;
        }
        if (char === "{") {
            depth += 1;
            opened = true;
            output += char;
            continue;
        }
        if (char === "}") {
            depth -= 1;
            output += char;
            if (opened && depth === 0)
                break;
            continue;
        }
        output += char;
    }
    if (inString)
        output += "\"";
    while (depth > 0) {
        output += "}";
        depth -= 1;
    }
    return output.replace(/,\s*([}\]])/gu, "$1");
}

function repairParseObject(text) {
    const repaired = repairObjectText(text);
    if (!repaired)
        return null;
    try {
        return JSON.parse(repaired);
    }
    catch {
        return null;
    }
}

function decodeJsonishString(raw) {
    let output = "";
    for (let index = 0; index < raw.length; index += 1) {
        const char = raw[index];
        if (char !== "\\") {
            output += char;
            continue;
        }
        const next = raw[index + 1];
        if (next === "u" && /^[0-9a-fA-F]{4}$/u.test(raw.slice(index + 2, index + 6))) {
            output += String.fromCharCode(parseInt(raw.slice(index + 2, index + 6), 16));
            index += 5;
            continue;
        }
        const simple = {
            n: "\n",
            r: "\r",
            t: "\t",
            b: "\b",
            f: "\f",
            "\"": "\"",
            "\\": "\\",
            "/": "/",
        };
        if (next in simple) {
            output += simple[next];
            index += 1;
            continue;
        }
        output += next ?? "";
        index += 1;
    }
    return output;
}

function extractStringField(text, name, { preferLast = false } = {}) {
    const key = `"${name}"`;
    const keyIndex = text.indexOf(key);
    if (keyIndex < 0)
        return null;
    const colon = text.indexOf(":", keyIndex + key.length);
    if (colon < 0)
        return null;
    let index = colon + 1;
    while (index < text.length && /\s/u.test(text[index]))
        index += 1;
    if (text[index] !== "\"")
        return null;
    index += 1;
    const limit = name === "output_text" && text.lastIndexOf("}") > index
        ? text.lastIndexOf("}")
        : text.length;
    let end = -1;
    let escaped = false;
    for (let cursor = index; cursor < limit; cursor += 1) {
        const char = text[cursor];
        if (escaped) {
            escaped = false;
            continue;
        }
        if (char === "\\") {
            escaped = true;
            continue;
        }
        if (char !== "\"")
            continue;
        let next = cursor + 1;
        while (next < limit && /\s/u.test(text[next]))
            next += 1;
        if (next >= limit || text[next] === "}" || text[next] === "]" || (!preferLast && text[next] === ",")) {
            end = cursor;
            if (!preferLast)
                break;
        }
    }
    if (end < 0)
        end = limit;
    return decodeJsonishString(text.slice(index, end)).trim();
}

function looseObject(text) {
    const judgement = /"judgement"\s*:\s*"(blocked|clean|replaced|reject)"/u.exec(text)?.[1] ?? null;
    const reason = extractStringField(text, "reason");
    const outputText = extractStringField(text, "output_text", { preferLast: true });
    if (!judgement && reason === null && outputText === null)
        return null;
    return { judgement, reason, output_text: outputText };
}

function normalizeFallback(value, recovered) {
    if (!value || typeof value !== "object")
        return null;
    const judgement = typeof value.judgement === "string" ? value.judgement.trim() : "";
    if (!FALLBACK_JUDGEMENTS.has(judgement))
        return null;
    const outputText = typeof value.output_text === "string" ? value.output_text.trim() : "";
    if (judgement !== "blocked" && !outputText)
        return null;
    return {
        judgement,
        replaced: judgement === "replaced",
        reason: typeof value.reason === "string" ? value.reason.trim().slice(0, MAX_REASON_CHARS) : "",
        outputText: outputText.slice(0, MAX_OUTPUT_CHARS),
        recovered: recovered === true,
    };
}

function normalizeReview(value, recovered) {
    if (!value || typeof value !== "object")
        return null;
    const judgement = typeof value.judgement === "string" ? value.judgement.trim() : "";
    if (!REVIEW_JUDGEMENTS.has(judgement))
        return null;
    return {
        judgement,
        reason: typeof value.reason === "string" ? value.reason.trim().slice(0, MAX_REASON_CHARS) : "",
        recovered: recovered === true,
    };
}

export function parseTextFallbackDecision(value) {
    const text = sourceText(value);
    if (!text)
        return null;
    const strict = strictParseObject(text);
    if (strict) {
        const decision = normalizeFallback(strict, false);
        if (decision)
            return decision;
    }
    const repaired = repairParseObject(text);
    if (repaired) {
        const decision = normalizeFallback(repaired, true);
        if (decision)
            return decision;
    }
    return normalizeFallback(looseObject(text), true);
}

export function parseTextReviewDecision(value) {
    const text = sourceText(value);
    if (!text)
        return null;
    const strict = strictParseObject(text);
    if (strict) {
        const decision = normalizeReview(strict, false);
        if (decision)
            return decision;
    }
    const repaired = repairParseObject(text);
    if (repaired) {
        const decision = normalizeReview(repaired, true);
        if (decision)
            return decision;
    }
    const judgement = /"judgement"\s*:\s*"(clean|reject)"/u.exec(text)?.[1] ?? null;
    if (!judgement)
        return null;
    return normalizeReview({ judgement, reason: extractStringField(text, "reason") }, true);
}
