import ts from "typescript";
import { WorkflowInputError } from "./errors.js";
import type { ParsedWorkflow, WorkflowMeta, WorkflowMetaPhase } from "./types.js";

export function parseWorkflowScript(script: string): ParsedWorkflow {
  const sourceFile = ts.createSourceFile("workflow.ts", script, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const parseDiagnostics = (sourceFile as ts.SourceFile & { parseDiagnostics?: readonly ts.Diagnostic[] }).parseDiagnostics ?? [];
  if (parseDiagnostics.length > 0) {
    const diagnostic = parseDiagnostics[0];
    const message = diagnostic ? diagnosticMessage(diagnostic) : "unknown parse error";
    throw new WorkflowInputError(`Script parse error: ${message}`);
  }

  const first = sourceFile.statements[0];
  if (!first || !ts.isVariableStatement(first) || !hasExportModifier(first)) {
    throw new WorkflowInputError(
      "`export const meta = { name, description, phases }` must be the FIRST statement in the script",
    );
  }

  const declarationList = first.declarationList;
  if ((declarationList.flags & ts.NodeFlags.Const) === 0) {
    throw new WorkflowInputError("meta export must be `export const meta = ...`");
  }
  if (declarationList.declarations.length !== 1) {
    throw new WorkflowInputError("meta export must declare only `meta`");
  }

  const declarator = declarationList.declarations[0];
  if (!declarator || !ts.isIdentifier(declarator.name) || declarator.name.text !== "meta") {
    throw new WorkflowInputError("meta export must declare `meta`");
  }
  if (!declarator.initializer) throw new WorkflowInputError("meta must have a literal value");

  const meta = evaluateLiteral(declarator.initializer, "meta");
  validateMeta(meta);

  return {
    meta,
    body: buildExecutableBody(script, sourceFile, first),
  };
}

function validateMeta(meta: unknown): asserts meta is WorkflowMeta {
  if (!meta || typeof meta !== "object") throw new WorkflowInputError("meta must be an object");
  const value = meta as WorkflowMeta;
  if (typeof value.name !== "string" || !value.name.trim()) {
    throw new WorkflowInputError("meta.name must be a non-empty string");
  }
  if (typeof value.description !== "string" || !value.description.trim()) {
    throw new WorkflowInputError("meta.description must be a non-empty string");
  }
  if (value.title !== undefined && typeof value.title !== "string") {
    throw new WorkflowInputError("meta.title must be a string");
  }
  if (value.whenToUse !== undefined && typeof value.whenToUse !== "string") {
    throw new WorkflowInputError("meta.whenToUse must be a string");
  }
  if (value.phases !== undefined) {
    if (!Array.isArray(value.phases)) throw new WorkflowInputError("meta.phases must be an array");
    for (const phase of value.phases) validateMetaPhase(phase);
  }
}

function validateMetaPhase(phase: unknown): asserts phase is WorkflowMetaPhase {
  if (!phase || typeof phase !== "object") throw new WorkflowInputError("each meta phase must be an object");
  const value = phase as WorkflowMetaPhase;
  if (typeof value.title !== "string" || !value.title.trim()) {
    throw new WorkflowInputError("each meta phase must have a title string");
  }
  if (value.detail !== undefined && typeof value.detail !== "string") {
    throw new WorkflowInputError("meta phase detail must be a string");
  }
  if (value.model !== undefined && typeof value.model !== "string") {
    throw new WorkflowInputError("meta phase model must be a string");
  }
}

function evaluateLiteral(node: ts.Expression, path: string): unknown {
  const value = unwrapExpression(node);
  if (ts.isObjectLiteralExpression(value)) {
    const out: Record<string, unknown> = {};
    for (const prop of value.properties) {
      if (ts.isSpreadAssignment(prop)) throw new WorkflowInputError(`spread not allowed in ${path}`);
      if (!ts.isPropertyAssignment(prop)) throw new WorkflowInputError(`only plain properties allowed in ${path}`);
      const key = propertyKey(prop.name, path);
      if (key === "__proto__" || key === "constructor" || key === "prototype") {
        throw new WorkflowInputError(`reserved key name not allowed in ${path}: ${key}`);
      }
      out[key] = evaluateLiteral(prop.initializer, `${path}.${key}`);
    }
    return out;
  }

  if (ts.isArrayLiteralExpression(value)) {
    return value.elements.map((element, index) => {
      if (ts.isSpreadElement(element)) throw new WorkflowInputError(`spread not allowed in ${path}`);
      return evaluateLiteral(element, `${path}[${index}]`);
    });
  }

  if (ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value)) return value.text;
  if (ts.isNumericLiteral(value)) return Number(value.text);
  if (value.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (value.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (value.kind === ts.SyntaxKind.NullKeyword) return null;

  if (ts.isPrefixUnaryExpression(value) && value.operator === ts.SyntaxKind.MinusToken) {
    const operand = unwrapExpression(value.operand);
    if (ts.isNumericLiteral(operand)) return -Number(operand.text);
  }

  throw new WorkflowInputError(`meta must be a pure literal: non-literal node type in ${path}: ${ts.SyntaxKind[value.kind]}`);
}

function propertyKey(name: ts.PropertyName, path: string): string {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text;
  if (ts.isComputedPropertyName(name)) throw new WorkflowInputError(`computed keys not allowed in ${path}`);
  throw new WorkflowInputError(`unsupported key type in ${path}: ${ts.SyntaxKind[name.kind]}`);
}

function unwrapExpression(node: ts.Expression): ts.Expression {
  let value = node;
  while (
    ts.isParenthesizedExpression(value) ||
    ts.isAsExpression(value) ||
    ts.isSatisfiesExpression(value) ||
    ts.isTypeAssertionExpression(value) ||
    ts.isNonNullExpression(value)
  ) {
    value = value.expression;
  }
  return value;
}

function buildExecutableBody(
  script: string,
  sourceFile: ts.SourceFile,
  metaStatement: ts.Statement,
): string {
  let body = script.slice(0, metaStatement.getStart(sourceFile));
  let cursor = metaStatement.end;
  let importIndex = 0;

  for (const statement of sourceFile.statements.slice(1)) {
    const start = statement.getStart(sourceFile);
    body += script.slice(cursor, start);
    body += transformTopLevelStatement(script, sourceFile, statement, importIndex);
    if (ts.isImportDeclaration(statement) && !isTypeOnlyImport(statement)) importIndex++;
    cursor = statement.end;
  }

  body += script.slice(cursor);
  return body;
}

function transformTopLevelStatement(
  script: string,
  sourceFile: ts.SourceFile,
  statement: ts.Statement,
  importIndex: number,
): string {
  if (ts.isImportDeclaration(statement)) return transformImportDeclaration(statement, importIndex);
  if (ts.isExportDeclaration(statement)) return transformExportDeclaration(statement);
  if (ts.isExportAssignment(statement)) {
    return `const __workflow_default_export = ${script.slice(statement.expression.getStart(sourceFile), statement.expression.end)};`;
  }
  if (hasExportModifier(statement)) {
    const text = script.slice(statement.getStart(sourceFile), statement.end);
    const stripped = stripExportModifiers(text);
    // `export default function () {}` / `export default class {}` have no name, so the bare
    // declaration is not a valid statement — bind them to a name instead.
    if (hasDefaultModifier(statement) && isAnonymousDeclaration(statement)) {
      return `const __workflow_default_export = ${stripped};`;
    }
    return stripped;
  }
  return script.slice(statement.getStart(sourceFile), statement.end);
}

function transformImportDeclaration(statement: ts.ImportDeclaration, importIndex: number): string {
  const specifier = moduleSpecifierText(statement.moduleSpecifier);
  if (!specifier) return "";
  const clause = statement.importClause;
  if (!clause) return `await import(${JSON.stringify(specifier)});`;
  if (clause.isTypeOnly) return "";

  const tempName = `__workflow_import_${importIndex}`;
  const bindings: string[] = [];
  if (clause.name) bindings.push(`const ${clause.name.text} = ${tempName}.default;`);

  if (clause.namedBindings) {
    if (ts.isNamespaceImport(clause.namedBindings)) {
      bindings.push(`const ${clause.namedBindings.name.text} = ${tempName};`);
    } else {
      for (const element of clause.namedBindings.elements) {
        if (element.isTypeOnly) continue;
        const imported = element.propertyName?.text ?? element.name.text;
        bindings.push(`const ${element.name.text} = ${tempName}[${JSON.stringify(imported)}];`);
      }
    }
  }

  if (bindings.length === 0) return "";
  return [`const ${tempName} = await import(${JSON.stringify(specifier)});`, ...bindings].join("\n");
}

function transformExportDeclaration(statement: ts.ExportDeclaration): string {
  // `export type { X } from "m"` is type-only — erase it entirely (no runtime import).
  if (statement.isTypeOnly) return "";
  const specifier = statement.moduleSpecifier ? moduleSpecifierText(statement.moduleSpecifier) : undefined;
  // `export { a, b }` / `export { a as b } from "m"` create no local bindings in ESM, so a bare
  // re-export erases to nothing; a `from "m"` form keeps the import for its side effects only.
  return specifier ? `await import(${JSON.stringify(specifier)});` : "";
}

function hasDefaultModifier(node: ts.Node): boolean {
  return Boolean(
    ts.canHaveModifiers(node) && ts.getModifiers(node)?.some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword),
  );
}

function isAnonymousDeclaration(node: ts.Node): boolean {
  return (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) && node.name === undefined;
}

function moduleSpecifierText(node: ts.Expression): string | undefined {
  return ts.isStringLiteral(node) ? node.text : undefined;
}

function isTypeOnlyImport(statement: ts.ImportDeclaration): boolean {
  const clause = statement.importClause;
  if (!clause) return false;
  if (clause.isTypeOnly) return true;
  const namedBindings = clause.namedBindings;
  return Boolean(
    !clause.name &&
      namedBindings &&
      ts.isNamedImports(namedBindings) &&
      namedBindings.elements.every((element) => element.isTypeOnly),
  );
}

function hasExportModifier(node: ts.Node): boolean {
  return Boolean(ts.canHaveModifiers(node) && ts.getModifiers(node)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword));
}

function stripExportModifiers(text: string): string {
  return text.replace(/^export\s+/, "").replace(/^default\s+/, "");
}

function diagnosticMessage(diagnostic: ts.Diagnostic): string {
  return ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n");
}
