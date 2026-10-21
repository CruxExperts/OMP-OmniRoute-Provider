import * as ts from "typescript";

export type SourceResponseMethod = "DELETE" | "GET" | "HEAD" | "OPTIONS" | "PATCH" | "POST" | "PUT";
export type SourceJsonResponse = {
  method: SourceResponseMethod;
  statusCode: string;
  mediaType: string;
  sourceFile: string;
};

export type ReturnedImportedCall = {
  localName: string;
  importedName: string;
  moduleSpecifier: string;
};

export type ReturnedImportedResponseMember = ReturnedImportedCall & {
  member: "response";
};

export type SourceResponseEvidence = {
  jsonResponses: SourceJsonResponse[];
  returnedImportedCalls: ReturnedImportedCall[];
  returnedImportedResponseMembers: ReturnedImportedResponseMember[];
  returnedLocalCalls: string[];
};

export type ManagementPolicyResponse = {
  statusCode: string;
  sourceFile: string;
  line: number;
};

export type PipelineResponseWitness = {
  mediaType: "application/json";
  sourceFile: string;
  line: number;
};

function importedLocalName(source: ts.SourceFile, moduleSpecifier: string, importedName: string): string | undefined {
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)
      || statement.moduleSpecifier.text !== moduleSpecifier) continue;
    const clause = statement.importClause;
    const bindings = clause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings) || clause?.isTypeOnly) continue;
    for (const element of bindings.elements) {
      if (!element.isTypeOnly && (element.propertyName ?? element.name).text === importedName) return element.name.text;
    }
  }
  return undefined;
}

function findObjectMethod(source: ts.SourceFile, objectName: string, methodName: string): Handler | undefined {
  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || declaration.name.text !== objectName || !declaration.initializer) continue;
      const initializer = unwrapExpression(declaration.initializer);
      if (!ts.isObjectLiteralExpression(initializer)) continue;
      for (const property of initializer.properties) {
        const key = property.name && (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) ? property.name.text : undefined;
        if (key !== methodName) continue;
        if (ts.isMethodDeclaration(property) && property.body) return property;
        if (ts.isPropertyAssignment(property)) {
          const value = unwrapExpression(property.initializer);
          if (ts.isFunctionExpression(value) || ts.isArrowFunction(value)) return value;
        }
      }
    }
  }
  return undefined;
}

