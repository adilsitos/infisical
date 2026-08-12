/* eslint-disable */
/**
 * Method Index
 * ============
 * Narrows a changed service file from "this module moved" to "these exported methods moved".
 *
 * The DI bridge resolves a changed file to a service key, which is already a large win over the
 * import graph. It is still one level too coarse to review with: a one-line change inside
 * `updateByName` resolves to `server.services.dynamicSecret`, and every route calling any method
 * on that key is reported. On dynamic-secret-service.ts that is 14 routes for a change 1 of them
 * executes; on secret-service.ts it would be hundreds. A list a reviewer cannot trust is a list a
 * reviewer stops reading.
 *
 * A route's `service_calls` in .behavior-manifest.json is already recorded as `key.method`
 * ("dynamicSecret.updateByName"), so the missing half is the method a changed line belongs to.
 * This module supplies it, from the diff's line ranges and the file's text at the head revision:
 *
 *   1. every named function in the file, with its line span, innermost first
 *   2. the factory's returned object literal, which is the set of route-callable method names
 *   3. references between those functions, so a change inside a private helper resolves to the
 *      returned methods that reach it
 *
 * Narrowing is refused rather than guessed. A hunk at module scope (a constant, an enum), a hunk
 * inside the factory's own parameter list, or a helper no returned method reaches all mean the
 * change can affect any method, so the caller is told to fall back to file-level reach. Imports
 * and pure type declarations are the exception: they cannot move runtime behaviour on their own,
 * and the change that does will be in a method hunk of its own.
 *
 * Line spans come from the head revision read through `git show`, never the working tree, because
 * the analyzer runs on a checkout that does not contain an open pull request's changes and the
 * line numbers would land in the wrong function.
 */

import { execFileSync } from "node:child_process";

import ts from "typescript";

import { BACKEND_PREFIX, REPO_ROOT } from "./signature-builder";

export interface LineRange {
  start: number;
  end: number;
}

interface FunctionSpan {
  name: string;
  start: number;
  end: number;
}

export interface FactoryInfo {
  name: string;
  params: LineRange | null;
  surface: LineRange | null;
}

export interface MethodIndex {
  spans: FunctionSpan[];
  // An exported method can map to more than one local function: `getSecrets:
  // withSecretMetrics(getSecrets, ...)` links the export to both the implementation and the
  // wrapper, and a change in either one moves that method.
  exports: Map<string, string[]>;
  referencedBy: Map<string, Set<string>>;
  factories: FactoryInfo[];
  spread: boolean;
}

export const readAtRevision = (rev: string, backendRelPath: string): string | null => {
  try {
    return execFileSync("git", ["show", `${rev}:${BACKEND_PREFIX}${backendRelPath}`], {
      cwd: REPO_ROOT,
      encoding: "utf-8",
      maxBuffer: 64 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"]
    });
  } catch {
    return null;
  }
};

const functionLike = (node: ts.Node | undefined): boolean =>
  Boolean(node && (ts.isArrowFunction(node) || ts.isFunctionExpression(node)));

const exportedFactories = (source: ts.SourceFile): { name: string; fn: ts.ArrowFunction }[] => {
  const factories: { name: string; fn: ts.ArrowFunction }[] = [];
  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    if (!statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && functionLike(declaration.initializer)) {
        factories.push({ name: declaration.name.text, fn: declaration.initializer as ts.ArrowFunction });
      }
    }
  }
  return factories;
};

// The returned object literal is the callable surface. Only a return at the factory body's own
// statement level counts: a `return { url, method }` inside one of the methods would otherwise
// register its own fields as exported method names.
const returnedObject = (body: ts.Node): ts.ObjectLiteralExpression | null => {
  if (ts.isParenthesizedExpression(body) && ts.isObjectLiteralExpression(body.expression)) return body.expression;
  if (ts.isObjectLiteralExpression(body)) return body;
  if (!ts.isBlock(body)) return null;

  for (const statement of body.statements) {
    if (!ts.isReturnStatement(statement) || !statement.expression) continue;
    const expression = ts.isParenthesizedExpression(statement.expression) ? statement.expression.expression : statement.expression;
    if (ts.isObjectLiteralExpression(expression)) return expression;
  }
  return null;
};

