/* eslint-disable */
/**
 * Dependency-Injection Bridge
 * ===========================
 * Maps a service module back to the routes that call it.
 *
 * This exists because the import graph cannot answer that question. Routers never import a
 * service: they reach it through `server.services.<key>`, wired once in
 * src/server/routes/index.ts. A reverse-import walk from secret-service.ts therefore reaches
 * exactly one router file (routes/index.ts itself, the wiring), which is useless for impact
 * analysis. The wiring block is the missing edge, and it is fully static:
 *
 *     import { secretServiceFactory } from "@app/services/secret/secret-service";  // 3. module
 *     const secretService = secretServiceFactory({ ... });                         // 2. factory
 *     server.decorate<...>("services", { secret: secretService, ... });            // 1. key
 *
 * Following those three hops backwards turns `src/services/secret/anything.ts` into the service
 * key `secret`, which is exactly the prefix that appears in a signature's `service_calls`
 * ("secret.createSecret"). Matching is done on the module's DIRECTORY, so a change to
 * secret-dal.ts or secret-fns.ts resolves the same as a change to secret-service.ts.
 *
 * Resolution is not expected to be total. A key whose factory is built inline, or imported
 * through a barrel, is reported in `unresolved` rather than silently dropped - an unresolved key
 * means routes that call it will be missed, and that is worth printing.
 */

import { existsSync, statSync } from "node:fs";
import { readFileSync } from "node:fs";
import path from "node:path";

import ts from "typescript";

import { BACKEND_ROOT } from "./signature-builder";

export const ROUTES_INDEX = "src/server/routes/index.ts";

export interface ServiceBinding {
  key: string;
  factory: string;
  moduleFile: string;
  moduleDir: string;
}

export interface DiBridge {
  byKey: Map<string, ServiceBinding>;
  byDirectory: Map<string, string[]>;
  unresolved: { key: string; variable: string }[];
  keysForFile: (file: string) => string[];
}

// Probes the filesystem, unlike resolveSpecifier in ./signature-builder.ts, which must stay
// checkout-free so it can sign an arbitrary git revision. This bridge only ever reads the working
// tree's routes/index.ts, so probing is free here - and necessary: "@app/services/signer-membership"
// is a directory barrel, and treating it as a file would put its module directory at
// src/services, which then swallows every service module that has no closer match.
const specifierToBackendPath = (specifier: string, backendRoot: string): string | null => {
  if (!specifier.startsWith("@app/")) return null;

  const stem = `src/${specifier.slice("@app/".length)}`;
  if (existsSync(path.join(backendRoot, `${stem}.ts`))) return `${stem}.ts`;

  const asDirectory = path.join(backendRoot, stem);
  if (existsSync(asDirectory) && statSync(asDirectory).isDirectory()) return `${stem}/index.ts`;

  return `${stem}.ts`;
};

// Never walk above a module root: src/services and src/ee/services hold many unrelated modules,
// so a match there would attribute a change to whichever handful of factories happen to be
// imported from that level. Mirrors the depth moduleKeyOfPath uses in ./signature-builder.ts.
const moduleRootDepth = (file: string): number => {
  const segments = file.replace(/^src\//, "").split("/").filter(Boolean);
  return (segments[0] === "ee" || segments[0] === "server" ? 3 : 2) + 1;
};

const propertyName = (property: ts.ObjectLiteralElementLike): string | null => {
  if (!property.name) return null;
  if (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) return property.name.text;
  return null;
};

// The variable a factory call was assigned to, for `const x = f(...)` and `const x = await f(...)`.
const factoryOfInitializer = (initializer: ts.Expression | undefined): string | null => {
  let expression = initializer;
  if (expression && ts.isAwaitExpression(expression)) expression = expression.expression;
  if (!expression || !ts.isCallExpression(expression)) return null;
  if (ts.isIdentifier(expression.expression)) return expression.expression.text;
  if (ts.isPropertyAccessExpression(expression.expression)) return expression.expression.name.text;
  return null;
};

export const loadDiBridge = (backendRoot: string = BACKEND_ROOT): DiBridge => {
  const absolute = path.join(backendRoot, ROUTES_INDEX);
  const source = ts.createSourceFile(
    ROUTES_INDEX,
    readFileSync(absolute, "utf-8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  );

  const moduleOfBinding = new Map<string, string>();
  const factoryOfVariable = new Map<string, string>();
  let decorated: ts.ObjectLiteralExpression | null = null;

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const specifier = node.moduleSpecifier.text;
      const bindings = node.importClause?.namedBindings;
      if (bindings && ts.isNamedImports(bindings)) {
        for (const element of bindings.elements) moduleOfBinding.set(element.name.text, specifier);
      }
    }

    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      const factory = factoryOfInitializer(node.initializer);
      if (factory) factoryOfVariable.set(node.name.text, factory);
    }

    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "decorate" &&
      node.arguments.length === 2 &&
      ts.isStringLiteral(node.arguments[0]) &&
      node.arguments[0].text === "services" &&
      ts.isObjectLiteralExpression(node.arguments[1])
    ) {
      decorated = node.arguments[1];
    }

    ts.forEachChild(node, visit);
  };
  visit(source);

  const byKey = new Map<string, ServiceBinding>();
  const byDirectory = new Map<string, string[]>();
  const unresolved: { key: string; variable: string }[] = [];

  for (const property of (decorated as ts.ObjectLiteralExpression | null)?.properties ?? []) {
    let key: string | null = null;
    let variable: string | null = null;

    if (ts.isShorthandPropertyAssignment(property)) {
      key = property.name.text;
      variable = property.name.text;
    } else if (ts.isPropertyAssignment(property) && ts.isIdentifier(property.initializer)) {
      key = propertyName(property);
      variable = property.initializer.text;
    }
    if (!key || !variable) continue;

    const factory = factoryOfVariable.get(variable);
    const specifier = factory ? moduleOfBinding.get(factory) : undefined;
    const moduleFile = specifier ? specifierToBackendPath(specifier, backendRoot) : null;

    if (!factory || !moduleFile) {
      unresolved.push({ key, variable });
      continue;
    }

    const moduleDir = path.posix.dirname(moduleFile);
    byKey.set(key, { key, factory, moduleFile, moduleDir });

    const bucket = byDirectory.get(moduleDir);
    if (bucket) bucket.push(key);
    else byDirectory.set(moduleDir, [key]);
  }

  for (const keys of byDirectory.values()) keys.sort();

  // Directory match, so every file in a service module (dal, fns, types, queue) resolves to the
  // same key as its service file. Walks up for nested sub-directories such as
  // src/services/alert/providers, but stops at the module root.
  const keysForFile = (file: string): string[] => {
    const floor = moduleRootDepth(file);
    let dir = path.posix.dirname(file);
    while (dir && dir !== "." && dir !== "/" && dir.split("/").length >= floor) {
      const keys = byDirectory.get(dir);
      if (keys) return keys;
      dir = path.posix.dirname(dir);
    }
    return [];
  };

  return { byKey, byDirectory, unresolved, keysForFile };
};
