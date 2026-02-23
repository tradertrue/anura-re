import fs from 'node:fs';
import * as parser from '@babel/parser';
import traverse from '@babel/traverse';
import generate from '@babel/generator';
import * as t from '@babel/types';

/** Usage: node deobfuscate.mjs input.js output.js  */
const inputPath = process.argv[2] ?? 'input.js';
const outputPath = process.argv[3] ?? 'output.js';
const code = fs.readFileSync(inputPath, 'utf8');

const ast = parser.parse(code, {
  sourceType: 'unambiguous',
  allowReturnOutsideFunction: true,
  plugins: [
    'classProperties',
    'optionalChaining',
    'nullishCoalescingOperator',
  ],
});

// ---------------------------
// Decode logic
// ---------------------------

function xor(b, c) {
  if (c === '') return b;
  c.replace(String.fromCharCode(32), '');
  for (var d = c.length < 32 ? c.length : 32, e = [], h = 0; h < d; h++)
    e[h] = c.charCodeAt(h) & 31;
  c = 0;
  var m = new String();
  for (h = 0; h < b.length; h++) {
    var l = b.charCodeAt(h);
    m += l & 224 ? String.fromCharCode(l ^ e[c]) : String.fromCharCode(l);
    c++;
    c = c === d ? 0 : c;
  }
  return m;
}

function decodeArray(b, c) {
  const x = xor(String.fromCharCode.apply(null, b), atob(c));
  return JSON.parse(x);
}

// ---------------------------
// AST helpers
// ---------------------------

// JS Value to AST value
function valueToAst(v) {
  if (v === null) return t.nullLiteral();
  if (typeof v === 'string') return t.stringLiteral(v);
  if (typeof v === 'number') return t.numericLiteral(v);
  if (typeof v === 'boolean') return t.booleanLiteral(v);

  if (Array.isArray(v)) return t.arrayExpression(v.map(valueToAst));

  if (typeof v === 'object') {
    const props = Object.keys(v).map((k) =>
      t.objectProperty(t.stringLiteral(k), valueToAst(v[k])),
    );
    return t.objectExpression(props);
  }
}

function staticPropName(prop) {
  if (t.isIdentifier(prop)) return prop.name;
  if (t.isStringLiteral(prop)) return prop.value;
  if (t.isNumericLiteral(prop)) return String(prop.value);
  return null;
}

// Extract and parse the arrays from the AST to JS arrays
function extractReturnedNumericArrayFromFunction(fnNode) {
  if (!t.isFunctionExpression(fnNode)) return null;
  const ret = fnNode.body.body.find((s) => t.isReturnStatement(s));
  if (!ret?.argument || !t.isArrayExpression(ret.argument)) return null;
  return ret.argument.elements.map((el) =>
    t.isNumericLiteral(el) ? el.value : null,
  );
}

// ---------------------------
// 1. extract arrays from a.i.*() functions
// ---------------------------

const extracted = {};
traverse.default(ast, {
  AssignmentExpression(path) {
    const { left, right } = path.node;
    if (!t.isMemberExpression(left)) return;

    for (const key of ['t', 'z', 'u', 'l', 'I', 'uB']) {
      if (
        t.isIdentifier(left.object.object, { name: 'a' }) &&
        t.isIdentifier(left.object.property, { name: 'i' }) &&
        t.isIdentifier(left.property, { name: key })
      ) {
        const arr = extractReturnedNumericArrayFromFunction(right);
        if (arr) {
          extracted[key] = arr;
        }
      }
    }
  },
});

// ---------------------------
// 2. Decode the arrays
// ---------------------------

const decoded = {};
decoded.t = JSON.parse(String.fromCharCode.apply(null, extracted.t));
decoded.z = decodeArray(extracted.z, decoded.t[4]);
decoded.u = decodeArray(extracted.u, decoded.t[6]);
decoded.l = decodeArray(extracted.l, decoded.t[8]);
decoded.I = decodeArray(extracted.I, decoded.t[2]);
decoded.uB = decodeArray(extracted.uB, decoded.t[0]);

// ---------------------------
// 3. Replace the a.H.<key> values
// ---------------------------

traverse.default(ast, {
  MemberExpression(path) {
    const outer = path.node;

    // ignore LHS
    const parent = path.parent;
    if (t.isAssignmentExpression(parent) && parent.left === outer) return;
    if (t.isUpdateExpression(parent) && parent.argument === outer) return;
    if (t.isUnaryExpression(parent) && parent.operator === 'delete') return;

    // make sure we match a.H.<key>
    if (!t.isMemberExpression(outer.object)) return;
    const inner = outer.object;
    if (!t.isMemberExpression(inner.object)) return;
    const aH = inner.object;
    if (!t.isIdentifier(aH.object, { name: 'a' })) return;
    if (!t.isIdentifier(aH.property, { name: 'H' })) return;

    // Get key name and prop name
    const keyName = staticPropName(inner.property);
    if (!keyName || !['z', 'u', 'l', 'I', 'uB'].includes(keyName)) return;

    const propName = staticPropName(outer.property);
    if (!propName) return;

    // Get the value from the decodedArray
    const table = decoded[keyName];
    if (!table || typeof table !== 'object') return;
    const value = table[propName];

    // Replace in the AST
    const repl = valueToAst(value);
    if (!repl) return;

    path.replaceWith(repl);
  },
});

// ---------------------------
// 4 : Replace the a.G.<key>
// ---------------------------

const gMap = new Map();

// 1. Collect
traverse.default(ast, {
  AssignmentExpression(path) {
    const { left, right } = path.node;
    if (!t.isMemberExpression(left)) return;

    if (
      t.isIdentifier(left.object.object, { name: 'a' }) &&
      t.isIdentifier(left.object.property, { name: 'G' })
    ) {
      const k = staticPropName(left.property);
      if (!k) return;

      gMap.set(k, right);
    }
  },
});

// 2. Replace
traverse.default(ast, {
  MemberExpression(path) {
    const node = path.node;

    // match a.G.<k>
    if (
      t.isIdentifier(node.object.object, { name: 'a' }) &&
      t.isIdentifier(node.object.property, { name: 'G' })
    ) {
      const k = staticPropName(node.property);
      if (!k) return;

      const repl = gMap.get(k);
      if (!repl) return;

      // Avoid LHS
      const parent = path.parent;
      if (t.isAssignmentExpression(parent) && parent.left === node) return;
      if (t.isUpdateExpression(parent) && parent.argument === node) return;
      if (t.isUnaryExpression(parent) && parent.operator === 'delete') return;

      // Replace
      path.replaceWith(repl);
    }
  },
});

const out = generate.default(ast, {
  comments: true,
  compact: false,
  jsescOption: { minimal: true },
}).code;

fs.writeFileSync(outputPath, out, 'utf8');
console.log(`Wrote ${outputPath}`);