export const buildMethodIndex = (text: string, fileName = "module.ts"): MethodIndex => {
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const lineOf = (pos: number): number => source.getLineAndCharacterOfPosition(pos).line + 1;

  const spans: FunctionSpan[] = [];
  const bodyOf = new Map<string, ts.Node>();

  const record = (name: string, node: ts.Node, body: ts.Node): void => {
    spans.push({ name, start: lineOf(node.getStart(source)), end: lineOf(node.getEnd()) });
    if (!bodyOf.has(name)) bodyOf.set(name, body);
  };

  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && functionLike(node.initializer)) {
      record(node.name.text, node, node.initializer!);
    } else if (ts.isFunctionDeclaration(node) && node.name && node.body) {
      record(node.name.text, node, node.body);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);

  const known = new Set(spans.map((span) => span.name));
  const exports = new Map<string, string[]>();
  const factories: FactoryInfo[] = [];
  let spread = false;

  const addExport = (name: string, locals: string[]): void => {
    const existing = exports.get(name);
    if (!existing) {
      exports.set(name, [...locals]);
      return;
    }
    for (const local of locals) {
      if (!existing.includes(local)) existing.push(local);
    }
  };

  const localFunctionsIn = (node: ts.Node): string[] => {
    const found: string[] = [];
    const walk = (child: ts.Node): void => {
      if (ts.isIdentifier(child) && known.has(child.text) && !found.includes(child.text)) found.push(child.text);
      ts.forEachChild(child, walk);
    };
    walk(node);
    return found;
  };

  for (const { name: factoryName, fn } of exportedFactories(source)) {
    const returned = returnedObject(fn.body);
    const parameters = fn.parameters;

    factories.push({
      name: factoryName,
      params: parameters.length
        ? { start: lineOf(parameters[0].getStart(source)), end: lineOf(parameters[parameters.length - 1].getEnd()) }
        : null,
      surface: returned ? { start: lineOf(returned.getStart(source)), end: lineOf(returned.getEnd()) } : null
    });

    if (!returned) continue;

    for (const property of returned.properties) {
      if (ts.isSpreadAssignment(property)) {
        spread = true;
        continue;
      }
      if (ts.isShorthandPropertyAssignment(property)) {
        addExport(property.name.text, [property.name.text]);
        continue;
      }
      if (!ts.isPropertyAssignment(property)) continue;

      const name = ts.isIdentifier(property.name) || ts.isStringLiteral(property.name) ? property.name.text : null;
      if (!name) continue;

      if (ts.isIdentifier(property.initializer)) {
        addExport(name, [property.initializer.text]);
      } else if (functionLike(property.initializer)) {
        record(name, property, property.initializer);
        addExport(name, [name]);
      } else {
        // A wrapped method. The wrapper call is not the implementation, so the export links to
        // every local function the expression hands it.
        const wrapped = localFunctionsIn(property.initializer);
        if (wrapped.length) addExport(name, wrapped);
      }
    }
  }

  // Identifier references, not resolved calls: a method that passes a helper by reference still
  // depends on it, and over-linking only ever widens the reported set.
  const referencedBy = new Map<string, Set<string>>();

  for (const [name, body] of bodyOf) {
    const walk = (node: ts.Node): void => {
      if (ts.isIdentifier(node) && node.text !== name && known.has(node.text)) {
        const bucket = referencedBy.get(node.text);
        if (bucket) bucket.add(name);
        else referencedBy.set(node.text, new Set([name]));
      }
      ts.forEachChild(node, walk);
    };
    walk(body);
  }

  return { spans, exports, referencedBy, factories, spread };
};