/** Extracts literal status codes from the exact returned `reject(...)` calls in managementPolicy.evaluate. */
export function collectManagementPolicyResponses(source: ts.SourceFile, sourceFile: string): ManagementPolicyResponse[] {
  const rejectName = importedLocalName(source, "../context", "reject");
  const evaluate = findObjectMethod(source, "managementPolicy", "evaluate");
  const evaluateBody = evaluate?.body;
  if (!rejectName || !evaluate || !evaluateBody) throw new Error(`${sourceFile} has no source-bound management policy reject function`);

  const shadowed = new Set(evaluate.parameters.flatMap(parameter => bindingNames(parameter.name)));
  const collectShadowed = (node: ts.Node): void => {
    if (ts.isFunctionLike(node) && node !== evaluate) return;
    if (ts.isVariableDeclaration(node)) for (const name of bindingNames(node.name)) shadowed.add(name);
    if (ts.isFunctionDeclaration(node) && node.name) shadowed.add(node.name.text);
    if (ts.isClassDeclaration(node) && node.name) shadowed.add(node.name.text);
    ts.forEachChild(node, collectShadowed);
  };
  collectShadowed(evaluateBody);
  if (shadowed.has(rejectName)) throw new Error(`${sourceFile} shadows the imported management policy reject function`);

  const witnesses = new Map<string, number>();
  const collectStatusLeaves = (input: ts.Expression, statuses: Set<string>): void => {
    const expression = unwrapExpression(input);
    if (ts.isConditionalExpression(expression)) {
      collectStatusLeaves(expression.whenTrue, statuses);
      collectStatusLeaves(expression.whenFalse, statuses);
      return;
    }
    if (!ts.isNumericLiteral(expression)) {
      throw new Error(`${sourceFile} management policy reject status has a non-literal conditional leaf`);
    }
    const statusCode = Number(expression.text);
    if (!Number.isInteger(statusCode) || statusCode < 400 || statusCode > 599) {
      throw new Error(`${sourceFile} management policy reject status is invalid`);
    }
    statuses.add(String(statusCode));
  };
  let calls = 0;
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionLike(node) && node !== evaluate) return;
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === rejectName) {
      calls += 1;
      if (!ts.isReturnStatement(node.parent) || node.parent.expression !== node) {
        throw new Error(`${sourceFile} management policy reject call is not directly returned`);
      }
      const status = node.arguments[0];
      if (!status) throw new Error(`${sourceFile} management policy reject status is missing`);
      const statusCodes = new Set<string>();
      collectStatusLeaves(status, statusCodes);
      if (statusCodes.size === 0) throw new Error(`${sourceFile} management policy reject has no bounded status outcomes`);
      const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
      for (const statusCode of statusCodes) {
        if (!witnesses.has(statusCode)) witnesses.set(statusCode, line);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(evaluateBody);
  if (calls === 0 || witnesses.size === 0) throw new Error(`${sourceFile} management policy has no literal rejection outcomes`);
  return [...witnesses].sort(([left], [right]) => Number(left) - Number(right))
    .map(([statusCode, line]) => ({ statusCode, sourceFile, line }));
}

/** Confirms the pipeline forwards policy status through its JSON rejection response without changing it. */
export function collectPipelineRejectionWitness(source: ts.SourceFile, sourceFile: string): PipelineResponseWitness {
  const responseName = importedLocalName(source, "next/server", "NextResponse");
  const rejection = findHandler(source, "rejectionResponse");
  const rejectionBody = rejection?.body;
  if (!responseName || !rejection || !rejectionBody || !ts.isBlock(rejectionBody)) {
    throw new Error(`${sourceFile} has no source-bound JSON policy rejection response`);
  }

  const shadowed = new Set(rejection.parameters.flatMap(parameter => bindingNames(parameter.name)));
  const collectShadowed = (node: ts.Node): void => {
    if (ts.isFunctionLike(node) && node !== rejection) return;
    if (ts.isVariableDeclaration(node)) for (const name of bindingNames(node.name)) shadowed.add(name);
    if (ts.isFunctionDeclaration(node) && node.name) shadowed.add(node.name.text);
    if (ts.isClassDeclaration(node) && node.name) shadowed.add(node.name.text);
    ts.forEachChild(node, collectShadowed);
  };
  collectShadowed(rejectionBody);
  if (shadowed.has(responseName)) throw new Error(`${sourceFile} shadows its NextResponse binding in rejectionResponse`);

  let responseVariable: string | undefined;
  let responseLine: number | undefined;
  let jsonCalls = 0;
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionLike(node) && node !== rejection) return;
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
      && node.expression.name.text === "json" && ts.isIdentifier(node.expression.expression)
      && node.expression.expression.text === responseName) {
      jsonCalls += 1;
      const options = node.arguments[1];
      if (!options || !ts.isObjectLiteralExpression(options)) throw new Error(`${sourceFile} rejection JSON options are not literal`);
      const properties = new Map<string, ts.Expression>();
      for (const property of options.properties) {
        if (!ts.isPropertyAssignment(property)) throw new Error(`${sourceFile} rejection JSON options are not closed`);
        const key = ts.isIdentifier(property.name) || ts.isStringLiteral(property.name) ? property.name.text : undefined;
        if (key === undefined) throw new Error(`${sourceFile} rejection JSON option key is not literal`);
        properties.set(key, property.initializer);
      }
      const status = properties.get("status");
      if (properties.size !== 1 || !status || !ts.isPropertyAccessExpression(status)
        || !ts.isIdentifier(status.expression) || status.expression.text !== "outcome" || status.name.text !== "status") {
        throw new Error(`${sourceFile} rejection JSON does not preserve the policy status exactly`);
      }
      if (!ts.isVariableDeclaration(node.parent) || !ts.isIdentifier(node.parent.name)) {
        throw new Error(`${sourceFile} rejection JSON response is not bound to its returned value`);
      }
      responseVariable = node.parent.name.text;
      responseLine = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
    }
    ts.forEachChild(node, visit);
  };
  visit(rejectionBody);

  const body = rejectionBody;
  const returned = responseVariable !== undefined && body.statements.some(statement => {
    if (!ts.isReturnStatement(statement) || !statement.expression) return false;
    const expression = unwrapExpression(statement.expression);
    return ts.isIdentifier(expression) && expression.text === responseVariable;
  });
  if (jsonCalls !== 1 || !returned || responseLine === undefined) {
    throw new Error(`${sourceFile} rejection JSON response is not the function result`);
  }
  return { mediaType: "application/json", sourceFile, line: responseLine };
}

