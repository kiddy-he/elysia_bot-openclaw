import { parse } from "acorn";

// QQ returns JavaScript object literals (including undefined), even for format=json.
// Read their data through the syntax tree; never evaluate server-supplied code.
function readLiteral(node, depth = 0) {
  if (!node || depth > 100) throw new Error("Unsupported response structure");
  switch (node.type) {
    case "Literal":
      if (node.value === null || ["string", "boolean"].includes(typeof node.value)) return node.value;
      if (typeof node.value === "number" && Number.isFinite(node.value)) return node.value;
      break;
    case "Identifier":
      if (node.name === "undefined") return null;
      break;
    case "UnaryExpression": {
      if (!["+", "-"].includes(node.operator)) break;
      const value = readLiteral(node.argument, depth + 1);
      if (typeof value === "number") return node.operator === "-" ? -value : value;
      break;
    }
    case "ArrayExpression":
      return node.elements.map((item) => item === null ? null : readLiteral(item, depth + 1));
    case "ObjectExpression":
      return Object.fromEntries(node.properties.map((property) => {
        if (property.type !== "Property" || property.computed || property.method || property.kind !== "init") {
          throw new Error("Unsupported response property");
        }
        const key = property.key.type === "Identifier" ? property.key.name : readLiteral(property.key, depth + 1);
        if (!["string", "number"].includes(typeof key)) throw new Error("Unsupported response key");
        return [String(key), readLiteral(property.value, depth + 1)];
      }));
  }
  throw new Error(`Unsupported response value: ${node.type}`);
}

export function parseQzoneResponse(text, operation = "Qzone") {
  let source = text.replace(/^\uFEFF/, "").trim();
  // Strip only a single JSONP wrapper. Its callback is never invoked.
  const callback = source.match(/^(?:[A-Za-z_$][\w$]*\.)*[A-Za-z_$][\w$]*\s*\(\s*([\s\S]*)\s*\)\s*;?$/);
  if (callback) source = callback[1];
  source = source.replace(/;\s*$/, "");
  let data;
  try {
    try {
      data = JSON.parse(source);
    } catch {
      const ast = parse(`(${source}\n)`, { ecmaVersion: "latest" });
      if (ast.body.length !== 1 || ast.body[0].type !== "ExpressionStatement") throw new Error("Expected one value");
      data = readLiteral(ast.body[0].expression);
    }
  } catch {
    // Do not include response bodies, cookie values or URLs in parse errors.
    throw new Error(`${operation}: unsupported or invalid response data`);
  }
  const resultCode = data && typeof data === "object" ? (Object.hasOwn(data, "code") ? data.code : operation === "upload" ? data.ret : undefined) : undefined;
  if (!data || typeof data !== "object" || Array.isArray(data) ||
      !["number", "string"].includes(typeof resultCode) || !/^-?\d+$/.test(String(resultCode))) {
    throw new Error(`${operation}: missing or invalid Qzone result code`);
  }
  if (Number(resultCode) !== 0) {
    throw new Error(`${operation}: Qzone returned code ${resultCode}${data.subcode !== undefined && /^-?\d+$/.test(String(data.subcode)) ? ` (subcode ${data.subcode})` : ""}`);
  }
  return data;
}

export async function readQzoneResponse(response, operation) {
  if (!response.ok) throw new Error(`${operation}: HTTP ${response.status}`);
  return parseQzoneResponse(await response.text(), operation);
}