// Innermost wins: a hunk inside a callback nested in updateByName should resolve to the callback's
// own name if it has one, and its references then carry it up to updateByName.
const enclosing = (index: MethodIndex, range: LineRange): FunctionSpan | null => {
  let best: FunctionSpan | null = null;
  for (const span of index.spans) {
    if (span.end < range.start || span.start > range.end) continue;
    if (!best || span.end - span.start < best.end - best.start) best = span;
  }
  return best;
};

const exportedNamesFor = (index: MethodIndex, local: string): string[] => {
  const exported = new Set<string>();
  const seen = new Set<string>([local]);
  const queue = [local];

  const localToExported = new Map<string, string[]>();
  for (const [exportedName, localNames] of index.exports) {
    for (const localName of localNames) {
      const bucket = localToExported.get(localName);
      if (bucket) bucket.push(exportedName);
      else localToExported.set(localName, [exportedName]);
    }
  }

  while (queue.length) {
    const current = queue.shift()!;
    for (const name of localToExported.get(current) ?? []) exported.add(name);
    for (const caller of index.referencedBy.get(current) ?? []) {
      if (seen.has(caller)) continue;
      seen.add(caller);
      queue.push(caller);
    }
  }

  return [...exported].sort();
};

// ---------------------------------------------------------------------------
// Change classification
// ---------------------------------------------------------------------------