/** Proves the failure member returned by the pinned validatedJsonBody helper is literal JSON. */
export function collectValidatedJsonBodyFailureResponses(
  source: ts.SourceFile,
  sourceFile: string,
  publicMethod: SourceResponseMethod,
): SourceJsonResponse[] {
  const responseName = importedLocalName(source, "next/server", "NextResponse");
  const helper = findHandler(source, "validatedJsonBody");
  if (!responseName || !helper || !ts.isFunctionDeclaration(helper)
    || !helper.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword)
    || !helper.body || !ts.isBlock(helper.body)
    || topLevelBindingCounts(source).get("validatedJsonBody") !== 1
    || topLevelBindingCounts(source).get(responseName) !== 1 || reassignedBindings(source).has(responseName)) return [];
  const shadowed = new Set(helper.parameters.flatMap(parameter => bindingNames(parameter.name)));
  const visitBindings = (node: ts.Node): void => {
    if (ts.isFunctionLike(node)) return;
    if (ts.isVariableDeclaration(node)) for (const name of bindingNames(node.name)) shadowed.add(name);
    if (ts.isClassDeclaration(node) && node.name) shadowed.add(node.name.text);
    ts.forEachChild(node, visitBindings);
  };
  visitBindings(helper.body);
  if (shadowed.has(responseName)) return [];

  const hints = new Map<string, SourceJsonResponse>();
  let failureReturns = 0;
  let invalid = false;
  const visitReturns = (node: ts.Node): void => {
    if (ts.isFunctionLike(node)) return;
    if (ts.isReturnStatement(node) && node.expression) {
      const returned = unwrapExpression(node.expression);
      if (!ts.isObjectLiteralExpression(returned)) return;
      const properties = new Map<string, ts.Expression>();
      for (const property of returned.properties) {
        if (!ts.isPropertyAssignment(property) || !(ts.isIdentifier(property.name) || ts.isStringLiteral(property.name))
          || properties.has(property.name.text)) { invalid = true; return; }
        properties.set(property.name.text, property.initializer);
      }
      if (properties.get("success")?.kind !== ts.SyntaxKind.FalseKeyword) return;
      failureReturns += 1;
      const response = properties.get("response");
      const call = response && unwrapExpression(response);
      if (!call || !ts.isCallExpression(call) || !ts.isPropertyAccessExpression(call.expression)
        || !ts.isIdentifier(call.expression.expression) || call.expression.expression.text !== responseName
        || call.expression.name.text !== "json" || call.arguments.length !== 2) { invalid = true; return; }
      const options = call.arguments[1];
      if (!options || !ts.isObjectLiteralExpression(options) || options.properties.length !== 1) { invalid = true; return; }
      const status = options.properties[0];
      if (!status || !ts.isPropertyAssignment(status)
        || !(ts.isIdentifier(status.name) || ts.isStringLiteral(status.name)) || status.name.text !== "status"
        || !ts.isNumericLiteral(status.initializer)) { invalid = true; return; }
      const code = Number(status.initializer.text);
      if (!Number.isInteger(code) || code < 400 || code > 599) { invalid = true; return; }
      const hint = { method: publicMethod, statusCode: String(code), mediaType: "application/json", sourceFile };
      hints.set(hint.statusCode, hint);
      return;
    }
    ts.forEachChild(node, visitReturns);
  };
  visitReturns(helper.body);
  return invalid || failureReturns === 0 ? [] : [...hints.values()].sort((a, b) => Number(a.statusCode) - Number(b.statusCode));
}

