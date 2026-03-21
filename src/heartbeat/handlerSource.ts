import ts from 'typescript';

const GLOBAL_IDENTIFIERS = new Set([
  'Array',
  'BigInt',
  'Boolean',
  'Buffer',
  'Date',
  'Error',
  'Infinity',
  'JSON',
  'Map',
  'Math',
  'NaN',
  'Number',
  'Object',
  'Promise',
  'RegExp',
  'Set',
  'String',
  'Symbol',
  'TASK_DONE',
  'URL',
  'URLSearchParams',
  'FINISH',
  'clearInterval',
  'clearTimeout',
  'console',
  'decodeURIComponent',
  'encodeURIComponent',
  'file',
  'fetch',
  'global',
  'globalThis',
  'isFinite',
  'isNaN',
  'parseFloat',
  'parseInt',
  'process',
  'queueMicrotask',
  'require',
  'setInterval',
  'setTimeout',
  'structuredClone',
  'undefined',
]);

function addBindingNames(name: ts.BindingName, target: Set<string>): void {
  if (ts.isIdentifier(name)) {
    target.add(name.text);
    return;
  }

  for (const element of name.elements) {
    if (ts.isOmittedExpression(element)) {
      continue;
    }
    addBindingNames(element.name, target);
  }
}

function collectFunctionScopeNames(node: ts.Node, target: Set<string>, root = node): void {
  if (node !== root && ts.isFunctionLike(node)) {
    return;
  }

  if (ts.isVariableDeclaration(node)) {
    addBindingNames(node.name, target);
  } else if (ts.isParameter(node)) {
    addBindingNames(node.name, target);
  } else if (ts.isFunctionDeclaration(node) && node.name) {
    target.add(node.name.text);
  } else if (ts.isClassDeclaration(node) && node.name) {
    target.add(node.name.text);
  } else if (ts.isCatchClause(node) && node.variableDeclaration) {
    addBindingNames(node.variableDeclaration.name, target);
  }

  ts.forEachChild(node, child => collectFunctionScopeNames(child, target, root));
}

function isDeclarationIdentifier(node: ts.Identifier): boolean {
  const parent = node.parent;
  if (!parent) {
    return false;
  }

  if ((ts.isVariableDeclaration(parent)
      || ts.isParameter(parent)
      || ts.isFunctionDeclaration(parent)
      || ts.isFunctionExpression(parent)
      || ts.isClassDeclaration(parent)
      || ts.isClassExpression(parent)
      || ts.isBindingElement(parent))
    && parent.name === node) {
    return true;
  }

  if (ts.isImportClause(parent)
    || ts.isImportSpecifier(parent)
    || ts.isNamespaceImport(parent)
    || ts.isImportEqualsDeclaration(parent)
    || ts.isTypeParameterDeclaration(parent)) {
    return true;
  }

  return false;
}

function isTypeIdentifier(node: ts.Identifier): boolean {
  return !!node.parent && (
    ts.isTypeNode(node.parent)
    || ts.isExpressionWithTypeArguments(node.parent)
    || ts.isImportTypeNode(node.parent)
    || ts.isTypeAliasDeclaration(node.parent)
    || ts.isInterfaceDeclaration(node.parent)
    || ts.isTypeParameterDeclaration(node.parent)
  );
}

function isPropertyNameIdentifier(node: ts.Identifier): boolean {
  const parent = node.parent;
  if (!parent) {
    return false;
  }

  if (ts.isPropertyAccessExpression(parent) && parent.name === node) {
    return true;
  }

  if ((ts.isPropertyAssignment(parent) || ts.isPropertyDeclaration(parent) || ts.isPropertySignature(parent) || ts.isMethodDeclaration(parent) || ts.isMethodSignature(parent))
    && parent.name === node) {
    return !ts.isShorthandPropertyAssignment(parent);
  }

  if (ts.isEnumMember(parent) && parent.name === node) {
    return true;
  }

  return false;
}

function buildScope(node: ts.FunctionLikeDeclarationBase, parent?: Set<string>): Set<string> {
  const names = new Set<string>(parent ? Array.from(parent) : []);
  if (node.name && ts.isIdentifier(node.name)) {
    names.add(node.name.text);
  }
  collectFunctionScopeNames(node, names);
  return names;
}

function isFunctionLikeWithBody(node: ts.Node): node is ts.FunctionLikeDeclarationBase & { body: ts.ConciseBody } {
  return ts.isArrowFunction(node) || ts.isFunctionExpression(node);
}

export function collectFreeIdentifiers(source: string, allowedIdentifiers: string[] = []): string[] {
  const wrapped = `const __heartbeat_handler__ = (${source});`;
  const file = ts.createSourceFile('heartbeat-handler.ts', wrapped, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const statement = file.statements.find(ts.isVariableStatement);
  const declaration = statement?.declarationList.declarations[0];
  let initializer = declaration?.initializer;

  while (initializer && ts.isParenthesizedExpression(initializer)) {
    initializer = initializer.expression;
  }

  if (!initializer || !ts.isArrowFunction(initializer) && !ts.isFunctionExpression(initializer)) {
    throw new Error('Heartbeat handlers must be plain functions or async functions.');
  }

  const free = new Set<string>();
  const allowed = new Set([...GLOBAL_IDENTIFIERS, ...allowedIdentifiers]);

  const visit = (node: ts.Node, scope: Set<string>): void => {
    if (isFunctionLikeWithBody(node) && node !== initializer) {
      const childScope = buildScope(node, scope);
      visit(node.body, childScope);
      return;
    }

    if (ts.isIdentifier(node)) {
      if (!isDeclarationIdentifier(node)
        && !isPropertyNameIdentifier(node)
        && !isTypeIdentifier(node)
        && !scope.has(node.text)
        && !allowed.has(node.text)) {
        free.add(node.text);
      }
    }

    ts.forEachChild(node, child => visit(child, scope));
  };

  visit(initializer.body, buildScope(initializer));
  return Array.from(free).sort();
}

export function validateHandlerSource(source: string, allowedIdentifiers: string[] = []): string {
  if (!source) {
    throw new Error('Heartbeat handler source is empty.');
  }

  if (source.includes('[native code]')) {
    throw new Error('Native functions cannot be persisted as heartbeat handlers.');
  }

  const freeIdentifiers = collectFreeIdentifiers(source, allowedIdentifiers);
  if (freeIdentifiers.length > 0) {
    throw new Error(`Heartbeat handler closes over unsupported identifiers: ${freeIdentifiers.join(', ')}`);
  }

  return source;
}

export function serializeHandlerSource(handler: unknown, allowedIdentifiers: string[] = []): string {
  if (typeof handler !== 'function') {
    throw new Error('Heartbeat handlers must be functions.');
  }

  return validateHandlerSource(handler.toString().trim(), allowedIdentifiers);
}

export const __internals = {
  collectFreeIdentifiers,
  validateHandlerSource,
};
