"use strict";

// Conservative structural analyzer for the Firebase Storage Rules subset used here. It tokenizes
// comments/strings/operators, balances every block/call, discovers every Career read allow, then
// recursively follows statically-resolved helper and lookup aliases. Anything it cannot resolve
// throws: callers must treat an analysis error as a failed release guard.

const LOOKUPS = new Set(["get", "exists", "getAfter"]);
const SAFE_MEMBER_CALLS = new Set([
  "affectedKeys", "addedKeys", "changedKeys", "diff", "hasAll", "hasAny", "hasOnly",
  "keys", "lower", "matches", "removedKeys", "size",
]);

class RulesAnalysisError extends Error {}

function tokenize(source) {
  const tokens = [];
  let i = 0;
  while (i < source.length) {
    const c = source[i];
    if (/\s/.test(c)) { i++; continue; }
    if (c === "/" && source[i + 1] === "/") {
      i += 2; while (i < source.length && source[i] !== "\n") i++; continue;
    }
    if (c === "/" && source[i + 1] === "*") {
      const end = source.indexOf("*/", i + 2);
      if (end < 0) throw new RulesAnalysisError("Unclosed block comment");
      i = end + 2; continue;
    }
    if (c === "'" || c === '"') {
      const quote = c; let value = c; i++;
      let closed = false;
      while (i < source.length) {
        const next = source[i++]; value += next;
        if (next === "\\") {
          if (i >= source.length) throw new RulesAnalysisError("Invalid string escape");
          value += source[i++];
        } else if (next === quote) { closed = true; break; }
      }
      if (!closed) throw new RulesAnalysisError("Unclosed string literal");
      tokens.push({ type: "string", value }); continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let value = c; i++;
      while (i < source.length && /[A-Za-z0-9_]/.test(source[i])) value += source[i++];
      tokens.push({ type: "identifier", value }); continue;
    }
    if (/[0-9]/.test(c)) {
      let value = c; i++;
      while (i < source.length && /[0-9.]/.test(source[i])) value += source[i++];
      tokens.push({ type: "number", value }); continue;
    }
    const pair = source.slice(i, i + 2);
    if (["==", "!=", "<=", ">=", "&&", "||"].includes(pair)) {
      tokens.push({ type: "symbol", value: pair }); i += 2; continue;
    }
    if (!"/{}()[];:,.>$=*-+!<>?".includes(c)) {
      throw new RulesAnalysisError(`Unknown token ${c}`);
    }
    tokens.push({ type: "symbol", value: c }); i++;
  }
  return tokens;
}

function matching(tokens, openIndex, open = "(", close = ")") {
  if (tokens[openIndex]?.value !== open) throw new RulesAnalysisError(`Expected ${open}`);
  let depth = 0;
  for (let i = openIndex; i < tokens.length; i++) {
    if (tokens[i].value === open) depth++;
    else if (tokens[i].value === close && --depth === 0) return i;
  }
  throw new RulesAnalysisError(`Unclosed ${open}`);
}

function parseFunctions(tokens) {
  const functions = new Map();
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i].value !== "function") continue;
    const name = tokens[i + 1];
    if (name?.type !== "identifier" || tokens[i + 2]?.value !== "(") {
      throw new RulesAnalysisError("Malformed function declaration");
    }
    const paramsEnd = matching(tokens, i + 2);
    if (tokens[paramsEnd + 1]?.value !== "{") throw new RulesAnalysisError(`Missing body for ${name.value}`);
    const bodyEnd = matching(tokens, paramsEnd + 1, "{", "}");
    if (functions.has(name.value)) throw new RulesAnalysisError(`Duplicate function ${name.value}`);
    functions.set(name.value, tokens.slice(paramsEnd + 2, bodyEnd));
    i = bodyEnd;
  }
  return functions;
}

function parseCareerReadExpressions(tokens) {
  const expressions = [];
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i].value !== "match") continue;
    let open = i + 1;
    while (open < tokens.length) {
      if (tokens[open].value === "{" && tokens[open - 1]?.value !== "/") break;
      if (tokens[open].value === "{" && tokens[open - 1]?.value === "/") {
        open = matching(tokens, open, "{", "}") + 1;
      } else open++;
    }
    if (open >= tokens.length) throw new RulesAnalysisError("Malformed match block");
    const matchPath = tokens.slice(i + 1, open).map((token) => token.value).join("");
    const close = matching(tokens, open, "{", "}");
    const isCareerMatch = matchPath.startsWith("/career/{");
    // A root wildcard/catch-all or service-root allow could also authorize Career objects without
    // spelling out /career. Treat it as overlapping and fail rather than silently omitting it.
    const couldImplicitlyMatchCareer = matchPath.startsWith("/{") || matchPath === "/b/{bucket}/o";
    if (isCareerMatch || couldImplicitlyMatchCareer) {
      let depth = 1;
      for (let j = open + 1; j < close; j++) {
        if (depth === 1 && tokens[j].value === "match" && isCareerMatch) {
          throw new RulesAnalysisError(`Nested Career match syntax is unsupported: ${matchPath}`);
        }
        if (tokens[j].value === "{") depth++;
        else if (tokens[j].value === "}") depth--;
        if (depth !== 1 || tokens[j].value !== "allow") continue;
        let colon = j + 1;
        while (colon < close && tokens[colon].value !== ":") colon++;
        if (colon >= close) throw new RulesAnalysisError(`Malformed allow in ${matchPath}`);
        const methods = tokens.slice(j + 1, colon).filter((token) => token.type === "identifier").map((token) => token.value);
        let semicolon = colon + 1; let parenDepth = 0; let bracketDepth = 0;
        for (; semicolon < close; semicolon++) {
          const value = tokens[semicolon].value;
          if (value === "(") parenDepth++; else if (value === ")") parenDepth--;
          else if (value === "[") bracketDepth++; else if (value === "]") bracketDepth--;
          if (parenDepth < 0 || bracketDepth < 0) throw new RulesAnalysisError("Unbalanced allow expression");
          if (value === ";" && parenDepth === 0 && bracketDepth === 0) break;
        }
        if (semicolon >= close) throw new RulesAnalysisError(`Unterminated allow in ${matchPath}`);
        if (methods.some((method) => ["read", "get", "list"].includes(method))) {
          if (tokens[colon + 1]?.value !== "if") throw new RulesAnalysisError(`Unknown allow syntax in ${matchPath}`);
          if (!isCareerMatch) {
            throw new RulesAnalysisError(`Ambiguous read may authorize Career objects: ${matchPath}`);
          }
          expressions.push({ matchPath, tokens: tokens.slice(colon + 2, semicolon) });
        }
        j = semicolon;
      }
    }
    if (isCareerMatch) i = close;
  }
  if (!expressions.length) throw new RulesAnalysisError("No Career read allow expressions found");
  return expressions;
}