type Handler = ts.FunctionDeclaration | ts.FunctionExpression | ts.ArrowFunction | ts.MethodDeclaration;

type ImportedBinding = {
  importedName: string;
  moduleSpecifier: string;
};

function unwrapExpression(input: ts.Expression): ts.Expression {
  let expression = input;
  while (ts.isParenthesizedExpression(expression) || ts.isAwaitExpression(expression)
    || ts.isAsExpression(expression) || ts.isTypeAssertionExpression(expression)
    || ts.isNonNullExpression(expression) || ts.isSatisfiesExpression(expression)) {
    expression = expression.expression;
  }
  return expression;
}

function bindingNames(name: ts.BindingName): string[] {
  return ts.isIdentifier(name) ? [name.text]
    : name.elements.flatMap(element => ts.isBindingElement(element) ? bindingNames(element.name) : []);
}


function findHandler(source: ts.SourceFile, localName: string): Handler | undefined {
  for (const statement of source.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name?.text === localName && statement.body) return statement;
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || declaration.name.text !== localName || !declaration.initializer) continue;
      const initializer = unwrapExpression(declaration.initializer);
      if (ts.isFunctionExpression(initializer) || ts.isArrowFunction(initializer)) return initializer;
    }
  }
  return undefined;
}

function expressionCallNames(input: ts.Expression): string[] {
  const expression = unwrapExpression(input);
  if (ts.isBinaryExpression(expression) && expression.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken) {
    return [...expressionCallNames(expression.left), ...expressionCallNames(expression.right)];
  }
  if (ts.isConditionalExpression(expression)) {
    return [...expressionCallNames(expression.whenTrue), ...expressionCallNames(expression.whenFalse)];
  }
  if (ts.isCallExpression(expression) && ts.isIdentifier(expression.expression)) return [expression.expression.text];
  return [];
}

function returnedValueNames(input: ts.Expression): string[] {
  const expression = unwrapExpression(input);
  if (ts.isIdentifier(expression)) return [expression.text];
  if (ts.isBinaryExpression(expression) && expression.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken) {
    return [...returnedValueNames(expression.left), ...returnedValueNames(expression.right)];
  }
  if (ts.isConditionalExpression(expression)) {
    return [...returnedValueNames(expression.whenTrue), ...returnedValueNames(expression.whenFalse)];
  }
  return [];
}

function localFunctionDeclarations(source: ts.SourceFile): Map<string, Handler[]> {
  const declarations = new Map<string, Handler[]>();
  const add = (name: string, handler: Handler): void => {
    const found = declarations.get(name) ?? [];
    found.push(handler);
    declarations.set(name, found);
  };
  for (const statement of source.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name && statement.body) {
      add(statement.name.text, statement);
    } else if (ts.isVariableStatement(statement)
      && (statement.declarationList.flags & ts.NodeFlags.Const) !== 0) {
      for (const declaration of statement.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name) || !declaration.initializer) continue;
        const initializer = unwrapExpression(declaration.initializer);
        if (ts.isFunctionExpression(initializer) || ts.isArrowFunction(initializer)) {
          add(declaration.name.text, initializer);
        }
      }
    }
  }
  return declarations;
}