// Deliberately short. Each entry has to earn a line of a reviewer's attention, and the only one
// that moves risk is authorization, because an access decision changing is the case a signature
// gate and a route list both read as "nothing happened".
const CATEGORIES: { category: string; label: string; patterns: RegExp[] }[] = [
  {
    category: "authorization",
    label: "authorization logic changed",
    patterns: [
      /ForbiddenRequestError|PermissionBoundaryError/,
      /permission\.(can|cannot)\(|ForbiddenError\(/,
      /\b(subject|throwUnlessCan|throwIfMissing\w*Permission|assertPermission|assertResourceInScope)\s*\(/,
      /ProjectPermission\w*|OrgPermission\w*/
    ]
  },
  {
    category: "validation",
    label: "input validation or request parsing changed",
    patterns: [/BadRequestError|\bz\.[a-z]|\.safeParse\(|\.parse\(/]
  },
  {
    category: "database",
    label: "database access or transaction scope changed",
    patterns: [/\.transaction\(|\btx\b|DatabaseError|insertMany|batchInsert|updateById|deleteById|\.forUpdate\(/]
  },
  {
    category: "crypto",
    label: "encryption or key handling changed",
    patterns: [/encrypt|decrypt|\bkms\b|cipher|createHash|randomBytes/i]
  },
  {
    category: "external-call",
    label: "outbound third-party call changed",
    patterns: [/axios|safeRequest|request\.(get|post|put|patch|delete)\(|fetch\(/]
  },
  {
    category: "queue",
    label: "background job scheduling changed",
    patterns: [/queueService|cronJob\.register|\.queue\(|QueueName\./]
  },
  {
    category: "audit",
    label: "audit logging changed",
    patterns: [/auditLog|EventType\./]
  }
];

export const AUTHORIZATION_CATEGORY = "authorization";

export interface Classification {
  category: string;
  label: string;
  evidence: string;
}

const classifyLines = (lines: string[]): Classification[] => {
  const found: Classification[] = [];

  for (const { category, label, patterns } of CATEGORIES) {
    for (const line of lines) {
      if (!patterns.some((pattern) => pattern.test(line))) continue;
      const trimmed = line.trim();
      found.push({ category, label, evidence: trimmed.length > 120 ? `${trimmed.slice(0, 117)}...` : trimmed });
      break;
    }
  }

  return found;
};

// ---------------------------------------------------------------------------
// Focus
// ---------------------------------------------------------------------------

export interface FocusMethod {
  name: string;
  via: string[];
  categories: Classification[];
}

export interface ChangeFocus {
  file: string;
  narrowed: boolean;
  reason?: string;
  methods: FocusMethod[];
  categories: Classification[];
  notes: string[];
  changed_lines: number;
  // Set by ./project-analyzer.ts once the DI bridge says whether this file is the module a service
  // key is bound to. Only then is a refusal to narrow worth showing a reader.
  di_bound?: boolean;
}

const skippableAtModuleScope = (source: ts.SourceFile, range: LineRange): boolean => {
  const lineOf = (pos: number): number => source.getLineAndCharacterOfPosition(pos).line + 1;

  for (const statement of source.statements) {
    const start = lineOf(statement.getStart(source));
    const end = lineOf(statement.getEnd());
    if (end < range.start || start > range.end) continue;
    if (
      !ts.isImportDeclaration(statement) &&
      !ts.isExportDeclaration(statement) &&
      !ts.isTypeAliasDeclaration(statement) &&
      !ts.isInterfaceDeclaration(statement)
    ) {
      return false;
    }
  }
  return true;
};

export const focusChange = (file: string, text: string, ranges: LineRange[]): ChangeFocus => {
  const index = buildMethodIndex(text, file);
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const lines = text.split("\n");

  const linesIn = (range: LineRange): string[] => lines.slice(Math.max(0, range.start - 1), range.end);
  const changedLines = ranges.reduce((total, range) => total + Math.max(1, range.end - range.start + 1), 0);
  const fileCategories = classifyLines(ranges.flatMap(linesIn));

  const byMethod = new Map<string, FocusMethod>();
  const blockers: string[] = [];
  const notes = new Set<string>();

  const factoryNames = new Set(index.factories.map((factory) => factory.name));
  const within = (range: LineRange, bounds: LineRange | null): boolean =>
    Boolean(bounds && range.start >= bounds.start && range.end <= bounds.end);

  for (const range of ranges) {
    const span = enclosing(index, range);

    // Inline methods on the returned object are their own spans, so they are resolved above and
    // never reach the surface check below.
    if (!span || factoryNames.has(span.name)) {
      const inParams = index.factories.find((factory) => within(range, factory.params));
      if (inParams) {
        notes.add(`the ${inParams.name} dependency list changed`);
        continue;
      }

      const inSurface = index.factories.find((factory) => within(range, factory.surface));
      if (inSurface) {
        notes.add(`the set of methods ${inSurface.name} exposes changed`);
        continue;
      }

      if (span) {
        blockers.push(
          `a change at L${range.start} sits in the ${span.name} body but not inside any method it returns, so it can ` +
            `affect all of them`
        );
        continue;
      }
      if (!skippableAtModuleScope(source, range)) {
        blockers.push(`a change at module scope (L${range.start}) can affect every method in the file`);
      }
      continue;
    }

    const exported = exportedNamesFor(index, span.name);
    if (!exported.length) {
      blockers.push(`'${span.name}' (L${range.start}) is not reachable from any method the factory returns`);
      continue;
    }

    const categories = classifyLines(linesIn(range));
    for (const name of exported) {
      const existing = byMethod.get(name);
      const via = span.name === name ? [] : [span.name];

      if (existing) {
        for (const helper of via) if (!existing.via.includes(helper)) existing.via.push(helper);
        for (const found of categories) {
          if (!existing.categories.some((category) => category.category === found.category)) existing.categories.push(found);
        }
      } else {
        byMethod.set(name, { name, via, categories });
      }
    }
  }

  const methods = [...byMethod.values()].sort((a, b) => a.name.localeCompare(b.name));
  const base = { file, methods, categories: fileCategories, notes: [...notes], changed_lines: changedLines };

  if (blockers.length) return { ...base, narrowed: false, reason: blockers[0] };
  if (!methods.length) {
    return {
      ...base,
      narrowed: false,
      reason: index.exports.size
        ? "no changed line falls inside a method the factory returns"
        : "no exported factory with a returned object literal was found in this file"
    };
  }
  if (index.spread) {
    return {
      ...base,
      narrowed: false,
      reason: "the factory's returned object spreads another object, so its callable surface is not fully known"
    };
  }

  return { ...base, narrowed: true };
};