function aliasesFor(tokens, functions) {
  const aliases = new Map();
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i].value !== "let" || tokens[i + 1]?.type !== "identifier" || tokens[i + 2]?.value !== "=") continue;
    const alias = tokens[i + 1].value;
    if (tokens[i + 3]?.value === "firestore" && tokens[i + 4]?.value === "." && LOOKUPS.has(tokens[i + 5]?.value)) {
      aliases.set(alias, { type: "lookup", name: tokens[i + 5].value });
    } else if (tokens[i + 3]?.value === "firestore") {
      aliases.set(alias, { type: "firestore" });
    } else if (functions.has(tokens[i + 3]?.value)) {
      aliases.set(alias, { type: "helper", name: tokens[i + 3].value });
    } else {
      throw new RulesAnalysisError(`Unresolvable alias ${alias}`);
    }
  }
  return aliases;
}

function lookupPath(tokens, openIndex) {
  const close = matching(tokens, openIndex);
  const arg = tokens.slice(openIndex + 1, close);
  if (!arg.length || arg.some((token) => token.type === "string" || [",", ";", "{", "}", "[", "]"].includes(token.value))) {
    throw new RulesAnalysisError("Lookup path is not one statically provable Rules path");
  }
  const path = arg.map((token) => token.value).join("");
  if (!path.startsWith("/databases/") || !path.includes("/documents/")) {
    throw new RulesAnalysisError(`Unrecognized lookup path template: ${path}`);
  }
  return { path, close };
}

function analyzeCareerStorageLookups(source) {
  const tokens = tokenize(source);
  const functions = parseFunctions(tokens);
  const roots = parseCareerReadExpressions(tokens);
  const lookups = new Set();
  const visited = new Set();

  function analyze(tokensToAnalyze, label) {
    const aliases = aliasesFor(tokensToAnalyze, functions);
    for (let i = 0; i < tokensToAnalyze.length; i++) {
      const token = tokensToAnalyze[i];
      if (token.type !== "identifier") continue;
      const next = tokensToAnalyze[i + 1]?.value;
      const member = tokensToAnalyze[i + 2]?.value;
      const callOpen = tokensToAnalyze[i + 3]?.value;
      if ((token.value === "firestore" || aliases.get(token.value)?.type === "firestore")
          && next === "." && LOOKUPS.has(member) && callOpen === "(") {
        const parsed = lookupPath(tokensToAnalyze, i + 3); lookups.add(parsed.path); i = parsed.close; continue;
      }
      if (next === "." && callOpen === "(") {
        if (!SAFE_MEMBER_CALLS.has(member)) throw new RulesAnalysisError(`Unknown member call ${token.value}.${member} in ${label}`);
        continue;
      }
      if (tokensToAnalyze[i - 1]?.value === ".") continue;
      if (next !== "(") continue;
      const alias = aliases.get(token.value);
      if (alias?.type === "lookup") {
        const parsed = lookupPath(tokensToAnalyze, i + 1); lookups.add(parsed.path); i = parsed.close; continue;
      }
      const helperName = alias?.type === "helper" ? alias.name : token.value;
      if (functions.has(helperName)) {
        if (!visited.has(helperName)) {
          visited.add(helperName);
          analyze(functions.get(helperName), `function ${helperName}`);
        }
        continue;
      }
      throw new RulesAnalysisError(`Unresolved call ${token.value}() in ${label}`);
    }
  }

  roots.forEach((root, index) => analyze(root.tokens, `Career allow #${index + 1} ${root.matchPath}`));
  if (lookups.size > 2) throw new RulesAnalysisError(`Career read closure uses ${lookups.size} document templates`);
  return {
    lookupTemplates: [...lookups].sort(),
    careerReadExpressions: roots.map((root) => root.matchPath),
    reachableFunctions: [...visited].sort(),
  };
}

module.exports = { analyzeCareerStorageLookups, RulesAnalysisError, tokenize };