function topLevelBindingCounts(source: ts.SourceFile): Map<string, number> {
  const counts = new Map<string, number>();
  const add = (name: string): void => {
    counts.set(name, (counts.get(name) ?? 0) + 1);
  };
  for (const statement of source.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name) add(statement.name.text);
    else if (ts.isClassDeclaration(statement) && statement.name) add(statement.name.text);
    else if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        for (const name of bindingNames(declaration.name)) add(name);
      }
    } else if (ts.isImportDeclaration(statement) && statement.importClause) {
      const clause = statement.importClause;
      if (clause.name) add(clause.name.text);
      if (clause.namedBindings && ts.isNamespaceImport(clause.namedBindings)) add(clause.namedBindings.name.text);
      if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
        for (const element of clause.namedBindings.elements) add(element.name.text);
      }
    }
  }
  return counts;
}

function reassignedBindings(source: ts.SourceFile): Set<string> {
  const reassigned = new Set<string>();
  const addTargets = (target: ts.Expression | ts.BindingName): void => {
    if (ts.isIdentifier(target)) {
      reassigned.add(target.text);
      return;
    }
    if (ts.isArrayLiteralExpression(target)) {
      for (const element of target.elements) {
        if (ts.isOmittedExpression(element)) continue;
        addTargets(element);
      }
    } else if (ts.isArrayBindingPattern(target)) {
      for (const element of target.elements) {
        if (!ts.isOmittedExpression(element)) addTargets(element.name);
      }
    } else if (ts.isObjectLiteralExpression(target)) {
      for (const element of target.properties) {
        if (ts.isShorthandPropertyAssignment(element)) reassigned.add(element.name.text);
        else if (ts.isPropertyAssignment(element)) addTargets(element.initializer);
      }
    } else if (ts.isObjectBindingPattern(target)) {
      for (const element of target.elements) addTargets(element.name);
    }
  };
  const visit = (node: ts.Node): void => {
    if (ts.isBinaryExpression(node)
      && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment
      && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment) addTargets(node.left);
    if ((ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node))
      && (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken)
      && ts.isIdentifier(node.operand)) reassigned.add(node.operand.text);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return reassigned;
}


function collectHandlerEvidence(
  handler: Handler,
  sourceFile: string,
  publicMethod: SourceResponseMethod,
  constructors: ReadonlySet<string>,
  importedBindings: ReadonlyMap<string, ImportedBinding>,
  safeLocalNames: ReadonlySet<string>,
  safeImportedNames: ReadonlySet<string>,
): SourceResponseEvidence {
  const body = handler.body;
  if (!body) return { jsonResponses: [], returnedImportedCalls: [], returnedImportedResponseMembers: [], returnedLocalCalls: [] };
  const shadowed = new Set(handler.parameters.flatMap(parameter => bindingNames(parameter.name)));
  if (ts.isFunctionExpression(handler) && handler.name) shadowed.add(handler.name.text);

  const initializerCalls = new Map<string, string | undefined>();
  const writtenNames = new Set<string>();
  const markWriteTargets = (node: ts.Node): void => {
    if (ts.isIdentifier(node)) {
      writtenNames.add(node.text);
      return;
    }
    ts.forEachChild(node, markWriteTargets);
  };
  const collectWrites = (node: ts.Node): void => {
    if (ts.isBinaryExpression(node)
      && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment
      && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment) markWriteTargets(node.left);
    if ((ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node))
      && (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken)) {
      markWriteTargets(node.operand);
    }
    ts.forEachChild(node, collectWrites);
  };
  const collectLocals = (node: ts.Node): void => {
    if (ts.isFunctionLike(node)) {
      if (ts.isFunctionDeclaration(node) && node.name) shadowed.add(node.name.text);
      else if (ts.isFunctionExpression(node) && node.name) shadowed.add(node.name.text);
      return;
    }
    if (ts.isVariableDeclaration(node)) {
      const names = bindingNames(node.name);
      for (const name of names) shadowed.add(name);
      if (ts.isIdentifier(node.name)) {
        const calls = node.initializer ? expressionCallNames(node.initializer) : [];
        const first = calls[0];
        const candidate = first !== undefined && calls.every(name => name === first) ? first : undefined;
        if (initializerCalls.has(node.name.text)) initializerCalls.set(node.name.text, undefined);
        else initializerCalls.set(node.name.text, candidate);
      }
    }
    if (ts.isClassDeclaration(node) && node.name) shadowed.add(node.name.text);
    ts.forEachChild(node, collectLocals);
  };
  if (ts.isBlock(body)) {
    collectWrites(body);
    collectLocals(body);
  }

  const jsonResponses = new Map<string, SourceJsonResponse>();
  const returnedCalls = new Set<string>();
  const returnedResponseMembers = new Set<string>();
  const returnedLocals = new Set<string>();

  const visitAdjacentFailureReturn = (node: ts.Node): void => {
    if (ts.isFunctionLike(node)) return;
    if (ts.isBlock(node)) {
      for (let index = 0; index + 1 < node.statements.length; index++) {
        const declarationStatement = node.statements[index];
        const branch = node.statements[index + 1];
        if (!declarationStatement || !branch || !ts.isVariableStatement(declarationStatement) || (declarationStatement.declarationList.flags & ts.NodeFlags.Const) === 0
          || declarationStatement.declarationList.declarations.length !== 1 || !ts.isIfStatement(branch) || branch.elseStatement) continue;
        const declaration = declarationStatement.declarationList.declarations[0];
        if (!declaration || !ts.isIdentifier(declaration.name) || !declaration.initializer
          || writtenNames.has(declaration.name.text)) continue;
        if (!ts.isAwaitExpression(declaration.initializer)) continue;
        const initializer = unwrapExpression(declaration.initializer.expression);
        if (!ts.isCallExpression(initializer) || !ts.isIdentifier(initializer.expression)) continue;
        const callName = initializer.expression.text;
        if (!safeImportedNames.has(callName) || shadowed.has(callName)) continue;
        const condition = unwrapExpression(branch.expression);
        if (!ts.isPrefixUnaryExpression(condition) || condition.operator !== ts.SyntaxKind.ExclamationToken) continue;
        const predicate = unwrapExpression(condition.operand);
        if (!ts.isPropertyAccessExpression(predicate) || !ts.isIdentifier(predicate.expression)
          || predicate.expression.text !== declaration.name.text || predicate.name.text !== "success") continue;
        const returned = ts.isBlock(branch.thenStatement)
          ? branch.thenStatement.statements.length === 1 ? branch.thenStatement.statements[0] : undefined
          : branch.thenStatement;
        if (!returned || !ts.isReturnStatement(returned) || !returned.expression) continue;
        const value = unwrapExpression(returned.expression);
        if (ts.isPropertyAccessExpression(value) && ts.isIdentifier(value.expression)
          && value.expression.text === declaration.name.text && value.name.text === "response") {
          returnedResponseMembers.add(callName);
        }
      }
    }
    ts.forEachChild(node, visitAdjacentFailureReturn);
  };
  if (ts.isBlock(body)) visitAdjacentFailureReturn(body);

  const addJsonResponse = (input: ts.Expression): void => {
    const expression = unwrapExpression(input);
    if (ts.isConditionalExpression(expression)) {
      addJsonResponse(expression.whenTrue);
      addJsonResponse(expression.whenFalse);
      return;
    }
    if (!ts.isCallExpression(expression) || !ts.isPropertyAccessExpression(expression.expression)
      || expression.expression.name.text !== "json" || !ts.isIdentifier(expression.expression.expression)) return;
    const receiver = expression.expression.expression.text;
    if (!constructors.has(receiver) || shadowed.has(receiver)) return;

    let status = 200;
    let mediaType = "application/json";
    const options = expression.arguments[1];
    if (options) {
      if (!ts.isObjectLiteralExpression(options)) return;
      for (const property of options.properties) {
        if (!ts.isPropertyAssignment(property)) return;
        const propertyKey = property.name;
        const name = ts.isIdentifier(propertyKey) || ts.isStringLiteral(propertyKey) ? propertyKey.text : undefined;
        if (name === undefined) return;
        if (name === "status") {
          if (!ts.isNumericLiteral(property.initializer)) return;
          status = Number(property.initializer.text);
        }
        if (name === "headers") {
          if (!ts.isObjectLiteralExpression(property.initializer)) return;
          for (const header of property.initializer.properties) {
            if (!ts.isPropertyAssignment(header)) return;
            const headerKey = header.name;
            const headerName = ts.isIdentifier(headerKey) || ts.isStringLiteral(headerKey) ? headerKey.text : undefined;
            if (headerName === undefined || !ts.isStringLiteralLike(header.initializer)) return;
            if (headerName.toLowerCase() === "content-type") {
              mediaType = header.initializer.text.split(";", 1)[0]!.trim().toLowerCase();
            }
          }
        }
      }
    }
    if (!Number.isInteger(status) || status < 200 || status > 599 || [204, 205, 304].includes(status)
      || !/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(mediaType)) return;
    const hint = { method: publicMethod, statusCode: String(status), mediaType, sourceFile };
    jsonResponses.set(`${hint.statusCode}\0${hint.mediaType}\0${hint.sourceFile}`, hint);
  };

  const collectReturnedCalls = (input: ts.Expression): void => {
    for (const callName of expressionCallNames(input)) {
      if (importedBindings.has(callName) && !shadowed.has(callName)) returnedCalls.add(callName);
      if (safeLocalNames.has(callName) && !shadowed.has(callName)) returnedLocals.add(callName);
    }
    for (const name of returnedValueNames(input)) {
      const initialized = initializerCalls.get(name);
      if (initialized && !writtenNames.has(name) && importedBindings.has(initialized) && !shadowed.has(initialized)) returnedCalls.add(initialized);
    }
  };

  const visitReturns = (node: ts.Node): void => {
    if (ts.isFunctionLike(node)) return;
    if (ts.isReturnStatement(node) && node.expression) {
      addJsonResponse(node.expression);
      collectReturnedCalls(node.expression);
      return;
    }
    ts.forEachChild(node, visitReturns);
  };
  if (ts.isBlock(body)) visitReturns(body);
  else {
    addJsonResponse(body);
    collectReturnedCalls(body);
  }

  return {
    jsonResponses: [...jsonResponses.values()].sort((left, right) =>
      left.statusCode.localeCompare(right.statusCode) || left.mediaType.localeCompare(right.mediaType) || left.sourceFile.localeCompare(right.sourceFile)),
    returnedImportedCalls: [...returnedCalls].sort().flatMap(localName => {
      const binding = importedBindings.get(localName);
      return binding ? [{ localName, ...binding }] : [];
    }),
    returnedImportedResponseMembers: [...returnedResponseMembers].sort().flatMap(localName => {
      const binding = importedBindings.get(localName);
      return binding ? [{ localName, ...binding, member: "response" as const }] : [];
    }),
    returnedLocalCalls: [...returnedLocals].sort(),
  };
}

/** Collects literal Response.json returns and imported-guard calls actually returned by one exported method. */
export function collectSourceResponseEvidence(
  source: ts.SourceFile,
  handlerName: string,
  publicMethod: SourceResponseMethod,
  sourceFile: string,
): SourceResponseEvidence {
  const constructors = new Set(["Response"]);
  const importedBindings = new Map<string, ImportedBinding>();
  for (const statement of source.statements) {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
      const moduleSpecifier = statement.moduleSpecifier.text;
      const clause = statement.importClause;
      if (clause?.name) {
        constructors.delete(clause.name.text);
      }
      const bindings = clause?.namedBindings;
      if (bindings && ts.isNamespaceImport(bindings)) {
        constructors.delete(bindings.name.text);
      }
      if (bindings && ts.isNamedImports(bindings)) for (const element of bindings.elements) {
        const importedName = (element.propertyName ?? element.name).text;
        const localName = element.name.text;
        if (moduleSpecifier === "next/server" && importedName === "NextResponse" && !element.isTypeOnly && !clause?.isTypeOnly) {
          constructors.add(localName);
        } else {
          constructors.delete(localName);
        }
        if (!element.isTypeOnly && !clause?.isTypeOnly) importedBindings.set(localName, { importedName, moduleSpecifier });
      }
    }
    if (ts.isFunctionDeclaration(statement) && statement.name) constructors.delete(statement.name.text);
    if (ts.isClassDeclaration(statement) && statement.name) constructors.delete(statement.name.text);
    if (ts.isVariableStatement(statement)) for (const declaration of statement.declarationList.declarations) {
      for (const name of bindingNames(declaration.name)) constructors.delete(name);
    }
  }

  const handler = findHandler(source, handlerName);
  if (!handler) return { jsonResponses: [], returnedImportedCalls: [], returnedImportedResponseMembers: [], returnedLocalCalls: [] };

  const localDeclarations = localFunctionDeclarations(source);
  const topLevelBindings = topLevelBindingCounts(source);
  const reassigned = reassignedBindings(source);
  const safeImportedNames = new Set([...importedBindings].flatMap(([name, binding]) =>
    binding.moduleSpecifier === "@/shared/validation/helpers" && binding.importedName === "validatedJsonBody"
      && topLevelBindings.get(name) === 1 && !reassigned.has(name) ? [name] : []));
  const safeLocalNames = new Set([...localDeclarations].flatMap(([name, declarations]) =>
    declarations.length === 1 && topLevelBindings.get(name) === 1 && !reassigned.has(name) ? [name] : []));
  const jsonResponses = new Map<string, SourceJsonResponse>();
  const returnedImportedCalls = new Map<string, ReturnedImportedCall>();
  const returnedImportedResponseMembers = new Map<string, ReturnedImportedResponseMember>();
  const visited = new Set<Handler>([handler]);
  const queue: Array<{ handler: Handler; depth: number }> = [{ handler, depth: 0 }];
  const maxDepth = 16;
  const maxHandlers = 128;

  while (queue.length > 0) {
    const current = queue.shift()!;
    const evidence = collectHandlerEvidence(
      current.handler, sourceFile, publicMethod, constructors, importedBindings, safeLocalNames, safeImportedNames,
    );
    for (const hint of evidence.jsonResponses) {
      jsonResponses.set(`${hint.statusCode}\0${hint.mediaType}\0${hint.sourceFile}`, hint);
    }
    for (const call of evidence.returnedImportedCalls) returnedImportedCalls.set(call.localName, call);
    for (const member of evidence.returnedImportedResponseMembers) returnedImportedResponseMembers.set(member.localName, member);
    for (const localName of evidence.returnedLocalCalls) {
      const declaration = localDeclarations.get(localName)?.[0];
      if (!declaration || visited.has(declaration)) continue;
      if (current.depth >= maxDepth) throw new Error(`${sourceFile} returned local response helper depth exceeds ${maxDepth}`);
      if (visited.size >= maxHandlers) throw new Error(`${sourceFile} returned local response helper count exceeds ${maxHandlers}`);
      visited.add(declaration);
      queue.push({ handler: declaration, depth: current.depth + 1 });
    }
  }

  return {
    jsonResponses: [...jsonResponses.values()].sort((left, right) =>
      left.statusCode.localeCompare(right.statusCode) || left.mediaType.localeCompare(right.mediaType) || left.sourceFile.localeCompare(right.sourceFile)),
    returnedImportedCalls: [...returnedImportedCalls.values()].sort((left, right) => left.localName.localeCompare(right.localName)),
    returnedImportedResponseMembers: [...returnedImportedResponseMembers.values()].sort((left, right) => left.localName.localeCompare(right.localName)),
    returnedLocalCalls: [],
  };
}
