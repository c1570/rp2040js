#!/usr/bin/env node
// cts2c.js — Transpile a restricted subset of TypeScript to C.
// Designed for the rp2350js emulator core.
//
// Mapping rules:
//   class Foo { x: number; }           → typedef struct { int32_t x; } Foo;
//   method bar(): number { ... }       → int32_t Foo_bar(Foo* self) { ... }
//   this.x                             → self->x
//   this.method(a)                     → Foo_method(self, a)
//   obj.method(a)   (typed)            → Class_method(&obj, a)
//   number                             → int32_t (unsigned via >>> at use sites)
//   Int32Array / Uint32Array           → int32_t* / uint32_t* (calloc'd)
//   Uint8Array                         → uint8_t*
//   Int53Array                         → uint64_t* (Float64-backed in JS, native 64-bit
//                                         pack/unpack via int53High/int53Pack intrinsics)
//   enum E { A, B }                    → typedef enum { E_A, E_B } E;
//   interface I { foo(): T }           → vtable typedef

'use strict';

const fs = require('fs');
const path = require('path');
const parser = require('@babel/parser');

// ─── Shadow-file redirection ────────────────────────────────────────
// Set from the `--shadow-dir <dir>` CLI flag (see main()). Every read of a
// discovered .ts source file goes through readSourceFile() below instead of a
// bare fs.readFileSync, so a preprocessing pass (e.g. monomorphize-chip-classes.mjs)
// can substitute a rewritten file's CONTENT while every discovery/collection pass
// still walks the real on-disk src/ tree by its real path — collectTypes/
// preRegisterTypes/discoverGenericInstantiations always re-discover files by
// scanning src/ directly (see findTsFiles/findSrcRoot in main()), independent of
// the explicit CLI file list, so redirecting by path substitution alone (passing a
// different path on the CLI) does not reach them; this does.
let shadowDir = null;

function readSourceFile(filepath) {
  if (shadowDir) {
    const shadowPath = path.join(shadowDir, path.basename(filepath));
    if (fs.existsSync(shadowPath)) return fs.readFileSync(shadowPath, 'utf8');
  }
  return fs.readFileSync(filepath, 'utf8');
}

// Fixed capacity for a class field declared `X[] = []` and only ever grown via
// `.push()` — cts2c has no resizable-array support, so such a field is
// modeled as a preallocated slot array plus a `<field>_count` companion struct member
// (see the `isGrowableArray` collectTypes branch, emitAllStructDefs,
// emitFieldInitializers, the `.push()`/`.length` emitExpr cases, and the
// ForOfStatement case). Every real growable-array field that reaches the "full"
// transpile set holds a small, bounded number of items in practice (e.g. a Timer32
// has at most a handful of interested listeners) — 8 is generous headroom, not a
// tight fit.
const GROWABLE_ARRAY_CAPACITY = 8;

// ─── Type registry ──────────────────────────────────────────────────
const classes = new Map(); // name → { fields, methods, parent, isBase, implements }
const enums = new Map(); // name → Map<member, value>
const interfaces = new Map(); // name → Map<method name, { retType, params }>
const freeFunctions = new Map(); // name → { params, retType }
const arrowFunctions = new Map(); // name → { params, retType }
const emittedConstants = new Set(); // track emitted const names to avoid redeclaration

// ALL top-level numeric-ish const names, exported or not, registered up front in
// preRegisterTypes. A separate registry from emittedConstants, which only gets a
// bare/module-private const's name once its own file is actually emitted in Pass 2 — too
// late for Pass-1 field-type inference to see it. Must NOT be pre-populated into
// emittedConstants itself, or Pass 2 wrongly skips emitting it as "already emitted".
const scalarConstNames = new Set();

// Top-level consts emitted as a real C array (`static const T NAME[] = {...}`). Lets
// `new Uint32Array(NAME)` (construct-from-existing-array) be told apart from
// `new Uint32Array(N)` (construct N zeroed elements, a bare numeric element count).
const arrayConstNames = new Set();

// Top-level ragged 2D array consts (`const NAME = [[...], [...], ...];`), emitted as a
// real "array of sub-array pointers" plus a parallel `NAME_lens` length array, since bare
// C pointers don't carry their own length. Consulted by ForOfStatement's
// `for (x of NAME[computedIndex])` codegen.
const ragged2DArrayNames = new Set();

// Top-level `const NAME = 'literal';` consts emitted as `static const char* NAME = "...";`.
// Lets isCharPtrExpr recognize a bare reference to one (e.g. `${LOG_NAME} unaligned word
// read...`) as a string instead of falling through to the numeric default.
const stringConstNames = new Set();

// name → its emitted value string, to tell a genuine cross-file collision (same name,
// different value — module-private register-offset consts like WDSEL/PLATFORM are commonly
// reused across peripheral file pairs) from a harmless duplicate declaration (same name,
// same value, fine to skip re-emitting).
const constantValues = new Map();

// This file's name → renamed-identifier map, populated when a genuine collision (above) is
// hit while processing this file's own consts. Reset per file in transpileFileImpls.
let currentFileConstRenames = new Map();

const namespaceImports = new Set(); // local names bound by `import * as X from '...'`
let switchTmpCounter = 0; // unique temp-var suffix for string-switch lowering (see emitStmt/SwitchStatement)
let includesCallCounter = 0; // unique temp-var suffix for `[a,b,c].includes(x)` lowering (see emitExpr/CallExpression)
const emittedFunctions = new Set(); // track emitted function/method names to avoid redefinition

// C decl lines for top-level consts, collected across ALL files (not just the ones passed
// as cts2c.js inputs) so a const like FUNCTION_PWM in gpio-pin.ts is visible even when only
// rp2040.ts/rp2350.ts are transpiled.
const globalConstantDecls = [];
const typeAliases = new Map(); // name → resolved C type string

// ─── ChipType monomorphization ──────────────────────────────────────
// Free functions generic over `ChipType extends IRPChip` (e.g. loadFirmware) are
// called from BOTH RP2040 and RP2350 code paths with different concrete types —
// unlike class methods, where ChipType is unconditionally resolved to RP2350 (a class
// is only ever "the class being transpiled", not shared polymorphically the way this
// one free-function call chain is). Rather than erasing the type to void* (losing all
// field/method access) or hardcoding one concrete type (breaking the other caller),
// emit one specialized C function per (function, concrete type) pair actually needed —
// real monomorphization, the same technique C++ templates/Rust generics use.
const genericFreeFunctionDecls = new Map(); // name → { node: FunctionDeclaration AST, chipParamIndex }
const genericInstantiations = new Map(); // mangled name → { name, type }
const pendingGenericInstantiations = []; // worklist of { name, type } still needing their body walked/emitted
let currentChipTypeOverride = null; // set while collecting/emitting one specific instantiation

function mangleGeneric(name, type) {
  return `${name}__${type}`;
}

// Register that `name` (a known ChipType-generic free function) needs a `type`-
// specialized instantiation, computing and stashing its concrete signature under the
// mangled name. Idempotent — safe to call redundantly from both the discovery walk and
// real call-site codegen.
function registerGenericInstantiation(name, type) {
  const mangled = mangleGeneric(name, type);
  if (genericInstantiations.has(mangled)) return mangled;
  const decl = genericFreeFunctionDecls.get(name);
  if (!decl) return mangled;
  const prevOverride = currentChipTypeOverride;
  currentChipTypeOverride = type;
  const sig = collectFreeFunctionSignature(decl.node);
  currentChipTypeOverride = prevOverride;
  genericInstantiations.set(mangled, { name, type });
  freeFunctions.set(mangled, sig);
  pendingGenericInstantiations.push({ name, type });
  return mangled;
}

// Lightweight, read-only AST walk used only to discover which instantiations are
// needed (so their forward declarations can be emitted before any real body uses
// them) — deliberately NOT reusing the real emitStmt/emitExpr codegen path, which
// mutates lots of global dedup state (emittedFunctions, emittedConstants, ...) that
// assumes each thing is emitted exactly once; running that twice (once to discover,
// once for real) would corrupt that bookkeeping. `contextType` is the concrete type
// that `this` (inside a class method) or the enclosing generic function's own
// ChipType-typed parameter (inside another generic function) currently resolves to.
function walkForGenericCalls(node, contextType) {
  if (!node || typeof node !== 'object') return;
  if (node.type === 'CallExpression' && node.callee?.type === 'Identifier') {
    const decl = genericFreeFunctionDecls.get(node.callee.name);
    if (decl) {
      const argNode = node.arguments[decl.chipParamIndex];
      // Every real call site in this codebase either passes `this` (from a class
      // method) or forwards the enclosing generic function's own chip-typed param
      // (an Identifier) — both mean "whatever contextType currently is". Any other
      // shape falls back to RP2350 (cts2c's existing generic-ChipType default)
      // rather than leaving the instantiation undiscovered.
      const concreteType =
        argNode?.type === 'ThisExpression' || argNode?.type === 'Identifier'
          ? contextType
          : 'RP2350';
      registerGenericInstantiation(node.callee.name, concreteType);
    }
  }
  for (const k in node) {
    if (k === 'loc' || k === 'start' || k === 'end' || k === 'range') continue;
    const v = node[k];
    if (Array.isArray(v)) {
      for (const x of v) walkForGenericCalls(x, contextType);
    } else if (v && typeof v === 'object' && v.type) walkForGenericCalls(v, contextType);
  }
}

// Seed discovery from every class method body (this → class name) across the actual
// input files, then process the worklist to a fixed point — walking a newly
// discovered instantiation's OWN body (under its concrete type) may turn up further
// nested generic calls.
function discoverGenericInstantiations(inputFiles) {
  if (genericFreeFunctionDecls.size === 0) return;
  for (const f of inputFiles) {
    const src = readSourceFile(f);
    const ast = parser.parse(src, {
      sourceType: 'module',
      plugins: ['typescript'],
      ranges: false,
      loc: false,
    });
    for (const node of ast.program.body) {
      let n = node;
      if (n.type === 'ExportNamedDeclaration') n = n.declaration;
      if (!n) continue;
      if (n.type === 'ClassDeclaration' && n.id?.name) {
        for (const member of n.body.body) {
          if (member.type === 'ClassMethod' && member.body) {
            walkForGenericCalls(member.body, n.id.name);
          }
        }
      } else if (
        n.type === 'FunctionDeclaration' &&
        n.id?.name &&
        !genericFreeFunctionDecls.has(n.id.name) &&
        n.body
      ) {
        // A non-generic free function calling a generic one directly — not currently
        // the case anywhere in this codebase, but handled for completeness. No `this`/
        // chip-forwarding context applies here, so fall back to RP2350.
        walkForGenericCalls(n.body, 'RP2350');
      }
    }
  }
  while (pendingGenericInstantiations.length) {
    const { name, type } = pendingGenericInstantiations.shift();
    const decl = genericFreeFunctionDecls.get(name);
    if (decl?.node?.body) walkForGenericCalls(decl.node.body, type);
  }
}

// Emit the real C body for every instantiation discovered so far, draining the
// worklist to a fixed point (emitting one instantiation's body can call another
// generic function, discovering yet another instantiation via the real call-site
// codegen path in emitExpr).
function emitGenericFunctionInstantiations(out) {
  const emitted = new Set();
  while (true) {
    const remaining = [...genericInstantiations.keys()].filter((m) => !emitted.has(m));
    if (remaining.length === 0) break;
    for (const mangled of remaining) {
      emitted.add(mangled);
      const { name, type } = genericInstantiations.get(mangled);
      const decl = genericFreeFunctionDecls.get(name);
      const fn = freeFunctions.get(mangled);
      if (!decl || !fn) continue;
      const prevOverride = currentChipTypeOverride;
      const prevFile = currentFile;
      const prevSrcLines = currentSrcLines;
      currentChipTypeOverride = type;
      // loc()-based TODO markers read currentFile/currentSrcLines — normally set per
      // file by transpileFileImpls, which this bypasses (the same declaration is
      // re-emitted once per instantiation, not once per file), so set them explicitly
      // from the declaring file or every TODO marker in here mislabels its origin.
      currentFile = path.relative(process.cwd(), decl.filepath);
      currentSrcLines = readSourceFile(decl.filepath).split('\n');
      const params = fn.params;
      const paramStr = params.map((p) => `${p.type} ${cName(p.name)}`).join(', ') || 'void';
      // `p.tsType` for a ChipType-generic param is still the literal name "ChipType"
      // (unresolved) — resolveFieldInfo's `ctx.varTypes` lookup needs the real concrete
      // instantiation type to find fields on it.
      // `loadFirmwareFromUF2` (src/utils/load-firmware.ts) calls the third-party `uf2`
      // npm package's decodeBlock() — cts2c has no way to transpile that at all — so
      // instead of transpiling this function's body, emit a call straight into
      // cts2c_loadUF2 (a hand-written C decoder in this file's own runtime prelude,
      // see its own comment). The real TS body is untouched and still runs under
      // Node (via the actual npm package), so JS/vitest behavior is unaffected.
      if (name === 'loadFirmwareFromUF2') {
        const chipParam = cName(params[0].name);
        const pathParam = cName(params[1].name);
        out.push(`static ${fn.retType} ${mangled}(${paramStr}) {`);
        out.push(`  bool useSram = false;`);
        out.push(`  uint32_t loadBase = 0;`);
        out.push(
          `  cts2c_loadUF2(${pathParam}, ${chipParam}->flash, FLASH_START_ADDRESS, ${chipParam}->sram, RAM_START_ADDRESS, &useSram, &loadBase);`
        );
        out.push(`  tryLoadDisassembly__${type}(${pathParam}, ${chipParam}, "uf2");`);
        out.push(
          `  return memcpy(malloc(sizeof(LoadFirmwareResult)), &(LoadFirmwareResult){ .format = "uf2", .useSram = useSram, .loadBase = (int32_t)loadBase }, sizeof(LoadFirmwareResult));`
        );
        out.push(`}`);
        out.push('');
        currentChipTypeOverride = prevOverride;
        currentFile = prevFile;
        currentSrcLines = prevSrcLines;
        continue;
      }
      const scope = {};
      for (const p of params)
        if (p.tsType) scope[p.name] = p.tsType === 'ChipType' ? type : p.tsType;
      const ctx = { className: null, fields: null, varTypes: scope };
      out.push(`static ${fn.retType} ${mangled}(${paramStr}) {`);
      emitBody(decl.node.body, mangled, params, out, ctx);
      emitFallbackReturn(decl.node.body, fn.retType, out);
      out.push(`}`);
      out.push('');
      currentChipTypeOverride = prevOverride;
      currentFile = prevFile;
      currentSrcLines = prevSrcLines;
    }
  }
}

// ─── Source-location tracking (for TODO markers) ───────────────────
// Set while processing a given source file so TODO comments emitted deep in
// emitStmt/emitExpr can report where in the original .ts they came from.
let currentFile = '';
let currentSrcLines = [];

function loc(node) {
  if (!node?.loc) return '';
  const line = node.loc.start.line;
  const text = (currentSrcLines[line - 1] || '').trim().slice(0, 80);
  return ` [${currentFile}:${line}: ${text}]`;
}

// C reserved words that can't be used as identifiers
const cKeywords = new Set([
  'signed',
  'unsigned',
  'register',
  'volatile',
  'const',
  'auto',
  'static',
  'extern',
  'inline',
  'restrict',
  'struct',
  'union',
  'enum',
  'typedef',
  'void',
  'char',
  'short',
  'int',
  'long',
  'float',
  'double',
  'default',
  'goto',
  'switch',
  'case',
  'break',
  'continue',
  'return',
  'if',
  'else',
  'for',
  'while',
  'do',
  'sizeof',
]);

// Rename TS identifiers that conflict with C keywords
const cName = (name) => (cKeywords.has(name) ? `${name}_` : name);

// TS built-in/utility types that carry no real field/method shape of their own — they
// always resolve to void* (see cTypeOf below) and property access on them (`args.foo`
// where `args: Record<string, unknown>`) has no struct to bind to. Shared with
// emitExpr's MemberExpression handling, which needs to stub such access the same way it
// already stubs interface-property access, rather than falling through to a blind
// `->field` on what compiles down to a void*.
const OPAQUE_DYNAMIC_TYPES = new Set([
  'Promise',
  'Record',
  'Map',
  'Set',
  'WeakMap',
  'WeakSet',
  'LogLevel',
  'Logger',
  'DataView',
  'Function',
  'Error',
  'TypeError',
  'RangeError',
  'Date',
  'RegExp',
  'Symbol',
  'Iterator',
  'Generator',
  'ArrayBuffer',
  'SharedArrayBuffer',
  'Socket',
  'Server',
  'ReadableStream',
  'WritableStream',
  'AbortSignal',
  'ReturnType',
  'Partial',
  'Required',
  'Readonly',
  'Pick',
  'Omit',
  'Exclude',
  'Extract',
  'Parameters',
  'InstanceType',
  'Awaited',
  'NodeJS',
]);

const cTypeOf = (tsType, opts = {}) => {
  if (!tsType) return 'int32_t';
  // babel AST: typeAnnotation is wrapped in TSTypeAnnotation
  let inner = tsType;
  if (inner.type === 'TSTypeAnnotation') inner = inner.typeAnnotation;
  // `(A | B)[]` — babel preserves the disambiguating parens as their own node
  // (distinct from the unparenthesized `A | B[]`, which means something else) —
  // transparent for our purposes, just unwrap to what's actually inside.
  while (inner?.type === 'TSParenthesizedType') inner = inner.typeAnnotation;
  if (!inner) return 'int32_t';

  switch (inner.type) {
    case 'TSNumberKeyword':
      return 'int32_t';
    case 'TSBooleanKeyword':
      return 'bool';
    case 'TSStringKeyword':
      return 'const char*';
    case 'TSVoidKeyword':
      return 'void';
    case 'TSUndefinedKeyword':
      return 'void';
    case 'TSNullKeyword':
      return 'void*';
    case 'TSAnyKeyword':
      return 'void*';
    // String/number/boolean literal types (e.g. `'hex' | 'uf2'`, a common enum-like
    // pattern) — resolve to the C type of the literal itself, matching what call sites
    // actually pass. Without this, `ext: 'hex' | 'uf2'` fell through to the generic
    // 'int32_t' default while every call site legitimately passes a string literal.
    case 'TSLiteralType': {
      const lit = inner.literal;
      if (lit?.type === 'StringLiteral') return 'const char*';
      if (lit?.type === 'BooleanLiteral') return 'bool';
      return 'int32_t';
    }
    // number[] → int32_t* (TS array shorthand)
    case 'TSArrayType': {
      const elemCType = cTypeOf(inner.elementType, opts);
      return `${elemCType}*`;
    }
    // [T, T, ...] → T* (tuple → array of first element type)
    case 'TSTupleType': {
      if (inner.elementTypes?.length > 0) {
        const elemCType = cTypeOf(inner.elementTypes[0]);
        return `${elemCType}*`;
      }
      return 'void*';
    }
    // X | null / X | undefined → same C type as X (null/undefined both collapse to a
    // null pointer, which is what `X | null`-typed fields are almost always used for —
    // e.g. `next: ClockAlarm | null = null`). Falls back to void* only when every
    // member is null/undefined, or the non-nullish members disagree on C type.
    case 'TSUnionType': {
      const meaningful = inner.types.filter(
        (t) => t.type !== 'TSNullKeyword' && t.type !== 'TSUndefinedKeyword'
      );
      if (meaningful.length === 0) return 'void*';
      const resolved = new Set(meaningful.map((t) => cTypeOf(t, opts)));
      if (resolved.size === 1) return [...resolved][0];
      // `SomeEnum | number` (e.g. `bRequest: SetupRequest | number` — "a standard enum
      // value, or a raw class/vendor-specific request code") — an enum member IS a
      // plain int in C, so int32_t is a safe common representation for the whole union,
      // same as the field would need if it only ever held numbers.
      if ([...resolved].every((t) => t === 'int32_t' || enums.has(t))) return 'int32_t';
      return 'void*';
    }
    // { [index: number]: T } → T* (index signature, same shape as an array)
    // { a: T; b: U } → anonymous struct, stub as void*
    case 'TSTypeLiteral': {
      const indexSig = inner.members?.find((m) => m.type === 'TSIndexSignature');
      if (indexSig) return `${cTypeOf(indexSig.typeAnnotation, opts)}*`;
      return 'void*';
    }
    // TSTypeReference: named type (class, enum, interface, type alias)
    case 'TSTypeReference': {
      const name = inner.typeName?.name;
      if (!name) return 'void*';
      // Generic type parameters → resolve to concrete RP2350 (ChipType extends
      // IRPChip defaults to IRPChip, but for transpilation we always target
      // RP2350). While collecting/emitting one specific monomorphized instantiation
      // of a ChipType-generic free function (see "ChipType monomorphization"
      // above), currentChipTypeOverride names the concrete type for THIS
      // instantiation and takes priority over both defaults below.
      if (name === 'ChipType') {
        if (currentChipTypeOverride) return `${currentChipTypeOverride}*`;
        return opts.genericAsVoidStar ? 'void*' : 'RP2350*';
      }
      // `Uint32` (src/utils/types.ts) marks a value that's ALWAYS a genuine unsigned
      // 32-bit quantity (e.g. a memory address), unlike the far more common `number`
      // which only gets `>>> 0`'d at individual use sites. Emitting uint32_t instead of
      // int32_t gives relational comparisons real unsigned semantics for free, instead
      // of a large address silently comparing as negative above 0x7fffffff.
      if (name === 'Uint32') return 'uint32_t';
      // `Float32` (src/utils/types.ts) marks a value that's ALWAYS a genuine binary32
      // float — see its own comment. Without this, a plain `number` parameter/field
      // holding a value that's actually float32 (e.g. fpu-helpers.ts's a/b/addend,
      // FpResult.value) defaults to int32_t, truncating it before any arithmetic runs.
      if (name === 'Float32') return 'float';
      // `Float64` (src/utils/types.ts) — same reasoning as Float32 above, for a value
      // that's always a genuine binary64 double (e.g. DCP coprocessor operands).
      if (name === 'Float64') return 'double';
      // `Int53` (src/utils/types.ts) — a value that can exceed int32 range but stays
      // within JS's exact-integer-safe range (e.g. a nanosecond-scale clock counter).
      // Without this, a plain `number` field/param/return carrying such a value
      // silently truncates to int32_t, wrapping (UB on signed overflow) far sooner
      // than the real JS value ever would.
      if (name === 'Int53') return 'int64_t';
      // Named function type (gpio-pin.ts), emitted as a typedef by emitAllEnums.
      if (name === 'GPIOPinListener') return 'GPIOPinListener';
      // TypedArrays → C pointer types
      if (name.match(/^(Int|Uint|Float)(8|16|32|53|64)Array$/)) return `${typedArrayCType(name)}*`;
      // Array<T> / ArrayLike<T> → T* (resolve type parameter) — ArrayLike is only ever
      // used here for numeric indexing over a real array, same as Array<T>.
      if (name === 'Array' || name === 'ArrayLike') {
        const typeParam = inner.typeParameters?.params?.[0];
        if (typeParam) {
          const elemType = cTypeOf(typeParam);
          return `${elemType}*`;
        }
        return 'void*';
      }
      // TS built-in types that don't map to C → void*
      if (OPAQUE_DYNAMIC_TYPES.has(name)) return 'void*';
      if (classes.has(name)) return `${name}*`;
      if (enums.has(name)) return name;
      // Pure-data interfaces (only property signatures, no methods) get rewritten to
      // void* by normalizePureDataInterfaces() once every file has been collected —
      // doing it here inline would be order-dependent (this interface's OWN members
      // may not be collected yet if its declaring file sorts after the current one in
      // the directory walk, and an empty placeholder Map would look "pure" vacuously).
      if (interfaces.has(name)) return name;
      if (typeAliases.has(name)) return typeAliases.get(name);
      if (name === 'number') return 'int32_t';
      if (name === 'boolean') return 'bool';
      if (name === 'string') return 'const char*';
      // Unknown named type — assume it's a class pointer
      return `${name}*`;
    }
    // Function-typed field/param (e.g. `transferFn: () => void`, a runtime-swappable
    // "strategy function" reassigned to one of several bound-method values) — C has no
    // function-VALUE type distinct from a plain pointer; void* matches the same
    // fallback bound-method-reference fields already get (see the "Object reference"
    // catch-all elsewhere), so an assignment from one of those isn't a type mismatch.
    case 'TSFunctionType':
      return 'void*';
    default:
      return 'int32_t';
  }
};

// A class field holding a function value (`onWatchdogTrigger = () => {...}`,
// `onTrace: (core: number, pc: number, tag: string) => void`) — a user-overridable
// callback hook, not a fixed method. C has no closures, so it becomes TWO struct
// members: a plain function pointer (first param is an opaque context, standing in
// for the closure's captured `this`) plus a `void*` holding that context. See
// emitFieldInitializers (default-initializer case) and the AssignmentExpression/
// CallExpression handling (cross-instance override + invocation) for how the two
// members get populated and called through.
function buildClosureFieldInfo(className, fname, paramNodes, returnTypeAnnotation) {
  const paramTypes = (paramNodes || []).map((p) => cTypeOf(p.typeAnnotation));
  const retType = returnTypeAnnotation ? cTypeOf(returnTypeAnnotation) : 'void';
  return {
    type: `${className}_${fname}_Fn`,
    kind: 'closure',
    paramTypes,
    retType,
    fnTypeName: `${className}_${fname}_Fn`,
    fnField: `${cName(fname)}_fn`,
    ctxField: `${cName(fname)}_ctx`,
  };
}

// Babel decodes string-literal escapes into real characters (node.value has an actual
// newline for `'\n'`, an actual quote for `'\"'`, etc.) — re-escape for a C string
// literal, or a raw newline/quote/backslash in the source breaks the C literal itself
// ("missing terminating \" character").
// Remaining control characters use a THREE-digit octal escape rather than `\0`/`\xNN`:
// both of those are greedy in C, so a NUL followed by a literal '7' emitted as `\07`
// silently becomes one character (octal 7, BEL) instead of two. `\NNN` is capped at
// exactly three digits, so it can never absorb a following digit. This also covers the
// escapes previously missed entirely (\b \f \v \a and friends), which Babel decodes to
// raw control bytes.
const cStringEscape = (s) =>
  s
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t')
    .replace(/[\x00-\x1f\x7f]/g, (c) => `\\${c.charCodeAt(0).toString(8).padStart(3, '0')}`);

// Every `/* TODO: ... */` marker below stands for a TS construct cts2c can't translate.
// Rather than silently falling back to `0`/`NULL` (compiles clean, produces a wrong
// answer with no warning), these print what's unsupported and abort() immediately.
//
// `stubAbortExpr` is for EXPRESSION position: wrapped in `__extension__` (a GNU
// statement-expression, same idiom used elsewhere in this file) so it type-checks as a
// value anywhere; the trailing `0` is unreachable (abort() never returns) but still
// needed for a well-typed empty case.
//
// A bare `0` is a null-pointer constant valid in any pointer context with no cast, but
// a computed expression that merely evaluates to zero is not — a caller that knows its
// target C type should route through `castStubForType` below instead of relying on this.
const STUB_ABORT_MARKER = 'cts2c: unsupported';
function stubAbortExpr(label) {
  return `(__extension__({ fprintf(stderr, "${STUB_ABORT_MARKER}: %s\\n", "${cStringEscape(
    label
  )}"); abort(); 0; }))`;
}

// `stubAbortStmt` is for STATEMENT position (a whole line, not a value) — no
// statement-expression wrapper needed, just the two C statements directly.
function stubAbortStmt(label) {
  return `fprintf(stderr, "${STUB_ABORT_MARKER}: %s\\n", "${cStringEscape(label)}"); abort();`;
}

// Wrap `exprStr` in an explicit cast to `targetType`, but ONLY if it's actually one of
// our abort stubs (detected via the marker text) — an explicit cast silences the
// pointer/integer type-mismatch warning a bare stub value would otherwise hit (see
// stubAbortExpr's own comment), and is a no-op for any expression that already type-
// checks correctly on its own. Call this at any site that already knows its own target
// C type when consuming an `emitExpr` result — field initializers, variable
// declarations, return statements, call arguments — rather than trying to guess a
// fixed type inside `stubAbortExpr` itself, which is wrong as often as it's right.
function castStubForType(exprStr, targetType) {
  if (!targetType || typeof exprStr !== 'string' || !exprStr.includes(STUB_ABORT_MARKER))
    return exprStr;
  return `((${targetType})(${exprStr}))`;
}

// A default-valued param with no type annotation (`padChar = ' '`) still needs a real C
// type — without this, every such param silently defaulted to int32_t regardless of
// what kind of literal the default actually was, and the emitted default-arg fallback
// value (used when a caller omits the arg) only ever handled NumericLiteral, silently
// producing `0` for a string/boolean default too.
function literalDefaultInfo(node) {
  if (!node) return null;
  if (node.type === 'NumericLiteral') return { type: 'int32_t', defaultStr: String(node.value) };
  if (node.type === 'StringLiteral')
    return { type: 'const char*', defaultStr: `"${cStringEscape(node.value)}"` };
  if (node.type === 'BooleanLiteral')
    return { type: 'bool', defaultStr: node.value ? 'true' : 'false' };
  return null;
}

const typedArrayCType = (name) => {
  switch (name) {
    case 'Int32Array':
      return 'int32_t';
    case 'Uint32Array':
      return 'uint32_t';
    case 'Int16Array':
      return 'int16_t';
    case 'Uint16Array':
      return 'uint16_t';
    case 'Int8Array':
      return 'int8_t';
    case 'Uint8Array':
      return 'uint8_t';
    case 'Float32Array':
      return 'float';
    case 'Float64Array':
      return 'double';
    case 'Int53Array':
      // Float64-backed in JS (holds integers up to 2^53), uint64_t in C — native
      // 64-bit pack/unpack via the int53High/int53Pack intrinsics (see below).
      return 'uint64_t';
    default:
      return 'uint8_t';
  }
};

// ─── Pass 0: Pre-register all type names ─────────────────────────────
function preRegisterTypes(filepath) {
  const src = readSourceFile(filepath);
  const ast = parser.parse(src, {
    sourceType: 'module',
    plugins: ['typescript'],
    ranges: false,
    loc: false,
  });

  for (const node of ast.program.body) {
    // `import * as fpu from './fpu-helpers'` — track the local binding name so
    // `fpu.SOME_EXPORTED_CONST` (a real, already-hoisted global) can resolve to the
    // bare constant instead of a raw (undeclared) `fpu->SOME_EXPORTED_CONST`.
    if (node.type === 'ImportDeclaration') {
      for (const spec of node.specifiers) {
        if (spec.type === 'ImportNamespaceSpecifier') namespaceImports.add(spec.local.name);
      }
    }

    let n = node;
    if (n.type === 'ExportNamedDeclaration') n = n.declaration;
    if (!n) continue;

    if (n.type === 'ClassDeclaration' && n.id?.name) {
      // Register class name with empty data (filled in collectTypes)
      if (!classes.has(n.id.name))
        classes.set(n.id.name, {
          fields: new Map(),
          methods: new Map(),
          getters: new Map(),
          setters: new Map(),
          parent: null,
          isBase: true,
          implements: new Set(),
        });
    }
    if (n.type === 'TSInterfaceDeclaration' && n.id?.name) {
      if (!interfaces.has(n.id.name)) interfaces.set(n.id.name, new Map());
    }
    if (n.type === 'TSEnumDeclaration' && n.id?.name) {
      if (!enums.has(n.id.name)) enums.set(n.id.name, new Map());
    }
    if (n.type === 'TSTypeAliasDeclaration' && n.id?.name) {
      if (!typeAliases.has(n.id.name)) typeAliases.set(n.id.name, 'void*');
    }
    if (n.type === 'VariableDeclaration') {
      for (const decl of n.declarations) {
        const declName = decl.id?.name;
        const initType = decl.init?.type;
        if (
          declName &&
          (initType === 'NumericLiteral' ||
            initType === 'BinaryExpression' ||
            initType === 'UnaryExpression')
        ) {
          scalarConstNames.add(declName);
        }
      }
    }
  }
}

// ─── Pass 1.5: rewrite pure-data interface references to void* ──────
// Must run only after every file has been through collectTypes(), so each interface's
// member list is final (a "pure data" verdict based on a still-empty placeholder Map
// would be vacuously — and wrongly — true for any real behavioral interface).
function normalizePureDataInterfaces() {
  const pureDataNames = new Set();
  for (const [name, members] of interfaces) {
    if (members.size > 0 && [...members.values()].every((m) => m.isProperty))
      pureDataNames.add(name);
  }
  if (pureDataNames.size === 0) return;

  // A pure-data interface (only property signatures, no methods — e.g.
  // LoadFirmwareOptions, M33CoreState) isn't a real vtable-dispatch type: there's
  // nothing to call through, it's just a plain data shape. Register it as a synthetic
  // class instead of a real interface, so it gets an actual struct with real typed
  // fields, and every existing class-pointer code path (field access via `->`,
  // `classes.has()` checks, struct emission) just works — instead of being forced
  // through the interface machinery (a vtable it doesn't need, or a bare/void* type
  // that can't have its fields accessed at all).
  for (const name of pureDataNames) {
    const members = interfaces.get(name);
    const fields = new Map();
    for (const [propName, msig] of members)
      fields.set(propName, { type: msig.retType, tsType: msig.tsType });
    classes.set(name, {
      fields,
      methods: new Map(),
      getters: new Map(),
      setters: new Map(),
      parent: null,
      isBase: true,
      implements: new Set(),
    });
    interfaces.delete(name);
  }

  // Every field/param/retType computed before this pass ran still holds the bare
  // interface name (cTypeOf defers the pure-data verdict to right here) — rewrite
  // those to the pointer type now that the synthetic class above exists. Also handles
  // `Name*` (one star): an array-of-this-interface field computed before the flip
  // (e.g. `mpuRegions: RegionPair[]`) used the "array of value-type interface" single-
  // star convention (cTypeOf saw a plain interface, not yet a class) — bump it to the
  // "array of class pointers" double-star convention every other class array uses, or
  // downstream `->` field access on the (now-bare, now-a-value) element type breaks.
  const fix = (t) => {
    if (pureDataNames.has(t)) return `${t}*`;
    if (t.endsWith('*') && pureDataNames.has(t.slice(0, -1))) return `${t}*`;
    return t;
  };
  const fixParams = (params) => {
    for (const p of params) p.type = fix(p.type);
  };

  for (const cls of classes.values()) {
    for (const field of cls.fields.values()) field.type = fix(field.type);
    for (const msig of cls.methods.values()) {
      fixParams(msig.params);
      msig.retType = fix(msig.retType);
    }
    for (const sig of cls.getters?.values() ?? []) sig.retType = fix(sig.retType);
    for (const sig of cls.setters?.values() ?? []) sig.paramType = fix(sig.paramType);
  }
  for (const fn of freeFunctions.values()) {
    fixParams(fn.params);
    fn.retType = fix(fn.retType);
  }
  for (const fn of arrowFunctions.values()) {
    fixParams(fn.params);
    fn.retType = fix(fn.retType);
  }
  for (const methods of interfaces.values()) {
    for (const msig of methods.values()) {
      if (msig.params) fixParams(msig.params);
      if (msig.retType) msig.retType = fix(msig.retType);
    }
  }
}

// A getter's return-type inference (see collectTypes's ClassMethod 'get' handling)
// runs DURING per-file collection, so a `return this.field1.field2;` shape (e.g.
// cortex-m33/core.ts's `get logger() { return this.chip.logger; }`) can fail to
// resolve purely because field1's class hasn't been collected yet — collectTypes
// processes files in directory order, not dependency order. Marked `unresolved` at
// collection time rather than guessed; this pass re-attempts inference for every such
// getter once every file (and therefore every class's fields) is fully collected, when
// the same lookup should now succeed. Must run before normalizePureDataInterfaces, so
// a freshly-resolved type that happens to be a pure-data interface still gets that
// fixup applied too.
function resolveUnresolvedGetterTypes() {
  for (const cls of classes.values()) {
    for (const [propName, sig] of cls.getters) {
      if (!sig.unresolved) continue;
      const inferred = inferReturnTypeFromReturns(sig.node.body, {}, sig.className);
      if (inferred) {
        sig.retType = inferred;
        sig.unresolved = false;
        const field = cls.fields.get(propName);
        if (field?.isGetter) field.type = inferred;
      }
    }
  }
}

// A class with no own `constructor` member (relies on the implicit inherited default
// constructor — e.g. `class UnimplementedPeripheral extends BasePeripheral {}`) has no
// `methods.get('constructor')` entry, since collectTypes only looks at each class's own
// body. Climb the parent chain (fully collected by the time this runs) to the nearest
// ancestor with a real constructor and adopt its signature, marked `inherited: true` so
// emitClassImpl knows to synthesize a wrapper body (there's no ClassMethod AST node for
// it to emit from) instead of looking one up.
function resolveMissingConstructors() {
  for (const [className, cls] of classes) {
    if (cls.methods.get('constructor')) continue;
    let cur = cls.parent;
    while (cur) {
      const parentCls = classes.get(cur);
      if (!parentCls) break;
      const sig = parentCls.methods.get('constructor');
      if (sig) {
        cls.methods.set('constructor', {
          params: sig.params,
          retType: `${className}*`,
          isConstructor: true,
          inherited: true,
        });
        break;
      }
      cur = parentCls.parent;
    }
  }
}

// Whether any OTHER class extends `className` — i.e. whether calling `this.method()`
// from WITHIN a method defined on `className` could possibly need real (subclass-
// overridden) dispatch at all. A leaf class (no subclasses — e.g. RP2350 itself,
// never further extended) calling its OWN method on itself has no polymorphism
// ambiguity: `this.stepCores()` inside RP2350's own code always means RP2350's own
// stepCores, identically whether resolved statically or through a vtable — except the
// vtable route only has the INTERFACE's own (sometimes deliberately looser — e.g.
// IRPChip's `stepCores(): void` vs RP2350's actual `stepCores(): number`) signature to
// work with, a real mismatch for a call site using the class's own fuller signature.
// Gates assignInterfaceSelfVtableFields's call-site rewrite to only the classes where
// it's actually needed (has subclasses) AND safe (this class's own usage of its
// methods never needs the interface's possibly-narrower signature).
function classHasSubclasses(className) {
  for (const cls of classes.values()) {
    if (cls.parent === className) return true;
  }
  return false;
}

// The topmost ancestor (inclusive) of `className` that still implements `ifaceName` —
// i.e. the class whose OWN struct declares the stored self-vtable field for this
// interface (see assignInterfaceSelfVtableFields). Every class implementing an
// interface at any depth shares the SAME stored field, declared once on this root, so
// `self->method()` calls made from a shared ancestor method (e.g. peripheral.ts's
// BasePeripheral.writeUint32Atomic calling `this.writeUint32(...)`) can look it up via
// a fixed, known path regardless of which concrete subclass actually set it last.
function findInterfaceRootClass(className, ifaceName) {
  let root = className;
  let cur = classes.get(className);
  while (cur?.parent && getImplementedInterfaces(cur.parent).has(ifaceName)) {
    root = cur.parent;
    cur = classes.get(cur.parent);
  }
  return root;
}

// A class instance has no stored record of its own most-derived type or vtable — the
// {obj, vtable} fat-pointer convention only exists once an instance is BOXED into an
// interface value. That's fine for external calls through the boxed value (already
// virtual via findMethodDefiningClass), but breaks `this.method()` calls made from
// WITHIN a shared ancestor method when `method` is overridden by the actual concrete
// subclass: emitExpr's "this.method()" codegen has no way to know self's real subclass
// there, so it would emit a static call to whichever class the calling code is
// lexically defined in instead of the real override.
//
// Fixed like a real vtable-based language would: give every interface's ROOT
// implementer (see findInterfaceRootClass) a stored `const <Iface>VTable*` field,
// written by EVERY class in the hierarchy's own constructor with ITS OWN concrete
// vtable. The leaf class's constructor always runs last (after super()/parent setup),
// so by the time any real post-construction call happens, the field holds the true
// most-derived class's vtable regardless of which ancestor's method body is calling.
function assignInterfaceSelfVtableFields() {
  for (const [className] of classes) {
    for (const iface of getImplementedInterfaces(className)) {
      const root = findInterfaceRootClass(className, iface);
      const rootCls = classes.get(root);
      const fieldName = `__vtable_${iface}`;
      if (!rootCls.fields.has(fieldName)) {
        rootCls.fields.set(fieldName, {
          type: `const ${iface}VTable*`,
          isInterfaceSelfVtable: true,
        });
      }
    }
  }
}

// When a function/method has no explicit return-type annotation, see if every return
// statement's argument agrees on a real type — `new Foo(...)` for a known class, or a
// bare identifier that's one of the function's own params with a known type — instead
// of leaving the default int32_t (which every caller assigning the result to a
// properly-typed variable/field then has to fight). Returns null if no single type can
// be inferred (mixed return shapes, no returns, etc.) — caller keeps its own default.
// Does `node` (a CallExpression) resolve to a known method/free-function whose own
// declared return type is void? Used by the ReturnStatement handling below for the
// `return voidCall();` early-return idiom.
function isVoidReturningCall(node, ctx) {
  if (node?.type !== 'CallExpression') return false;
  if (node.callee?.type === 'MemberExpression') {
    const methodName = node.callee.property?.name;
    const objType =
      node.callee.object?.type === 'ThisExpression'
        ? ctx?.className
        : resolveExprType(node.callee.object, ctx);
    let cls = objType ? classes.get(objType) : null;
    while (cls) {
      const msig = cls.methods?.get(methodName);
      if (msig) return msig.retType === 'void';
      cls = cls.parent ? classes.get(cls.parent) : null;
    }
    return false;
  }
  if (node.callee?.type === 'Identifier') {
    return freeFunctions.get(node.callee.name)?.retType === 'void';
  }
  return false;
}

// Does any `return` statement in this function body satisfy `pred`? Nested
// functions/arrows are not descended into — they have their own return type, so their
// returns say nothing about this one's. Replaces three near-verbatim copies of this walk
// (hasBareReturn/hasAnyReturn were duplicated between collectFreeFunctionSignature and
// collectTypes's ClassMethod handling, plus hasValueReturn in the local-arrow handler).
function anyReturn(node, pred) {
  if (!node || typeof node !== 'object') return false;
  if (node.type === 'ReturnStatement') return pred(node);
  if (
    node.type === 'FunctionDeclaration' ||
    node.type === 'FunctionExpression' ||
    node.type === 'ArrowFunctionExpression'
  )
    return false;
  for (const k in node) {
    if (k === 'loc' || k === 'start' || k === 'end' || k === 'range') continue;
    const v = node[k];
    if (Array.isArray(v)) {
      for (const x of v) if (anyReturn(x, pred)) return true;
    } else if (v && typeof v === 'object' && v.type) {
      if (anyReturn(v, pred)) return true;
    }
  }
  return false;
}
const hasBareReturn = (node) => anyReturn(node, (r) => !r.argument);
const hasAnyReturn = (node) => anyReturn(node, () => true);
const hasValueReturn = (node) => anyReturn(node, (r) => !!r.argument);

function inferReturnTypeFromReturns(body, paramTypesByName, selfClassName) {
  const returnArgTypes = new Set();
  let sawReturn = false;
  // A function often returns a local variable by name rather than a fresh `new X()`
  // directly (`const buf = new Uint8Array(8); ...; return buf;`) — paramTypesByName
  // only ever covered the function's own PARAMS, so this kind of return fell through
  // to `returnArgTypes.add(null)` (unresolvable) every time. Do a first pass collecting
  // simple `const/let NAME = new X(...)` local declarations (class or typed array) so
  // the Identifier-return case below can resolve those too.
  const localVarTypes = {};
  const collectLocals = (node) => {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'VariableDeclaration') {
      for (const decl of node.declarations) {
        const declName = decl.id?.name;
        if (!declName) continue;
        if (decl.init?.type === 'NewExpression') {
          const ctor = decl.init.callee?.name;
          if (ctor && classes.has(ctor)) localVarTypes[declName] = `${ctor}*`;
          else if (ctor?.match(/^(Int|Uint|Float)(8|16|32|53|64)Array$/))
            localVarTypes[declName] = `${typedArrayCType(ctor)}*`;
        } else if (decl.init?.type === 'TSAsExpression') {
          // `const x = expr as unknown as ClassName;` — a common pattern for
          // reaching a concrete class through a generic/interface-typed value.
          const castType =
            decl.init.typeAnnotation?.typeName?.name ??
            decl.init.typeAnnotation?.typeAnnotation?.typeName?.name;
          if (castType && classes.has(castType)) localVarTypes[declName] = `${castType}*`;
        }
      }
    }
    if (
      node.type === 'FunctionDeclaration' ||
      node.type === 'FunctionExpression' ||
      node.type === 'ArrowFunctionExpression'
    )
      return;
    for (const k in node) {
      if (k === 'loc' || k === 'start' || k === 'end' || k === 'range') continue;
      const v = node[k];
      if (Array.isArray(v)) v.forEach(collectLocals);
      else if (v && typeof v === 'object' && v.type) collectLocals(v);
    }
  };
  collectLocals(body);
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'ReturnStatement' && node.argument) {
      sawReturn = true;
      const arg = node.argument;
      if (arg.type === 'NewExpression' && classes.has(arg.callee?.name)) {
        returnArgTypes.add(`${arg.callee.name}*`);
      } else if (arg.type === 'Identifier' && paramTypesByName?.[arg.name]) {
        returnArgTypes.add(paramTypesByName[arg.name]);
      } else if (arg.type === 'Identifier' && localVarTypes[arg.name]) {
        returnArgTypes.add(localVarTypes[arg.name]);
      } else if (
        arg.type === 'CallExpression' &&
        arg.callee?.type === 'Identifier' &&
        freeFunctions.get(arg.callee.name)?.retType &&
        freeFunctions.get(arg.callee.name).retType !== 'int32_t' &&
        freeFunctions.get(arg.callee.name).retType !== 'void'
      ) {
        // `return otherFn(...)` — passthrough of another already-collected free
        // function's return type (only meaningful when that function is declared
        // earlier in the same file, since collection is a single top-to-bottom pass).
        returnArgTypes.add(freeFunctions.get(arg.callee.name).retType);
      } else if (
        arg.type === 'MemberExpression' &&
        !arg.computed &&
        arg.object?.type === 'Identifier' &&
        localVarTypes[arg.object.name]?.endsWith('*')
      ) {
        // `return localVar.field;` where localVar's class was resolved above (e.g. via
        // an `as unknown as ClassName` cast) — look up the field's own type on that class.
        const objClass = localVarTypes[arg.object.name].slice(0, -1);
        let cls = classes.get(objClass);
        while (cls) {
          const field = cls.fields?.get(arg.property?.name);
          if (field) {
            returnArgTypes.add(field.type);
            break;
          }
          cls = cls.parent ? classes.get(cls.parent) : null;
        }
        if (!cls) returnArgTypes.add(null);
      } else if (
        arg.type === 'MemberExpression' &&
        !arg.computed &&
        arg.object?.type === 'MemberExpression' &&
        !arg.object.computed &&
        arg.object.object?.type === 'ThisExpression' &&
        selfClassName
      ) {
        // `return this.field1.field2;` (e.g. cortex-m33/core.ts's `get logger() {
        // return this.chip.logger; }`) — resolve field1's own type on THIS class
        // (own fields first, then climb the parent chain, same as a plain `this.field1`
        // resolution would), then field2 on field1's class.
        const field1Name = arg.object.property?.name;
        let ownerCls = classes.get(selfClassName);
        let field1;
        while (ownerCls && !field1) {
          field1 = ownerCls.fields?.get(field1Name);
          ownerCls = ownerCls.parent ? classes.get(ownerCls.parent) : null;
        }
        const field1Class = field1?.type?.endsWith('*') ? field1.type.slice(0, -1) : null;
        let cls = field1Class ? classes.get(field1Class) : null;
        while (cls) {
          const field2 = cls.fields?.get(arg.property?.name);
          if (field2) {
            returnArgTypes.add(field2.type);
            break;
          }
          cls = cls.parent ? classes.get(cls.parent) : null;
        }
        // field1Class itself resolving is not guaranteed even when field1 (chip/
        // rp2040/etc.) is a known pointer field: collectTypes processes files in
        // directory order, not dependency order, so field1Class's OWN fields may not
        // be collected yet (only a Pass-0 name placeholder exists so far). Adding
        // `null` here (rather than guessing) is deliberate — a getter whose type is
        // still unresolved after this gets a second, later attempt once every class
        // is fully collected (see resolveUnresolvedGetterTypes, run as its own pass
        // after collectTypes finishes for every file).
        if (!cls) returnArgTypes.add(null);
      } else if (arg.type === 'TemplateLiteral' || arg.type === 'StringLiteral') {
        // `return \`${x} [${y}] ${z}\`;` / `return 'literal';` — an unannotated
        // function/method whose only return is a genuine string (e.g. logging.ts's
        // ConsoleLogger.formatMessage, time.ts's formatTime). Without this, retType
        // defaulted to int32_t, and TemplateLiteral's codegen — once it started
        // producing a real fmtStr()-built `const char*` instead of a stubbed `0` —
        // failed to compile: "returning 'const char *' from a function with return
        // type 'int32_t'".
        returnArgTypes.add('const char*');
      } else {
        returnArgTypes.add(null);
      }
    }
    if (
      node.type === 'FunctionDeclaration' ||
      node.type === 'FunctionExpression' ||
      node.type === 'ArrowFunctionExpression'
    )
      return;
    for (const k in node) {
      if (k === 'loc' || k === 'start' || k === 'end' || k === 'range') continue;
      const v = node[k];
      if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === 'object' && v.type) walk(v);
    }
  };
  walk(body);
  if (sawReturn && returnArgTypes.size === 1) {
    const only = [...returnArgTypes][0];
    if (only) return only;
  }
  return null;
}

// Compute a free function's { params, retType } signature from its declaration node.
// Extracted so ChipType monomorphization (see "ChipType monomorphization" above) can
// re-invoke this under currentChipTypeOverride to collect one concrete instantiation's
// signature, exactly the same way the normal (unspecialized) collection pass does.
function collectFreeFunctionSignature(fn) {
  const params = (fn.params || [])
    .filter(
      (p) =>
        p.type === 'Identifier' ||
        p.type === 'AssignmentPattern' ||
        p.type === 'TSParameterProperty'
    )
    .map((p) => {
      const realParam = p.type === 'TSParameterProperty' ? p.parameter : p;
      const isAssignment = realParam.type === 'AssignmentPattern';
      const pn = isAssignment ? realParam.left?.name : realParam.name;
      // AssignmentPattern's own typeAnnotation is never set — TS puts it on the LHS
      // identifier (realParam.left), not the pattern node itself.
      const anno = isAssignment ? realParam.left?.typeAnnotation : realParam.typeAnnotation;
      const litDefault = isAssignment ? literalDefaultInfo(realParam.right) : null;
      return {
        name: pn,
        type: anno ? cTypeOf(anno, { genericAsVoidStar: true }) : litDefault?.type ?? 'int32_t',
        tsType: anno?.typeAnnotation?.typeName?.name,
        default: litDefault?.defaultStr ?? '0',
      };
    });
  // Infer return type for free functions too
  let retType = 'int32_t';
  if (fn.returnType) {
    retType = cTypeOf(fn.returnType, { genericAsVoidStar: true });
  } else {
    if (hasBareReturn(fn.body) || !hasAnyReturn(fn.body)) retType = 'void';
    else {
      const paramTypesByName = Object.fromEntries(params.map((p) => [p.name, p.type]));
      const inferred = inferReturnTypeFromReturns(fn.body, paramTypesByName);
      if (inferred) retType = inferred;
    }
  }
  return { params, retType };
}

// ─── Pass 1: Collect types ──────────────────────────────────────────
function collectTypes(filepath) {
  const src = readSourceFile(filepath);
  const ast = parser.parse(src, {
    sourceType: 'module',
    plugins: ['typescript'],
    ranges: false,
    loc: true,
  });
  const relFile = path.relative(process.cwd(), filepath);

  for (const node of ast.program.body) {
    if (
      node.type === 'ClassDeclaration' ||
      (node.type === 'ExportNamedDeclaration' && node.declaration?.type === 'ClassDeclaration')
    ) {
      const cls = node.type === 'ClassDeclaration' ? node : node.declaration;
      const name = cls.id?.name;
      if (!name) continue;
      const declSite = cls.loc ? `${relFile}:${cls.loc.start.line}` : relFile;

      const fields = new Map();
      const methods = new Map();
      // Real getter/setter bodies (see the ClassMethod 'get'/'set' handling below) —
      // separate from `methods` so a class's own regular method of the same name
      // (unlikely but possible) can't collide, and so emission/call-site code can ask
      // "does this property have a real getter/setter" without scanning `methods` for
      // a naming convention.
      const getters = new Map();
      const setters = new Map();
      let parent = null;
      const impls = new Set();

      if (cls.superClass?.name) {
        parent = cls.superClass.name;
      } else if (cls.superClass) {
        // A superClass node that isn't a plain Identifier means the parent link would be
        // silently dropped: the struct loses its embedded `base` member and every
        // inherited field access breaks, tens of confusing gcc errors away from the cause.
        // @babel/parser before 7.29.8 hit this on any generic `extends Foo<T>` followed by
        // a newline, mis-parsing it as a TSInstantiationExpression (hence the ^7.29.8
        // floor in package.json). Fail loudly rather than emit a wrongly-parentless class.
        throw new Error(
          `${filepath}:${cls.loc?.start.line}: class ${cls.id?.name ?? '<anonymous>'} has an ` +
            `unrecognized superClass node (${cls.superClass.type}), so its parent link would ` +
            `be lost. If this is a generic 'extends Foo<T>', check that @babel/parser is ` +
            `>= 7.29.8 (resolved: ${require('@babel/parser/package.json').version}).`
        );
      }
      if (cls.implements)
        for (const impl of cls.implements) {
          if (impl.expression?.name) impls.add(impl.expression.name);
        }

      for (const member of cls.body.body) {
        if (member.type === 'ClassProperty' || member.type === 'ClassPrivateProperty') {
          const fname = member.key?.name;
          if (!fname || member.static) continue;
          // Determine field type
          if (member.typeAnnotation) {
            let inner = member.typeAnnotation;
            if (inner.type === 'TSTypeAnnotation') inner = inner.typeAnnotation;
            const tsTypeName = inner.typeName?.name;
            // User-overridable callback field (`onTrace: (core: number, ...) => void`,
            // `onEndpointWrite?: (endpoint: number, buffer: Uint8Array) => void`) — see
            // buildClosureFieldInfo for how this becomes a real, callable representation
            // instead of the generic TSFunctionType → void* fallback in cTypeOf.
            if (inner.type === 'TSFunctionType') {
              fields.set(
                fname,
                buildClosureFieldInfo(name, fname, inner.parameters, inner.typeAnnotation)
              );
            }
            // Check for typed arrays
            else if (
              inner.type === 'TSTypeReference' &&
              tsTypeName?.match(/^(Int|Uint|Float)(8|16|32|53|64)Array$/)
            ) {
              const taName = tsTypeName;
              fields.set(fname, {
                type: `${typedArrayCType(taName)}*`,
                isTypedArray: true,
                taType: taName,
                tsType: taName,
              });
            } else {
              // Array-shaped field (number[], Array<T>, or { [index: number]: T }): the C
              // type is "element*", so callers must not strip the trailing "*" and treat
              // that as "pointer to a single element" (see resolveExprType) — mark it
              // explicitly.
              // `TSTupleType` (`readonly sioCore: [RPSIOCore, RPSIOCore];`) compiles to
              // the same "element*" shape as `T[]` (see cTypeOf's own TSTupleType
              // case) but was missing here — without `isArray`, a constructor's
              // `this.sioCore = [new RPSIOCore(...), new RPSIOCore(...)];` never
              // matched emitStmt's array-of-`new`-instances codegen (which requires
              // `field.isArray`), silently falling through to a stubbed `0`.
              const isArrayShaped =
                inner.type === 'TSArrayType' ||
                inner.type === 'TSTupleType' ||
                (inner.type === 'TSTypeLiteral' &&
                  inner.members?.some((m) => m.type === 'TSIndexSignature')) ||
                (inner.type === 'TSTypeReference' && tsTypeName === 'Array');
              // For Array<RPPIO>, tsTypeName above is "Array" itself (the outer generic's
              // own name, from inner.typeName.name) — not the element type, and not a
              // resolvable class/enum/interface. resolveExprType's field-lookup branches
              // check `field.tsType` *before* `field.isArray`, so leaving it set to "Array"
              // would short-circuit ahead of the array handling and collapse bare
              // (non-indexed) field access to a bogus "Array" type instead of leaving it
              // array-shaped — same class of bug as the array-of-class-instances fix above.
              // A fixed-length array-literal initializer (`readonly qspi: Array<GPIOPin> =
              // [new GPIOPin(...), ...]`) has a compile-time-known element count — track
              // it as a `sizeNode` (a synthesized NumericLiteral) the same way a `new
              // X(N)` typed-array/Array allocation already does, so `.length` on this
              // field (or a local destructured from it) resolves to the real count
              // instead of stubbing to 0.
              // An EMPTY array literal (`listeners: AlarmCallback[] = [];`) isn't a
              // fixed-size array at all — it's a growable one, only ever populated
              // later via `.push()`. Treating it as a real growable array (see
              // GROWABLE_ARRAY_CAPACITY) instead of a bogus sizeNode of 0 is what lets
              // `.push()`/`.length`/`for (const x of this.field)` on it actually work.
              const isEmptyArrayLiteral =
                member.value?.type === 'ArrayExpression' && member.value.elements.length === 0;
              const isGrowableArray = isArrayShaped && isEmptyArrayLiteral;
              const literalSizeNode =
                isArrayShaped && member.value?.type === 'ArrayExpression' && !isEmptyArrayLiteral
                  ? { type: 'NumericLiteral', value: member.value.elements.length }
                  : undefined;
              // `readonly gpio: Array<GPIOPin> = Array(48).fill(0).map((v, i) => new
              // GPIOPin(this, i));` — the "construct N instances" idiom (already given
              // real calloc-then-per-index codegen by emitFieldInitializers) has its own
              // compile-time-known count sitting in the `Array(N)` call, just one level
              // deeper than the plain array-literal case above. Without this, `.length`
              // on `gpio` (direct or destructured) stubbed to a bogus 0.
              const mapSizeArg = (() => {
                const v = member.value;
                if (
                  v?.type !== 'CallExpression' ||
                  v.callee?.type !== 'MemberExpression' ||
                  v.callee.property?.name !== 'map'
                )
                  return undefined;
                const fillCall = v.callee.object;
                if (
                  fillCall?.type !== 'CallExpression' ||
                  fillCall.callee?.type !== 'MemberExpression' ||
                  fillCall.callee.property?.name !== 'fill'
                )
                  return undefined;
                const arraySizeCall = fillCall.callee.object;
                if (
                  arraySizeCall?.type !== 'CallExpression' ||
                  arraySizeCall.callee?.type !== 'Identifier' ||
                  arraySizeCall.callee.name !== 'Array'
                )
                  return undefined;
                return arraySizeCall.arguments[0];
              })();
              const arraySizeNode = literalSizeNode ?? (isArrayShaped ? mapSizeArg : undefined);
              fields.set(fname, {
                type: cTypeOf(member.typeAnnotation),
                tsType: isArrayShaped ? undefined : tsTypeName,
                isArray: isArrayShaped,
                sizeNode: arraySizeNode,
                isGrowableArray,
                growableCapacity: isGrowableArray ? GROWABLE_ARRAY_CAPACITY : undefined,
              });
            }
          } else {
            // Infer from value
            if (member.value?.type === 'NewExpression') {
              const ctor = member.value.callee?.name;
              if (ctor?.match(/^(Int|Uint|Float)(8|16|32|53|64)Array$/)) {
                fields.set(fname, {
                  type: `${typedArrayCType(ctor)}*`,
                  isTypedArray: true,
                  taType: ctor,
                  isReadonly: !!member.readonly,
                  size: member.value.arguments?.[0]?.value,
                  sizeNode: member.value.arguments?.[0],
                });
              } else if (ctor === 'Array') {
                // new Array<T>(N) → T*
                const typeParam = member.value.typeParameters?.params?.[0];
                const ta =
                  typeParam?.typeName?.name ??
                  typeParam?.type?.replace('TS', '').replace('Keyword', '').toLowerCase();
                let elCType = 'int32_t';
                let elTsType = null;
                if (typeParam?.type === 'TSTypeReference' && ta) {
                  elTsType = ta;
                  elCType = classes.has(ta) ? `${ta}*` : enums.has(ta) ? ta : 'int32_t';
                } else if (typeParam?.type === 'TSNumberKeyword') {
                  elCType = 'int32_t';
                }
                fields.set(fname, {
                  type: `${elCType}*`,
                  size: member.value.arguments?.[0]?.value,
                  sizeNode: member.value.arguments?.[0],
                  tsType: elTsType,
                  isArray: true,
                });
              } else if (ctor && classes.has(ctor)) {
                fields.set(fname, { type: `${ctor}*` });
              } else if (ctor === 'DataView') {
                // `readonly usbDPRAMView = new DataView(this.usbDPRAM.buffer);` — a
                // byte-offset read/write view over an EXISTING typed array's backing
                // memory, not a fresh allocation. Once transpiled, a typed array is
                // already just a bare C pointer, so a DataView over its `.buffer` is
                // the exact same pointer, reinterpreted as raw bytes — tracked as
                // `uint8_t*` (rather than a fictitious "DataView*") specifically so
                // this field is indistinguishable from a plain byte array everywhere
                // EXCEPT the CallExpression case below, which special-cases the
                // getUint32/setUint32-style method names actually used on it.
                fields.set(fname, { type: 'uint8_t*', isDataView: true });
              } else {
                fields.set(fname, { type: 'void*' });
              }
            } else if (member.value?.type === 'StringLiteral') {
              // `readonly identifier = 'rp2350';` — a bare string literal field
              // initializer, no type annotation. Without this, it fell through to the
              // generic "object reference" void* catch-all, so isCharPtrExpr couldn't
              // recognize a comparison against it as a string compare (strcmp) instead
              // of a raw, always-false pointer `!=`.
              fields.set(fname, { type: 'const char*' });
            } else if (
              member.value?.type === 'Literal' ||
              member.value?.type === 'BooleanLiteral'
            ) {
              fields.set(fname, {
                type:
                  member.value.value === true || member.value.value === false
                    ? 'bool'
                    : typeof member.value.value === 'number'
                    ? 'int32_t'
                    : 'uint8_t',
              });
            } else if (
              member.value?.type === 'NumericLiteral' ||
              member.value?.type === 'BinaryExpression' ||
              member.value?.type === 'UnaryExpression' ||
              member.value?.type === 'ConditionalExpression'
            ) {
              // ConditionalExpression: e.g. `readonly pinA2 = this.index < 7 ? 16 + this.index * 2 : -1;`
              // — a numeric ternary with no annotation. Not narrowing further to check
              // both branches are actually numeric; every other untyped-numeric-init
              // case here is treated as int32_t the same way regardless of exact shape.
              fields.set(fname, { type: 'int32_t' });
            } else if (
              member.value?.type === 'Identifier' &&
              scalarConstNames.has(member.value.name)
            ) {
              // `xpsr = XPSR_T;` — initialized from a plain top-level numeric const
              // reference, not a literal. Every top-level const registered here is a
              // register-offset/bitmask-style number in this codebase; without this,
              // the field fell through to the generic "object reference" void* default.
              fields.set(fname, { type: 'int32_t' });
            } else if (
              member.value?.type === 'MemberExpression' &&
              member.value.object?.type === 'Identifier' &&
              enums.has(member.value.object.name)
            ) {
              // `state = I2CState.Idle;` — initialized from an enum member access, no
              // annotation. Same class of gap as the top-level-const case above: fell
              // through to the "object reference" void* default without this.
              fields.set(fname, { type: member.value.object.name });
            } else if (member.value?.type === 'ArrayExpression') {
              const elems = member.value.elements;
              const ctors = new Set(
                elems.map((e) => (e?.type === 'NewExpression' ? e.callee?.name : null))
              );
              if (elems.length > 0 && ctors.size === 1 && classes.has([...ctors][0])) {
                // [new Foo(...), new Foo(...), ...] → Foo** (array of Foo* — each
                // element is itself a pointer, since Foo_new() returns Foo*). No
                // `tsType` here deliberately — it would short-circuit ahead of the
                // `isArray` check in resolveExprType's field-lookup branches (which
                // check `field.tsType` first), collapsing bare `this.machines` access
                // to the element type instead of leaving it unresolved as an array.
                const ctor = [...ctors][0];
                // sizeNode: the element count is compile-time-known from the literal
                // itself — lets `for (const x of this.field)` (see the ForOfStatement
                // case) emit a real bounded C loop instead of falling to the generic
                // TODO stub, and `.length` resolve to the real count.
                fields.set(fname, {
                  type: `${ctor}**`,
                  isArray: true,
                  sizeNode: { type: 'NumericLiteral', value: elems.length },
                });
              } else if (
                elems.every(
                  (e) =>
                    e?.type === 'NumericLiteral' ||
                    e?.type === 'BinaryExpression' ||
                    e?.type === 'UnaryExpression'
                )
              ) {
                // Flat numeric array, e.g. `reg = [1, 0, ..., (1 << 12) + (1 << 16), 0]`
                // — every element is a plain number, just not all NumericLiterals.
                // `isArray: true` is required here, not just cosmetic — without it,
                // emitFieldInitializers' own array-literal-init branches (which check
                // `field.isArray` before matching) never fire, and the field falls all
                // the way through to the generic ArrayExpression codegen fallback,
                // which has no target type to build against and stubs to a bare `0`.
                fields.set(fname, { type: 'int32_t*', isArray: true });
              } else {
                fields.set(fname, { type: 'void*' });
              }
            } else if (
              member.value?.type === 'ArrowFunctionExpression' ||
              member.value?.type === 'FunctionExpression'
            ) {
              // Untyped callback field default (`onWatchdogTrigger = () => {...}`) — same
              // closure representation as an explicitly TSFunctionType-annotated field
              // (see buildClosureFieldInfo), just with the param/return types inferred
              // from the initializer itself instead of a separate type annotation.
              fields.set(
                fname,
                buildClosureFieldInfo(name, fname, member.value.params, member.value.returnType)
              );
            } else if (!member.value) {
              // No type annotation AND no initializer at all — e.g. `readonly timer;`
              // with the real assignment (`this.timer = new Timer32(...)`) living in
              // the constructor body instead. Backfilled below once the whole class
              // body has been scanned, once a constructor is known to exist.
              fields.set(fname, { type: 'void*', needsBackfill: true });
            } else {
              // Object reference (method call, new expression, etc.) → void*
              fields.set(fname, { type: 'void*' });
            }
          }
          // Stash the initializer expression itself (regardless of which branch above
          // set the field's type) so the constructor can actually run it — see
          // "Class field initializers" below. Class-property initializers are real TS/
          // JS semantics (they run at the start of the constructor, in declaration
          // order) that cts2c wasn't emitting into the constructor AT ALL — only
          // collecting their type for the struct layout. A `readonly x = 0` initializer
          // happens to look "correct" anyway (calloc already zeroes the struct), which
          // is why this went unnoticed for so many scalar fields — but a non-zero
          // default (`xpsr = XPSR_T`) or a field constructed via `new Foo(this, ...)`
          // (e.g. RP2040's `readonly adc = new RPADC(this, ...)`) was silently just
          // left as zeroed/NULL memory forever.
          if (member.value) {
            const f = fields.get(fname);
            if (f) f.initNode = member.value;
          }
        }
        if (member.type === 'ClassMethod') {
          const mname = member.key?.name;
          if (!mname || member.static) continue;
          const params = member.params
            .filter(
              (p) =>
                p.type === 'Identifier' ||
                p.type === 'AssignmentPattern' ||
                p.type === 'TSParameterProperty'
            )
            .map((p) => {
              // TSParameterProperty: readonly/public/protected modifier → becomes a field
              const realParam = p.type === 'TSParameterProperty' ? p.parameter : p;
              const isAssignment = realParam.type === 'AssignmentPattern';
              const pn = isAssignment ? realParam.left.name : realParam.name;
              const anno = isAssignment ? realParam.left.typeAnnotation : realParam.typeAnnotation;
              const litDefault = isAssignment ? literalDefaultInfo(realParam.right) : null;
              const pt = anno ? cTypeOf(anno) : litDefault?.type ?? 'int32_t';
              const defaultVal = litDefault?.defaultStr ?? '0';
              return {
                name: pn,
                type: pt,
                tsType: anno?.typeAnnotation?.typeName?.name,
                default: defaultVal,
              };
            });
          // Infer return type: void if body has bare returns or no returns
          let retType = 'int32_t';
          // Tracks whether `retType` above is a confident inference result vs just the
          // initial placeholder (inference genuinely found nothing) — only meaningful
          // for getters, where a second, later resolution attempt is worthwhile once
          // every class is fully collected (see resolveUnresolvedGetterTypes); for
          // everything else it's ignored, same behavior as before this existed.
          let retTypeUnresolved = false;
          if (member.returnType) {
            retType = cTypeOf(member.returnType);
          } else if (member.kind !== 'constructor') {
            if (hasBareReturn(member.body) || !hasAnyReturn(member.body)) retType = 'void';
            else {
              const paramTypesByName = Object.fromEntries(params.map((p) => [p.name, p.type]));
              const inferred = inferReturnTypeFromReturns(member.body, paramTypesByName, name);
              if (inferred) retType = inferred;
              else retTypeUnresolved = true;
            }
          }
          // Getters/setters: a real, callable accessor (see emitClassImpl), not a
          // regular method — stored separately so call/read/write-site code can ask
          // "does this property have a real getter/setter" directly. Also updates the
          // `fields` entry so downstream type-lookup consumers (which just want "what
          // C type does `obj.prop` evaluate to") see the getter's REAL inferred return
          // type instead of a hardcoded stub. A setter-only property (no matching
          // getter, e.g. PWMChannel.en) still needs a `fields` entry for its type, but
          // must NOT clobber a getter's real type if a getter for the same name was
          // already collected (source order between get/set isn't guaranteed).
          if (member.kind === 'get') {
            getters.set(mname, {
              retType,
              node: member,
              unresolved: retTypeUnresolved,
              className: name,
            });
            fields.set(mname, { type: retType, isGetter: true });
          } else if (member.kind === 'set') {
            setters.set(mname, { paramType: params[0]?.type ?? 'int32_t', node: member });
            if (!fields.get(mname)?.isGetter)
              fields.set(mname, { type: params[0]?.type ?? 'int32_t', isAccessor: true });
          } else {
            methods.set(mname, { params, retType, isConstructor: member.kind === 'constructor' });
          }

          // Scan constructor body for this.field = new TypedArray()/new Class() to infer field types
          if (member.kind === 'constructor' && member.body) {
            const scanForFieldTypes = (node) => {
              if (!node || typeof node !== 'object') return;
              if (
                node.type === 'AssignmentExpression' &&
                node.left?.type === 'MemberExpression' &&
                node.left.object?.type === 'ThisExpression' &&
                node.left.property?.type === 'Identifier'
              ) {
                const fname = node.left.property.name;
                // Also backfill fields declared with neither a type annotation nor an
                // initializer (`readonly timer;`, assigned only in the constructor
                // body) — these already got a `void*` placeholder from the ClassProperty
                // pass above (see `needsBackfill`), which would otherwise block this scan.
                if (!fields.has(fname) || fields.get(fname).needsBackfill) {
                  const init = node.right;
                  if (init?.type === 'NewExpression') {
                    const ctor = init.callee?.name;
                    if (ctor?.match(/^(Int|Uint|Float)(8|16|32|53|64)Array$/)) {
                      fields.set(fname, {
                        type: `${typedArrayCType(ctor)}*`,
                        isTypedArray: true,
                        taType: ctor,
                      });
                    } else if (ctor && classes.has(ctor)) {
                      fields.set(fname, { type: `${ctor}*`, tsType: ctor });
                    }
                  }
                }
                // Backfill sizeNode for a field whose CLASS-PROPERTY declaration has no
                // initializer at all (`readonly core: ICpuCore[];`, populated only inside
                // the constructor body, sometimes per-branch — e.g. `if (isArmCore)
                // this.core = [new CortexM33Core(...), ...]; else this.core = [new
                // CPU(...), ...];`) — the ClassProperty pass above already typed it
                // `isArray: true` from the annotation alone, but left `sizeNode`
                // undefined since it only ever inspects the property's OWN initializer.
                // Every constructor-body array-literal assignment to the same field has
                // a compile-time-known length; when every one seen agrees, promote it to
                // a real sizeNode the same way a property-initializer literal already
                // gets one, so `for (const x of this.field)`/`.length` resolve for real
                // instead of falling to the ForOfStatement TODO stub.
                const existingField = fields.get(fname);
                if (
                  existingField?.isArray &&
                  !existingField.isGrowableArray &&
                  node.right?.type === 'ArrayExpression' &&
                  node.right.elements.length > 0
                ) {
                  const n = node.right.elements.length;
                  if (existingField._ctorArrayLen === undefined) {
                    existingField._ctorArrayLen = n;
                    if (existingField.sizeNode === undefined)
                      existingField.sizeNode = { type: 'NumericLiteral', value: n };
                  } else if (existingField._ctorArrayLen !== n) {
                    // Conflicting per-branch lengths seen — bail out rather than guess;
                    // leaves sizeNode unset (or whatever it already was), same as before
                    // this backfill existed.
                    existingField.sizeNode = undefined;
                  }
                }
              }
              for (const k in node) {
                if (k[0] === '_' || k === 'loc' || k === 'start' || k === 'end' || k === 'range')
                  continue;
                const v = node[k];
                if (Array.isArray(v)) v.forEach((x) => scanForFieldTypes(x));
                else if (v && typeof v === 'object' && v.type) scanForFieldTypes(v);
              }
            };
            scanForFieldTypes(member.body);
          }

          // If constructor params have accessibility/readonly modifiers, they're fields
          if (member.kind === 'constructor') {
            for (const p of member.params) {
              if (p.type === 'TSParameterProperty') {
                // `readonly x: T = default` — a parameter property WITH a default
                // value — has an AssignmentPattern as `p.parameter` (`{left:
                // Identifier, right: default}`), not a bare Identifier; the
                // annotation lives on `.left`, not on the AssignmentPattern itself.
                // Previously only the no-default (`p.parameter.name`/
                // `p.parameter.typeAnnotation`) shape was handled — a defaulted
                // parameter property's `fname` came back undefined and the field was
                // silently never collected at all.
                const realParam =
                  p.parameter?.type === 'AssignmentPattern' ? p.parameter.left : p.parameter;
                const fname = realParam?.name;
                if (!fname) continue;
                const anno = realParam?.typeAnnotation;
                if (fields.has(fname)) continue;
                if (anno) {
                  const tsTypeName = anno.typeAnnotation?.typeName?.name;
                  fields.set(fname, { type: cTypeOf(anno), tsType: tsTypeName });
                } else if (p.parameter?.type === 'AssignmentPattern') {
                  // A parameter property with a default and NO annotation (`readonly
                  // frequency = 125e6`, `readonly throwOnError = false`) — the type comes
                  // from the default literal, exactly as the regular method-parameter
                  // collection above already does via literalDefaultInfo. Requiring an
                  // annotation skipped these entirely, so the field never existed even
                  // though the constructor takes it as a real argument.
                  const litDefault = literalDefaultInfo(p.parameter.right);
                  if (litDefault) fields.set(fname, { type: litDefault.type });
                }
              }
            }
          }
        }
      }

      // Merge with existing class if same name (RP2040/RP2350 variants)
      const existing = classes.get(name);
      if (existing) {
        // `path/to/foo.ts` vs `path/to/foo_rp2350.ts` defining the identical class
        // name (e.g. sio.ts's vs sio_rp2350.ts's `class RPSIO`, pads.ts's vs
        // pads_rp2350.ts's `class RPPADS`) is this codebase's established pattern for
        // a chip-specific variant of an otherwise-identical class — collectTypes scans
        // every file under src/ regardless of which chip's file the transpile target
        // actually reaches, in plain directory-traversal order, not "the one this
        // project actually targets" order. Un-suffixed "foo.ts" alphabetically sorts
        // BEFORE "foo_rp2350.ts", so without this, its field initializers/method
        // signatures always won the naive "first key wins" merge below — wrong for
        // this always-RP2350 build. Once the CURRENT file is
        // identified as the "_rp2350" sibling of whatever file already populated this
        // class (by filename pattern, not just the narrower RP2040*-vs-RP2350*-typed-
        // field special case previously here), its field initializers overwrite the
        // existing (wrong-chip) ones wholesale — field initializers are resolved from
        // this shared, merged `fields` map, a completely different lookup path than
        // per-file method body emission, so both need this same chip-preference fix.
        const currentIsRp2350Sibling =
          /_rp2350\.ts$/.test(filepath) && !existing.declSite?.includes('_rp2350.ts');
        for (const [k, v] of fields) {
          if (!existing.fields.has(k) || currentIsRp2350Sibling) {
            existing.fields.set(k, v);
          } else if (existing.fields.get(k).type === 'RP2040*' && v.type === 'RP2350*') {
            // Same-named class defined separately per chip whose field of the same
            // name is explicitly typed to the concrete chip class rather than generic
            // ChipType (e.g. `rp2040: RP2040` vs `rp2040: RP2350`) — narrower version
            // of the same fix, kept for classes that aren't a "$name"/"$name_rp2350"
            // filename pair (so `currentIsRp2350Sibling` above doesn't apply) but
            // still hit an RP2040*-vs-RP2350* field clash some other way.
            existing.fields.set(k, v);
          }
        }
        for (const [k, v] of methods) existing.methods.set(k, v);
        for (const [k, v] of getters) existing.getters.set(k, v);
        for (const [k, v] of setters) existing.setters.set(k, v);
        // Update parent/implements if the new definition has them
        if (parent) {
          existing.parent = parent;
          existing.isBase = false;
        }
        if (impls.size) for (const i of impls) existing.implements.add(i);
        // preRegisterTypes creates a placeholder entry (no declSite) before this runs,
        // so `existing` is truthy on the first real definition too — fill it in once.
        if (!existing.declSite) existing.declSite = declSite;
      } else {
        classes.set(name, {
          fields,
          methods,
          getters,
          setters,
          parent,
          isBase: parent == null,
          implements: impls,
          declSite,
        });
      }
    }

    // Collect type aliases: type X = Y → resolve Y
    if (
      node.type === 'TSTypeAliasDeclaration' ||
      (node.type === 'ExportNamedDeclaration' &&
        node.declaration?.type === 'TSTypeAliasDeclaration')
    ) {
      const alias = node.type === 'TSTypeAliasDeclaration' ? node : node.declaration;
      const aliasName = alias.id?.name;
      if (!aliasName) continue;
      typeAliases.set(aliasName, cTypeOf(alias.typeAnnotation));
    }

    if (
      node.type === 'TSEnumDeclaration' ||
      (node.type === 'ExportNamedDeclaration' && node.declaration?.type === 'TSEnumDeclaration')
    ) {
      const en = node.type === 'TSEnumDeclaration' ? node : node.declaration;
      const name = en.id?.name;
      if (!name) continue;
      const members = new Map();
      let val = 0;
      for (const m of en.members) {
        if (m.initializer?.value != null) val = m.initializer.value;
        members.set(m.id.name, val);
        val++;
      }
      enums.set(name, members);
    }

    // Collect EXPORTED top-level const declarations globally (from ALL discovered files, not
    // just the ones passed as cts2c.js inputs) so cross-file references like FUNCTION_PWM
    // resolve even when the declaring file itself isn't part of this invocation's input list.
    // Deliberately restricted to `export const` (not bare `const`): plain top-level consts are
    // module-private in TS (e.g. register-offset names like `IRQ`/`CTRL` repeated per
    // peripheral file) and would collide once hoisted into cts2c's single flat C namespace.
    if (
      node.type === 'ExportNamedDeclaration' &&
      node.declaration?.type === 'VariableDeclaration'
    ) {
      const varDecl = node.declaration;
      for (const decl of varDecl.declarations) {
        const declName = decl.id?.name;
        if (!declName || emittedConstants.has(declName)) continue;
        if (decl.init?.type === 'NumericLiteral') {
          const line = scalarConstDeclLine(declName, decl.init);
          if (line) globalConstantDecls.push(line);
        } else if (
          decl.init?.type === 'BinaryExpression' ||
          decl.init?.type === 'UnaryExpression'
        ) {
          // Only handle exprs over literals here — anything referencing another symbol
          // (e.g. enum member access) is left to the per-file emission pass, which runs
          // after all types are known.
          const isLiteralOnly = (n) =>
            n.type === 'NumericLiteral' ||
            ((n.type === 'BinaryExpression' || n.type === 'UnaryExpression') &&
              isLiteralOnly(n.left ?? n.argument) &&
              (n.type === 'UnaryExpression' || isLiteralOnly(n.right)));
          if (isLiteralOnly(decl.init)) {
            const line = scalarConstDeclLine(declName, decl.init);
            if (line) globalConstantDecls.push(line);
          }
        } else if (
          decl.init?.type === 'ArrayExpression' &&
          decl.init.elements.every((e) => e?.type === 'NumericLiteral')
        ) {
          emittedConstants.add(declName);
          arrayConstNames.add(declName);
          globalConstantDecls.push(
            `static const int32_t ${declName}[] = {${decl.init.elements
              .map((e) => e.value)
              .join(', ')}};`
          );
        } else if (
          decl.init?.type === 'MemberExpression' &&
          decl.init.object?.type === 'Identifier' &&
          enums.has(decl.init.object.name)
        ) {
          // const X = SomeEnum.Member; (e.g. MAX_HARDWARE_IRQ = IRQ.RTC). Must be hoisted
          // like the other cases above, not left to the per-file emission pass — that
          // pass emits inline wherever the declaring file happens to land in the output,
          // which can be *after* an earlier-processed file that already uses it (C needs
          // the enum declared before its first use in the translation unit).
          const line = scalarConstDeclLine(declName, decl.init);
          if (line) globalConstantDecls.push(line);
        }
      }
    }

    if (
      node.type === 'TSInterfaceDeclaration' ||
      (node.type === 'ExportNamedDeclaration' &&
        node.declaration?.type === 'TSInterfaceDeclaration')
    ) {
      const iface = node.type === 'TSInterfaceDeclaration' ? node : node.declaration;
      const name = iface.id?.name;
      if (!name) continue;
      const methods = new Map();
      for (const m of iface.body.body) {
        if (m.type === 'TSMethodSignature') {
          const mname = m.key?.name;
          if (!mname) continue;
          const params = (m.parameters || [])
            .filter((p) => p.type === 'Identifier')
            .map((p) => ({
              name: p.name,
              type: cTypeOf(p.typeAnnotation),
            }));
          const retType = m.typeAnnotation ? cTypeOf(m.typeAnnotation) : 'int32_t';
          methods.set(mname, { params, retType });
        }
        // Also handle property signatures (readonly fields)
        if (m.type === 'TSPropertySignature') {
          const mname = m.key?.name;
          if (!mname) continue;
          // For now, track as a boolean flag
          methods.set(mname, {
            params: [],
            retType: cTypeOf(m.typeAnnotation),
            isProperty: true,
            tsType: m.typeAnnotation?.typeAnnotation?.typeName?.name,
          });
        }
      }
      interfaces.set(name, methods);
    }

    // Collect free functions
    if (
      node.type === 'FunctionDeclaration' ||
      (node.type === 'ExportNamedDeclaration' && node.declaration?.type === 'FunctionDeclaration')
    ) {
      const fn = node.type === 'FunctionDeclaration' ? node : node.declaration;
      const name = fn.id?.name;
      if (!name) continue;
      freeFunctions.set(name, collectFreeFunctionSignature(fn));

      // ChipType-generic free function (e.g. `loadFirmware<ChipType extends IRPChip =
      // IRPChip>(chip: ChipType, ...)`) — stash the declaration + which param position
      // carries the chip, so monomorphization (see "ChipType monomorphization" above)
      // can re-collect/re-emit this function once per concrete type actually needed.
      const isChipTypeGeneric = fn.typeParameters?.params?.some((tp) => tp.name === 'ChipType');
      if (isChipTypeGeneric && !genericFreeFunctionDecls.has(name)) {
        const chipParamIndex = (fn.params || []).findIndex((p) => {
          const realParam = p.type === 'TSParameterProperty' ? p.parameter : p;
          const anno = realParam.typeAnnotation?.typeAnnotation;
          return anno?.type === 'TSTypeReference' && anno.typeName?.name === 'ChipType';
        });
        if (chipParamIndex !== -1) {
          genericFreeFunctionDecls.set(name, { node: fn, chipParamIndex, filepath });
        }
      }
    }

    // Collect arrow function consts
    if (
      node.type === 'VariableDeclaration' ||
      (node.type === 'ExportNamedDeclaration' && node.declaration?.type === 'VariableDeclaration')
    ) {
      const vd = node.type === 'VariableDeclaration' ? node : node.declaration;
      for (const decl of vd.declarations) {
        if (decl.init?.type === 'ArrowFunctionExpression') {
          const name = decl.id?.name;
          if (!name) continue;
          const params = collectParams(decl.init.params);
          const retType = decl.init.returnType ? cTypeOf(decl.init.returnType) : 'int32_t';
          arrowFunctions.set(name, { params, retType });
        }
      }
    }
  }
}

// ─── Pass 2: Code generation ────────────────────────────────────────
// Structs/enums are emitted whole-program (emitAllStructDefs/emitAllEnums below), not
// per-file: a struct must appear in parent-before-child topological order across ALL
// files, which a per-file walk can't guarantee.

// Folded values of already-emitted top-level scalar consts, so a const declared in terms
// of an earlier one can still be folded (see foldNumeric's Identifier case).
const constantNumericValues = new Map();

// Best-effort compile-time evaluation of a top-level const's initializer. Only needed to
// answer one question — "does this value fit in a C `int`?" (see declLineFor) — so a null
// result is always safe: the caller just keeps the default enum form.
function foldNumeric(node) {
  if (!node) return null;
  switch (node.type) {
    case 'NumericLiteral':
      return node.value;
    case 'Identifier':
      return constantNumericValues.has(node.name) ? constantNumericValues.get(node.name) : null;
    case 'ParenthesizedExpression':
      return foldNumeric(node.expression);
    case 'UnaryExpression': {
      const v = foldNumeric(node.argument);
      if (v === null) return null;
      if (node.operator === '-') return -v;
      if (node.operator === '+') return v;
      if (node.operator === '~') return ~v;
      return null;
    }
    case 'BinaryExpression': {
      const l = foldNumeric(node.left),
        r = foldNumeric(node.right);
      if (l === null || r === null) return null;
      switch (node.operator) {
        case '+':
          return l + r;
        case '-':
          return l - r;
        case '*':
          return l * r;
        case '/':
          return l / r;
        case '%':
          return l % r;
        case '**':
          return l ** r;
        // Bitwise/shift operators are evaluated with JS's own semantics (32-bit,
        // shift-count masked) — the same semantics the emitted C is made to reproduce.
        case '|':
          return l | r;
        case '&':
          return l & r;
        case '^':
          return l ^ r;
        case '<<':
          return l << r;
        case '>>':
          return l >> r;
        case '>>>':
          return l >>> r;
        default:
          return null;
      }
    }
    default:
      return null;
  }
}

function declLineFor(name, val, initNode) {
  const isFloat =
    /\bINFINITY\b|\bNAN\b/.test(val) ||
    (initNode.type === 'NumericLiteral' && !Number.isInteger(initNode.value));
  if (isFloat) return `static const double ${name} = ${val};`;
  const folded = foldNumeric(initNode);
  if (folded !== null) constantNumericValues.set(name, folded);
  // A C enumerator's value has to be representable as `int`. GCC accepts a wider one as
  // an extension, but silently widens the WHOLE enum's underlying type to fit — so
  // `enum { SIO_START_ADDRESS = 3489660928 }` gives that constant type `unsigned int`,
  // and every comparison against an int32_t then flips to unsigned by C's usual
  // arithmetic conversions. It happens to be what this codebase wants (addresses really
  // are unsigned quantities held in int32_t fields), but only by luck, and it's
  // implementation-defined rather than guaranteed. Emit an explicitly-typed constant of
  // the type GCC was already choosing, so the intent is stated rather than inferred.
  // Affects SIO_/PPB_START_ADDRESS, PPB_END_ADDRESS, XPSR_N, TWO32, VECTORED_BOOT_MAGIC.
  // The FOLDED literal is emitted, not `val`: a file-scope `static const` initialized
  // from another `static const` isn't a constant initializer in C, so a const declared in
  // terms of one of these would stop compiling if the reference were kept.
  if (folded !== null && Number.isInteger(folded)) {
    // Emit the folded literal rather than the reference expression in EVERY integer case,
    // not just the wide one. A const declared in terms of one of the wide consts above
    // (`const NEG_MAGIC = -VECTORED_BOOT_MAGIC >>> 0;`) would otherwise still reference it
    // — and referencing a file-scope `static const` is not a constant expression in C, so
    // the enum form stops compiling ("enumerator value for NEG_MAGIC is not an integer
    // constant"). Folding unconditionally makes every scalar const self-contained and
    // removes the declaration-order fragility altogether. The original expression is kept
    // as a trailing comment so the output is still readable.
    const src = val === String(folded) ? '' : ` /* ${val} */`;
    if (folded > 2147483647 || folded < -2147483648) {
      if (folded >= 0 && folded <= 4294967295)
        return `static const uint32_t ${name} = ${folded}u;${src}`;
      return folded < 0
        ? `static const int64_t ${name} = ${folded}ll;${src}`
        : `static const uint64_t ${name} = ${folded}ull;${src}`;
    }
    return `enum { ${name} = (${folded}) };${src}`;
  }
  return `enum { ${name} = (${val}) };`;
}

// Build a top-level `const NAME = <scalar expr>;` decl line as either a C enum member
// (integer constants — the common case) or a `static const double` (floating-point
// values, which C's enum can't hold as a member: `enum { X = INFINITY }` doesn't
// compile). Returns null if already emitted (shared emittedConstants dedup set).
function scalarConstDeclLine(name, initNode) {
  if (emittedConstants.has(name)) return null;
  emittedConstants.add(name);
  const val = emitExpr(initNode, null, null);
  constantValues.set(name, val);
  return declLineFor(name, val, initNode);
}

// Per-file variant (module-private consts, via emitImpl — not the cross-file exported-
// const hoist): module-private register-offset-style names (WDSEL, PLATFORM, CTRL, ...)
// are extremely commonly reused across peripheral file pairs with a genuinely DIFFERENT
// value each time — real TS has no conflict (file-scoped), but cts2c's single flat C
// namespace does. Same name + same value is a harmless duplicate decl (skip, as before);
// same name + different value gets this file's occurrence renamed (declaration AND
// every later reference within this same file, via currentFileConstRenames — consulted
// by emitExpr's Identifier case), rather than silently keeping whichever file's value won
// the race and corrupting this file's own logic with the wrong constant.
function emitScalarConstDecl(name, initNode, out) {
  const val = emitExpr(initNode, null, null);
  if (emittedConstants.has(name)) {
    if (constantValues.get(name) === val) return; // harmless duplicate, nothing to do
    let renamed = `${name}__${path.basename(currentFile, '.ts').replace(/[^a-zA-Z0-9_]/g, '_')}`;
    while (emittedConstants.has(renamed)) renamed += '_';
    currentFileConstRenames.set(name, renamed);
    emittedConstants.add(renamed);
    constantValues.set(renamed, val);
    out.push(declLineFor(renamed, val, initNode));
    return;
  }
  emittedConstants.add(name);
  constantValues.set(name, val);
  out.push(declLineFor(name, val, initNode));
}

function emitImpl(node, out) {
  switch (node.type) {
    case 'ImportDeclaration':
      break;
    case 'ExportNamedDeclaration':
      if (node.declaration) emitImpl(node.declaration, out);
      break;
    case 'VariableDeclaration': {
      for (const decl of node.declarations) {
        if (decl.init?.type === 'ArrowFunctionExpression') {
          emitArrowFunction(decl.id.name, decl.init, out, false);
        } else if (
          decl.init?.type === 'NumericLiteral' ||
          decl.init?.type === 'BinaryExpression' ||
          decl.init?.type === 'UnaryExpression' ||
          (decl.init?.type === 'MemberExpression' &&
            decl.init.object?.type === 'Identifier' &&
            enums.has(decl.init.object.name)) ||
          (decl.init?.type === 'Identifier' &&
            (decl.init.name === 'Infinity' ||
              decl.init.name === 'NaN' ||
              emittedConstants.has(decl.init.name)))
        ) {
          // The last Identifier case: `const REBOOT_TO_MAGIC_PC = VECTORED_BOOT_MAGIC;`
          // — a plain const-aliases-another-const declaration. Only matches once the
          // aliased name is already emitted (source-order dependent, same as every
          // other const here — fine since these are always declared top-to-bottom in
          // one file).
          emitScalarConstDecl(decl.id.name, decl.init, out);
        } else if (decl.init?.type === 'ArrayExpression') {
          // Flat numeric array → static const int32_t[]
          const elems = decl.init.elements;
          if (elems.every((e) => e?.type === 'NumericLiteral')) {
            arrayConstNames.add(decl.id.name);
            out.push(
              `static const int32_t ${decl.id.name}[] = {${elems.map((e) => e.value).join(', ')}};`
            );
          } else if (elems.every((e) => e?.type === 'StringLiteral')) {
            // Flat string array, e.g. GPIO_FUNC_NAMES — const char*[]
            out.push(
              `static const char* ${decl.id.name}[] = {${elems
                .map((e) => `"${cStringEscape(e.value)}"`)
                .join(', ')}};`
            );
          } else if (
            elems.every((e) => e?.type === 'ArrayExpression') &&
            elems.every((e) => e.elements.every((v) => v?.type === 'NumericLiteral'))
          ) {
            // Ragged 2D numeric array, e.g. riscv/rv32c.ts's `xreg_list` (Zcmp
            // cm.push/cm.pop's per-encoding register list) — indexed by a runtime
            // value (`xreg_list[rlist]`) and iterated via for-of
            // (`for (reg of xreg_list[rlist])`). A bare C `int32_t**` can't carry
            // each sub-array's own length, so emit a parallel `NAME_lens[]` too —
            // ForOfStatement's own `arr[computedIndex]` case (see there) consults both.
            const subNames = elems.map((e, i) => `${decl.id.name}_${i}`);
            elems.forEach((e, i) => {
              const vals = e.elements.map((v) => v.value);
              out.push(
                `static const int32_t ${subNames[i]}[] = {${vals.length ? vals.join(', ') : '0'}};`
              );
            });
            out.push(`static const int32_t* ${decl.id.name}[] = {${subNames.join(', ')}};`);
            out.push(
              `static const int32_t ${decl.id.name}_lens[] = {${elems
                .map((e) => e.elements.length)
                .join(', ')}};`
            );
            ragged2DArrayNames.add(decl.id.name);
          }
        } else if (
          decl.init?.type === 'NewExpression' &&
          decl.init.callee?.name?.match(/^(Int|Uint|Float)(8|16|32|53|64)Array$/) &&
          decl.init.arguments[0]?.type === 'ArrayExpression' &&
          decl.init.arguments[0].elements.every((e) => e?.type === 'NumericLiteral')
        ) {
          // const K = new Uint32Array([0x428a2f98, ...]); — a typed-array constant
          // lookup table, e.g. SHA-256's round constants. Same flat-numeric-array
          // treatment as a plain array literal, just typed to match the TypedArray.
          const elCType = typedArrayCType(decl.init.callee.name);
          const elems = decl.init.arguments[0].elements;
          arrayConstNames.add(decl.id.name);
          out.push(
            `static const ${elCType} ${decl.id.name}[] = {${elems.map((e) => e.value).join(', ')}};`
          );
        } else if (decl.init?.type === 'StringLiteral') {
          // `const LOG_NAME = 'RP2350';` — a bare top-level string const. Without this
          // branch it's silently dropped, and any later reference resolves to an
          // undeclared identifier.
          const name = decl.id.name;
          if (!emittedConstants.has(name)) {
            emittedConstants.add(name);
            stringConstNames.add(name);
            out.push(`static const char* ${name} = "${cStringEscape(decl.init.value)}";`);
          }
        }
      }
      break;
    }
    case 'FunctionDeclaration': {
      const name = node.id?.name;
      // ChipType-generic free functions are emitted later, once per concrete
      // monomorphized instantiation (see "ChipType monomorphization" above) — never
      // under their own bare (generic) name.
      if (genericFreeFunctionDecls.has(name)) break;
      // checkTraceMagic* firmware tracing hooks (emit allocation-free bodies).
      const traceMagicHooks = {
        checkTraceMagic: {
          check: `RP2350_readUint16(%0->chip, %1) == 0xabcd && RP2350_readUint16(%0->chip, %1 + 2) == 0xffff`,
          readU8: `RP2350_readUint8(%0->chip, __trace_i)`,
          tagFrom: `%1 + 4`,
          fire: `if (%0->chip->onTrace_fn) %0->chip->onTrace_fn(%0->chip->onTrace_ctx, %0->mhartid, %0->pc, __trace_tag);`,
        },
        checkTraceMagicM33: {
          check: `RP2350_readUint16(%0->chip, %1 + 2) == 0xabcd && RP2350_readUint16(%0->chip, %1 + 4) == 0xffff`,
          readU8: `RP2350_readUint8(%0->chip, __trace_i)`,
          tagFrom: `%1 + 6`,
          fire: `if (%0->chip->onTrace_fn) %0->chip->onTrace_fn(%0->chip->onTrace_ctx, %0->coreIndex, %1, __trace_tag);`,
        },
        checkTraceMagicM0: {
          check: `CortexM0Core_readUint16(%0, %1 + 2) == 0xabcd && CortexM0Core_readUint16(%0, %1 + 4) == 0xffff`,
          readU8: `CortexM0Core_readUint8(%0, __trace_i)`,
          tagFrom: `%1 + 6`,
          fire: `if (%0->rpchip->onTrace_fn) %0->rpchip->onTrace_fn(%0->rpchip->onTrace_ctx, %0->coreNumber, CortexM0Core_PC_get(%0), __trace_tag);`,
        },
      };
      if (traceMagicHooks[name]) {
        const fn = freeFunctions.get(name);
        if (fn) {
          const p = fn.params.map((pp) => cName(pp.name));
          const fill = (s) => s.replace(/%(\d)/g, (_, i) => p[+i]);
          const hook = traceMagicHooks[name];
          out.push(
            `static ${fn.retType} ${name}(${fn.params
              .map((pp) => `${pp.type} ${cName(pp.name)}`)
              .join(', ')}) {`
          );
          out.push(`  if (${fill(hook.check)}) {`);
          out.push(`    char __trace_tag[64];`);
          out.push(`    int __trace_n = 0;`);
          out.push(
            `    for (int32_t __trace_i = ${fill(
              hook.tagFrom
            )}; __trace_n < (int)sizeof(__trace_tag) - 1; __trace_i++) {`
          );
          out.push(`      int32_t __trace_ch = (int32_t)${fill(hook.readU8)};`);
          out.push(`      if (__trace_ch == 0) break;`);
          out.push(`      __trace_tag[__trace_n++] = (char)__trace_ch;`);
          out.push(`    }`);
          out.push(`    __trace_tag[__trace_n] = '\\0';`);
          out.push(`    ${fill(hook.fire)}`);
          out.push(`  }`);
          out.push('}');
          out.push('');
          break;
        }
      }
      // Float/double bit-reinterpretation helpers (execute-fpu.ts/coprocessor.ts): their
      // real TS bodies alias a Float32Array/Uint32Array (or Float64Array/Uint32Array)
      // pair over one ArrayBuffer to reinterpret bits — safe in JS, but transpiled
      // literally that's two incompatible C pointer types over the same memory, UB
      // under C's strict-aliasing rule. Substitute hand-written, memcpy-based bodies
      // instead (same precedent as loadFirmwareFromUF2); the real TS bodies are
      // untouched and still run under Node/vitest. memcpy between same-sized objects
      // is always well-defined, and GCC/Clang at -O1+ fold a constant-size memcpy into
      // a scalar down to a register move, so this costs nothing once optimized.
      if (
        ['floatToBits', 'bitsToFloat', 'isSignNegative', 'readDouble', 'writeDouble'].includes(name)
      ) {
        const fn = freeFunctions.get(name);
        if (fn) {
          const p = fn.params.map((pp) => cName(pp.name));
          const sig = `static ${fn.retType} ${name}(${fn.params
            .map((pp) => `${pp.type} ${cName(pp.name)}`)
            .join(', ')})`;
          out.push(sig + ' {');
          if (name === 'floatToBits') {
            out.push(`  int32_t __pun_bits; memcpy(&__pun_bits, &${p[0]}, sizeof(__pun_bits));`);
            out.push(`  return __pun_bits;`);
          } else if (name === 'bitsToFloat') {
            out.push(`  float __pun_f; memcpy(&__pun_f, &${p[0]}, sizeof(__pun_f));`);
            out.push(`  return __pun_f;`);
          } else if (name === 'isSignNegative') {
            out.push(`  uint64_t __pun_bits; memcpy(&__pun_bits, &${p[0]}, sizeof(__pun_bits));`);
            out.push(`  return (__pun_bits >> 63) != 0;`);
          } else if (name === 'readDouble') {
            out.push(
              `  uint64_t __pun_bits = ((uint64_t)${p[0]}->dcpHalves[${p[1]} * 2 + 1] << 32) | (uint64_t)${p[0]}->dcpHalves[${p[1]} * 2];`
            );
            out.push(`  double __pun_d; memcpy(&__pun_d, &__pun_bits, sizeof(__pun_d));`);
            out.push(`  return __pun_d;`);
          } else if (name === 'writeDouble') {
            out.push(`  uint64_t __pun_bits; memcpy(&__pun_bits, &${p[2]}, sizeof(__pun_bits));`);
            out.push(`  ${p[0]}->dcpHalves[${p[1]} * 2] = (uint32_t)(__pun_bits & 0xffffffffu);`);
            out.push(`  ${p[0]}->dcpHalves[${p[1]} * 2 + 1] = (uint32_t)(__pun_bits >> 32);`);
          }
          out.push('}');
          out.push('');
          break;
        }
      }
      emitFunction(node, out);
      break;
    }
    case 'TSEnumDeclaration':
      break; // already emitted in decl pass
    case 'ClassDeclaration': {
      emitClassImpl(node, out);
      break;
    }
  }
}

function emitArrowFunction(name, arrow, out, isDecl) {
  // Same duplicate-definition guard emitFunction/emitClassImpl already have: an
  // identically-named top-level arrow const in an RP2040/RP2350 variant file pair would
  // otherwise be emitted twice — a redefinition error. No such pair exists today; latent.
  if (emittedFunctions.has(name)) return;
  emittedFunctions.add(name);
  const params = collectParams(arrow.params);
  const retType = arrow.returnType ? cTypeOf(arrow.returnType) : 'int32_t';
  const paramStr = params.map((p) => `${p.type} ${cName(p.name)}`).join(', ') || 'void';

  if (isDecl) out.push(`static inline ${retType} ${name}(${paramStr});`);

  const scope = {};
  for (const p of params) if (p.tsType) scope[p.name] = p.tsType;
  const ctx = { className: null, fields: null, varTypes: scope };
  out.push(`static inline ${retType} ${name}(${paramStr}) {`);
  emitBody(arrow.body, name, params, out, ctx);
  emitFallbackReturn(arrow.body, retType, out);
  out.push(`}`);
  out.push('');
}

function emitFunction(node, out) {
  const name = node.id?.name;
  if (!name) return;
  // Never a legitimate transpiled call target (see the matching skip in
  // emitClassVTableForwardDecls) — reserved for a C harness's real process entry point.
  if (name === 'main') return;
  if (emittedFunctions.has(name)) return; // skip duplicate (RP2040/RP2350 variant)
  emittedFunctions.add(name);
  // Use the collected params/retType (from collectTypes) for consistency with forward
  // decls — collectParams() re-derives types fresh from the AST and doesn't know about
  // e.g. a default-valued-but-unannotated param's inferred type (`padChar = ' '` ->
  // const char*), so re-deriving here instead of reusing fn.params produced a
  // definition whose signature didn't match its own forward declaration.
  const fn = freeFunctions.get(name);
  const params = fn?.params ?? collectParams(node.params, { genericAsVoidStar: true });
  const retType =
    fn?.retType ??
    (node.returnType ? cTypeOf(node.returnType, { genericAsVoidStar: true }) : 'int32_t');
  const paramStr = params.map((p) => `${p.type} ${cName(p.name)}`).join(', ') || 'void';

  const scope = {};
  for (const p of params) if (p.tsType) scope[p.name] = p.tsType;
  const ctx = { className: null, fields: null, varTypes: scope };
  out.push(`static ${retType} ${name}(${paramStr}) {`);
  emitBody(node.body, name, params, out, ctx);
  emitFallbackReturn(node.body, retType, out);
  out.push(`}`);
  out.push('');
}

// Emit `self->field = <initializer>;` for every own (non-static) class field that has
// a stashed initializer expression (see the "Class field initializers" comment at
// their collection site in collectTypes) — in declaration order, matching real TS/JS
// class-field semantics (they run at the start of the constructor). Two shapes get
// dedicated codegen beyond a plain emitExpr() of the initializer:
//   - `new Foo(...)` (single instance) — emitExpr already handles this correctly
//     (Foo_new(args)), including a `this` reference inside args resolving to `self`.
//   - `[new Foo(...), new Foo(...), ...]` (array of same-class instances, e.g.
//     RPPWM.channels) — emitExpr's ArrayExpression case always TODO-stubs to a bare
//     `0`, discarding the actual construction; synthesize a calloc + per-element
//     Foo_new() loop instead, matching the `Foo**` field type this shape collects as.
// Anything else safely falls through to a plain `self->field = emitExpr(initNode)` —
// for shapes emitExpr can't really handle (flat numeric arrays, opaque object refs),
// that's just a TODO-stub assignment, no worse than the previous "never assigned at
// all" behavior (the field was already effectively zero/NULL via calloc either way).
function emitFieldInitializers(classNode, className, out, ctx, params) {
  const info = classes.get(className);
  if (!info) return;
  for (const member of classNode.body.body) {
    if (member.type !== 'ClassProperty' && member.type !== 'ClassPrivateProperty') continue;
    if (member.static) continue;
    const fname = member.key?.name;
    if (!fname) continue;
    const field = info.fields.get(fname);
    if (!field?.initNode) continue;
    const initNode = field.initNode;

    // RP2040RTC's `baseline = new Date(...)` — cts2c has no Date support (see the
    // matching readUint32/writeUint32 override in emitClassImpl). `baseline` is only
    // ever read back through those two hand-written bodies, which never touch it, so
    // leaving it NULL (from the surrounding calloc) is safe.
    if (className === 'RP2040RTC' && fname === 'baseline') continue;

    // Inlined typed array: the struct's own calloc already zeroed it.
    if (field.inlineArray && field.isTypedArray) continue;

    // `x: T[] = []` — a growable array (see the collectTypes `isGrowableArray`
    // comment): preallocate GROWABLE_ARRAY_CAPACITY element slots up front and start
    // the companion count at 0, instead of the `elems.every(...)` branch just below
    // (vacuously true on an empty array) calloc'ing a useless 0-byte block.
    if (field.isGrowableArray) {
      const elemType = field.type.slice(0, -1);
      if (!field.inlineArray)
        out.push(
          `  self->${cName(fname)} = calloc(${GROWABLE_ARRAY_CAPACITY}, sizeof(${elemType}));`
        );
      out.push(`  self->${cName(fname)}_count = 0;`);
      continue;
    }

    // Callback field default (`onWatchdogTrigger = () => {...}`) — the actual
    // function was already emitted by emitDefaultClosureFunctions, right before this
    // class's own methods; just wire up the two struct members to point at it.
    if (
      field.kind === 'closure' &&
      (initNode.type === 'ArrowFunctionExpression' || initNode.type === 'FunctionExpression')
    ) {
      out.push(`  self->${field.fnField} = ${className}_${fname}_default;`);
      out.push(`  self->${field.ctxField} = self;`);
      continue;
    }

    if (initNode.type === 'ArrayExpression' && field.isArray && field.type.endsWith('**')) {
      const ctor = field.type.slice(0, -2);
      const elems = initNode.elements;
      if (elems.every((e) => e?.type === 'NewExpression' && e.callee?.name === ctor)) {
        if (!field.inlineArray)
          out.push(`  self->${cName(fname)} = calloc(${elems.length}, sizeof(${ctor}*));`);
        elems.forEach((e, i) => {
          out.push(`  self->${cName(fname)}[${i}] = ${emitExpr(e, className, params, ctx)};`);
        });
        continue;
      }
    }
    // `x: T[] = [0, 0]` — a plain scalar/interface-element array literal (as opposed
    // to the array-of-`new`-instances case just above). Same calloc-then-per-index
    // shape, just without the `**` class-pointer-array element type.
    if (
      initNode.type === 'ArrayExpression' &&
      field.isArray &&
      field.type.endsWith('*') &&
      !field.type.endsWith('**')
    ) {
      const elems = initNode.elements;
      if (elems.every((e) => e && e.type !== 'NewExpression')) {
        const elemType = field.type.slice(0, -1);
        if (!field.inlineArray)
          out.push(`  self->${cName(fname)} = calloc(${elems.length}, sizeof(${elemType}));`);
        elems.forEach((e, i) => {
          out.push(`  self->${cName(fname)}[${i}] = ${emitExpr(e, className, params, ctx)};`);
        });
        continue;
      }
    }
    // `x: T[] = Array(N)` — the bare (no `new`) JS Array() global constructor,
    // sized but element-less; equivalent to allocating N zeroed T's. The field's own
    // declared type (already collected) carries the element type Array(N) itself
    // doesn't, so use that instead of trying to resolve one from the call.
    if (
      initNode.type === 'CallExpression' &&
      initNode.callee?.type === 'Identifier' &&
      initNode.callee.name === 'Array' &&
      field.isArray &&
      field.type.endsWith('*')
    ) {
      const elemType = field.type.slice(0, -1);
      const size = emitExpr(initNode.arguments[0], className, params, ctx);
      if (!field.inlineArray)
        out.push(`  self->${cName(fname)} = calloc(${size}, sizeof(${elemType}));`);
      continue;
    }
    // `x = new Array<T>(N)` — same sized-and-element-less allocation as the bare
    // `Array(N)` case just above, just via `new` (e.g. riscv/cpu.ts's `meipa = new
    // Array<number>(512)`) — NewExpression, not CallExpression, so the check above
    // never matched it; fell through to the generic emitExpr fallback, which has no
    // target type to build against and stubs any unknown `new X()` constructor to 0.
    if (
      initNode.type === 'NewExpression' &&
      initNode.callee?.name === 'Array' &&
      field.isArray &&
      field.type.endsWith('*')
    ) {
      const elemType = field.type.slice(0, -1);
      const size = emitExpr(initNode.arguments[0], className, params, ctx);
      if (!field.inlineArray)
        out.push(`  self->${cName(fname)} = calloc(${size}, sizeof(${elemType}));`);
      continue;
    }
    // `x: T[] = Array(N).fill(v)` — sized-and-value-filled, no `.map()` (which has its
    // own dedicated case below for the construct-N-instances idiom). calloc already
    // zeroes every element, so a `.fill(0)` is a no-op; anything else needs an actual
    // per-index fill loop (a byte-level memset would be wrong for non-zero multi-byte
    // element types).
    if (
      initNode.type === 'CallExpression' &&
      initNode.callee?.type === 'MemberExpression' &&
      initNode.callee.property?.name === 'fill' &&
      field.isArray &&
      field.type.endsWith('*') &&
      initNode.callee.object?.type === 'CallExpression' &&
      initNode.callee.object.callee?.type === 'Identifier' &&
      initNode.callee.object.callee.name === 'Array'
    ) {
      const elemType = field.type.slice(0, -1);
      const size = emitExpr(initNode.callee.object.arguments[0], className, params, ctx);
      const fillArg = initNode.arguments[0];
      if (!field.inlineArray)
        out.push(`  self->${cName(fname)} = calloc(${size}, sizeof(${elemType}));`);
      if (!(fillArg?.type === 'NumericLiteral' && fillArg.value === 0)) {
        const fillVal = emitExpr(fillArg, className, params, ctx);
        out.push(
          `  for (int32_t __fill_i = 0; __fill_i < ${size}; __fill_i++) { self->${cName(
            fname
          )}[__fill_i] = ${fillVal}; }`
        );
      }
      continue;
    }
    // `x: Array<T> = Array(N).fill(v).map((v, i) => new T(...))` — a common
    // construct-N-instances idiom. `.fill()` only exists to make `.map()` iterate (its
    // own value is discarded), so the pattern reduces to: calloc N T-pointers, then run
    // the map callback body once per index, binding its index parameter.
    if (
      initNode.type === 'CallExpression' &&
      initNode.callee?.type === 'MemberExpression' &&
      initNode.callee.property?.name === 'map' &&
      field.isArray &&
      field.type.endsWith('**')
    ) {
      const fillCall = initNode.callee.object;
      const mapFn = initNode.arguments[0];
      const arraySizeCall =
        fillCall?.type === 'CallExpression' && fillCall.callee?.property?.name === 'fill'
          ? fillCall.callee.object
          : null;
      if (
        arraySizeCall?.type === 'CallExpression' &&
        arraySizeCall.callee?.type === 'Identifier' &&
        arraySizeCall.callee.name === 'Array' &&
        mapFn?.type === 'ArrowFunctionExpression' &&
        mapFn.body?.type === 'NewExpression'
      ) {
        const ctor = field.type.slice(0, -2);
        if (mapFn.body.callee?.name === ctor) {
          const size = emitExpr(arraySizeCall.arguments[0], className, params, ctx);
          const idxName = cName(mapFn.params[1]?.name ?? 'i');
          if (!field.inlineArray)
            out.push(`  self->${cName(fname)} = calloc(${size}, sizeof(${ctor}*));`);
          out.push(`  for (int32_t ${idxName} = 0; ${idxName} < ${size}; ${idxName}++) {`);
          out.push(
            `    self->${cName(fname)}[${idxName}] = ${emitExpr(
              mapFn.body,
              className,
              params,
              ctx
            )};`
          );
          out.push(`  }`);
          continue;
        }
      }
    }
    // `x: { [index: number]: T } = { 0x123: new A(...), 0x456: this.someField, ... }` —
    // a sparse-lookup-table object literal keyed by numeric literals (e.g.
    // rp2350.ts's `peripherals` MMIO dispatch table). Modeled as a flat array sized to
    // the largest key + 1 (matching the source's own dense-enough address encoding),
    // element type from the field's own index-signature type (an interface for
    // Peripheral, so per-entry boxing goes through wrapArgIfInterfaceParam same as
    // everywhere else a concrete instance meets an interface-typed slot). Unset
    // entries stay zeroed (null object/vtable), matching a plain-JS sparse array read
    // returning undefined for those addresses.
    if (initNode.type === 'ObjectExpression' && field.isArray && field.type.endsWith('*')) {
      const props = initNode.properties.filter((p) => p.type === 'ObjectProperty');
      const keyed = props.map((p) => ({
        key: p.key?.type === 'NumericLiteral' ? p.key.value : null,
        node: p,
      }));
      if (props.length > 0 && keyed.every((k) => k.key !== null)) {
        const elemType = field.type.slice(0, -1);
        const maxKey = Math.max(...keyed.map((k) => k.key));
        if (!field.inlineArray)
          out.push(`  self->${cName(fname)} = calloc(${maxKey + 1}, sizeof(${elemType}));`);
        for (const { key, node: p } of keyed) {
          const val = emitExpr(p.value, className, params, ctx);
          const wrapped = wrapArgIfInterfaceParam(val, p.value, elemType, ctx, className, params);
          out.push(`  self->${cName(fname)}[${key}] = ${wrapped};`);
        }
        continue;
      }
      // `x: { [offset: number]: T } = {}` — a genuinely dynamic dictionary, grown
      // later via `this.regs[offset] = value` at data-driven (not statically known)
      // offsets (e.g. trng_rp2350.ts's `regs`, a register-offset scratch map) — no
      // keys to size an exact array from, unlike the populated-literal case just
      // above. Every real caller in this codebase reaches it through a peripheral's
      // writeUint32-style dispatch, already masked to a 4KB (0xfff) register window
      // before this point (see rp2350.ts's `peripheral.writeUint32Atomic(offset &
      // 0xfff, ...)`), so a flat 4096-element buffer safely covers every offset that
      // can actually arrive here — same gap as the populated-literal case above (the
      // generic ObjectExpression fallback has no target type to build against).
      if (props.length === 0) {
        const elemType = field.type.slice(0, -1);
        if (!field.inlineArray)
          out.push(`  self->${cName(fname)} = calloc(4096, sizeof(${elemType}));`);
        continue;
      }
    }
    // `x = new DataView(this.someTypedArray.buffer);` — see the field-type collection
    // comment (`isDataView`) for why this is just a pointer alias, not an allocation.
    if (
      field.isDataView &&
      initNode.type === 'NewExpression' &&
      initNode.callee?.name === 'DataView' &&
      initNode.arguments[0]?.type === 'MemberExpression' &&
      initNode.arguments[0].property?.name === 'buffer'
    ) {
      out.push(
        `  self->${cName(fname)} = (uint8_t*)(${emitExpr(
          initNode.arguments[0].object,
          className,
          params,
          ctx
        )});`
      );
      continue;
    }
    out.push(
      `  self->${cName(fname)} = ${castStubForType(
        emitExpr(initNode, className, params, ctx),
        field.type
      )};`
    );
  }
}

// Emits a closure-field's actual C function body once (idempotent via
// emittedFunctions): `static RETTYPE NAME(void* __ctx, ...params) { CAPTURING_CLASS*
// self = (CAPTURING_CLASS*)__ctx; ...body... }`. `capturingClassName` is whichever
// class's `this` the original TS closure actually closed over — the field's own
// owning class for a default initializer (Case A), or the assigning class for a
// cross-instance override (Case C) — NOT necessarily the class that declares the
// field itself.
function emitClosureFunction(fnName, capturingClassName, targetField, initNode, out) {
  if (emittedFunctions.has(fnName)) return;
  emittedFunctions.add(fnName);
  const info = classes.get(capturingClassName);
  // Param NAMES come from the initializer's own params where present; a field's
  // declared signature (from its type annotation) may have more params than a
  // particular initializer actually uses (e.g. i2c.ts's `onWriteByte: (value:
  // number) => void = () => this.completeWrite(false);` — valid TS, since the extra
  // arg is simply never read) — synthesize a placeholder name for those so the
  // function's real parameter COUNT/TYPES always match its typedef.
  const paramNames = targetField.paramTypes.map(
    (t, i) => initNode.params?.[i]?.name ?? `__arg${i}`
  );
  const sigParams = [
    'void* __ctx',
    ...paramNames.map((pn, i) => `${targetField.paramTypes[i]} ${cName(pn)}`),
  ];
  out.push(`static ${targetField.retType} ${fnName}(${sigParams.join(', ')}) {`);
  out.push(`  ${capturingClassName}* self = (${capturingClassName}*)__ctx;`);
  const scope = { self: capturingClassName };
  const bodyParams = [
    { name: 'self', type: `${capturingClassName}*` },
    ...paramNames.map((pn, i) => ({ name: pn, type: targetField.paramTypes[i] })),
  ];
  const classContext = {
    className: capturingClassName,
    fields: info?.fields,
    varTypes: scope,
    retType: targetField.retType,
  };
  emitBody(initNode.body, fnName, bodyParams, out, classContext);
  emitFallbackReturn(initNode.body, targetField.retType, out);
  out.push(`}`);
  out.push('');
}

// Case A: this class's own closure-kind fields with a default arrow/function
// initializer (`onWatchdogTrigger = () => {...}`) — emitted up front so
// emitFieldInitializers (called later, inside this class's own constructor) can
// just reference the already-emitted function by its deterministic name.
function emitDefaultClosureFunctions(classNode, className, out) {
  const info = classes.get(className);
  if (!info) return;
  for (const member of classNode.body.body) {
    if (member.type !== 'ClassProperty' && member.type !== 'ClassPrivateProperty') continue;
    if (member.static) continue;
    const fname = member.key?.name;
    const field = fname ? info.fields.get(fname) : null;
    if (field?.kind !== 'closure' || !field.initNode) continue;
    const initNode = field.initNode;
    if (initNode.type !== 'ArrowFunctionExpression' && initNode.type !== 'FunctionExpression')
      continue;
    emitClosureFunction(`${className}_${fname}_default`, className, field, initNode, out);
  }
}

// Case C: `this.<field>.<closureField> = () => {...}` anywhere in this class's own
// method bodies (e.g. rp2350.ts's `this.watchdog.onWatchdogTrigger = () => {
// this.reset(); ... }`) — a cross-instance override, closing over THIS class's own
// `this`, not the field's owning class. Emits the closure function up front (same
// reasoning as Case A) and stashes its name directly on the AssignmentExpression AST
// node so the real codegen pass (AssignmentExpression in emitExpr, reached later
// while walking this exact same parsed tree) can find it again without re-deriving
// it — this file is only parsed once per pass, so node identity holds between this
// prescan and the statement's real emission.
function collectExternalClosureAssignments(classNode, className, out) {
  let counter = 0;
  const walk = (n) => {
    if (!n || typeof n !== 'object') return;
    if (Array.isArray(n)) {
      for (const c of n) walk(c);
      return;
    }
    if (
      n.type === 'AssignmentExpression' &&
      n.operator === '=' &&
      n.left?.type === 'MemberExpression' &&
      !n.left.computed &&
      n.left.object?.type === 'MemberExpression' &&
      !n.left.object.computed &&
      n.left.object.object?.type === 'ThisExpression' &&
      (n.right.type === 'ArrowFunctionExpression' || n.right.type === 'FunctionExpression')
    ) {
      const midFieldName = n.left.object.property?.name;
      const closureFieldName = n.left.property?.name;
      const midField = midFieldName ? classes.get(className)?.fields?.get(midFieldName) : null;
      const midClassName = midField?.type?.endsWith('*') ? midField.type.slice(0, -1) : null;
      const targetField = midClassName
        ? classes.get(midClassName)?.fields?.get(closureFieldName)
        : null;
      if (targetField?.kind === 'closure') {
        const fnName = `${className}_${midFieldName}_${closureFieldName}_closure${counter++}`;
        n.__closureFnName = fnName;
        emitClosureFunction(fnName, className, targetField, n.right, out);
      }
    }
    for (const key in n) {
      if (key === 'loc' || key === 'start' || key === 'end' || key === 'range' || key[0] === '_')
        continue;
      walk(n[key]);
    }
  };
  walk(classNode.body.body);
}

function emitClassImpl(node, out) {
  const name = node.id?.name;
  const info = classes.get(name);
  if (!info) return;

  emitDefaultClosureFunctions(node, name, out);
  collectExternalClosureAssignments(node, name, out);

  // Synthesized inherited constructor (see resolveMissingConstructors): no ClassMethod
  // AST node exists for it, so emit the wrapper directly here instead of via the
  // member loop below. Allocates the full (subclass-sized) struct, builds the embedded
  // parent struct by calling straight through to the parent's own `_new` (itself
  // possibly ALSO a synthesized wrapper — recursion up the chain falls out naturally,
  // since each level just calls its own direct parent), copies it into the `base`
  // field, then runs this class's own field initializers (usually none).
  const ctorSig = info.methods.get('constructor');
  if (ctorSig?.inherited) {
    const paramStr = ctorSig.params.map((p) => `${p.type} ${cName(p.name)}`).join(', ');
    out.push(`static ${name}* ${name}_new(${paramStr}) {`);
    out.push(`  ${name}* self = calloc(1, sizeof(${name}));`);
    out.push(`  {`);
    out.push(
      `    ${info.parent}* __base = ${info.parent}_new(${ctorSig.params
        .map((p) => cName(p.name))
        .join(', ')});`
    );
    out.push(`    self->base = *__base;`);
    out.push(`    free(__base);`);
    out.push(`  }`);
    // Same self-vtable field assignment as a real constructor — see
    // assignInterfaceSelfVtableFields and the matching comment at the real
    // constructor's own emission site.
    for (const ifaceName of getImplementedInterfaces(name)) {
      const root = findInterfaceRootClass(name, ifaceName);
      const fieldPath = root === name ? 'self' : selfPathTo('self', name, root);
      out.push(`  (${fieldPath})->__vtable_${ifaceName} = &${getVTableName(name, ifaceName)};`);
    }
    const allParams = [{ name: 'self', type: `${name}*` }, ...ctorSig.params];
    const scope = { self: name };
    for (const p of ctorSig.params) scope[p.name] = p.tsType ?? null;
    const classContext = { className: name, fields: info.fields, varTypes: scope };
    emitFieldInitializers(node, name, out, classContext, allParams);
    out.push(`  return self;`);
    out.push(`}`);
    out.push('');
  }

  for (const member of node.body.body) {
    if (member.type !== 'ClassMethod') continue;
    const mname = member.key?.name;

    // Getters/setters: real callable accessors (`ClassName_prop_get`/`_set`),
    // not plain field access — see the getter/setter collection comment in
    // collectTypes for why (the whole point is these have real bodies with real
    // side effects, e.g. timer32.ts's `set enable(value)` re-deriving other
    // state, not just a stored value). Read/write call sites are rewired in
    // emitExpr's MemberExpression case and AssignmentExpression respectively.
    if (member.kind === 'get' || member.kind === 'set') {
      const isGetter = member.kind === 'get';
      const accessorFullName = `${name}_${mname}_${isGetter ? 'get' : 'set'}`;
      if (emittedFunctions.has(accessorFullName)) continue;
      emittedFunctions.add(accessorFullName);
      const sig = isGetter ? info.getters.get(mname) : info.setters.get(mname);
      if (!sig) continue;
      const retType = isGetter ? sig.retType : 'void';
      const valueParam = isGetter
        ? []
        : [{ name: member.params[0]?.name ?? 'value', type: sig.paramType }];
      const params = [{ name: 'self', type: `${name}*` }, ...valueParam];
      const paramStr = params.map((p) => `${p.type} ${cName(p.name)}`).join(', ');
      // Same "unsupported JS construct" stub bucket as the regular-method one just
      // below (fifo.ts's `get items()` builds a result via `const result = []`
      // then indexed-assigns into it — an empty-array-literal-then-grow pattern
      // cts2c doesn't support).
      if (`${name}.${mname}` === 'FIFO.items') {
        out.push(
          `static ${retType} ${accessorFullName}(${paramStr}) { /* TODO: stubbed: uses unsupported JS${loc(
            member
          )} */ ${stubAbortStmt(`${name}.${mname}${loc(member)}`)} }`
        );
        out.push('');
        continue;
      }
      out.push(`static ${retType} ${accessorFullName}(${paramStr}) {`);
      const scope = { self: name };
      for (const p of valueParam)
        scope[p.name] = p.tsType ?? (p.type.endsWith('*') ? p.type.slice(0, -1) : null);
      const classContext = { className: name, fields: info.fields, varTypes: scope, retType };
      emitBody(member.body, name, params, out, classContext);
      emitFallbackReturn(member.body, retType, out);
      out.push(`}`);
      out.push('');
      continue;
    }

    const msig = info.methods.get(mname);
    if (!msig) continue;

    // Skip duplicate method implementations (RP2040/RP2350 variant)
    const fullName = `${name}_${mname}`;
    if (emittedFunctions.has(fullName)) continue;
    emittedFunctions.add(fullName);

    // debug/info/warn/error bodies are always just a thin wrapper forwarding to
    // a Logger interface (`this.rp2040.logger.warn(this.name, msg)`) — an
    // interface property/method chain cts2c doesn't transpile — so their real
    // TS body is never emitted; instead give them a genuine printf-based
    // implementation directly, using whichever component name is available
    // (a `name` struct field if this class has one, else the class name
    // itself), so messages like "Unimplemented peripheral read from 0x..."
    // actually reach stderr instead of being silently dropped.
    if (['debug', 'info', 'warn', 'error'].includes(mname)) {
      const params = [{ name: 'self', type: `${name}*` }, ...msig.params];
      const paramStr = params.map((p) => `${p.type} ${cName(p.name)}`).join(', ');
      const msgParam = cName(msig.params[0]?.name ?? 'msg');
      const nameExpr = info.fields.has('name') ? `self->name` : `"${name}"`;
      out.push(`static ${msig.retType} ${name}_${mname}(${paramStr}) {`);
      out.push(`  fprintf(stderr, "[%s] %s\\n", ${nameExpr}, ${msgParam});`);
      out.push(`}`);
      out.push('');
      continue;
    }

    // RP2040RTC (rtc.ts) uses `Date` for its wall-clock read/reconstruct logic, which
    // cts2c has no support for at all (see the `baseline` field-initializer skip in
    // emitFieldInitializers below for the matching constructor-side half of this).
    // Rather than teaching cts2c a general Date feature, hand-write these two methods:
    // the real register bookkeeping (setup0/setup1/ctrl) is preserved, but the actual
    // Date-backed wall-clock value is stubbed out with a runtime warning instead of
    // computed — same by-name-override precedent as checkTraceMagic/loadFirmwareFromUF2.
    if (name === 'RP2040RTC' && (mname === 'readUint32' || mname === 'writeUint32')) {
      const params = [{ name: 'self', type: `${name}*` }, ...msig.params];
      const paramStr = params.map((p) => `${p.type} ${cName(p.name)}`).join(', ');
      out.push(`static ${msig.retType} ${name}_${mname}(${paramStr}) {`);
      if (mname === 'readUint32') {
        out.push(`  switch (offset) {`);
        out.push(`  case RTC_SETUP0: return self->setup0;`);
        out.push(`  case RTC_SETUP1: return self->setup1;`);
        out.push(`  case RTC_CTRL: return self->ctrl;`);
        out.push(`  case IRQ_SETUP_0: return 0;`);
        out.push(`  case RTC_RTC1:`);
        out.push(`  case RTC_RTC0:`);
        out.push(
          `    fprintf(stderr, "[%s] RTC wall-clock read (offset 0x%x) is stubbed in the C build (no Date support in cts2c) -- returning 0\\n", self->base.name, offset);`
        );
        out.push(`    return 0;`);
        out.push(`  default: break;`);
        out.push(`  }`);
        out.push(`  return BasePeripheral__RP2040_readUint32(&self->base, offset);`);
      } else {
        out.push(`  switch (offset) {`);
        out.push(`  case RTC_SETUP0: self->setup0 = value; break;`);
        out.push(`  case RTC_SETUP1: self->setup1 = value; break;`);
        out.push(`  case RTC_CTRL:`);
        out.push(`    if (value & RTC_LOAD_BITS) self->ctrl |= RTC_LOAD_BITS;`);
        out.push(`    if (value & RTC_ENABLE_BITS) {`);
        out.push(`      self->ctrl |= RTC_ENABLE_BITS;`);
        out.push(`      self->ctrl |= RTC_ACTIVE_BITS;`);
        out.push(`      if (self->ctrl & RTC_LOAD_BITS) {`);
        out.push(
          `        fprintf(stderr, "[%s] RTC_LOAD (offset 0x%x) is stubbed in the C build (no Date support in cts2c) -- setup0/setup1 recorded but not applied to wall clock\\n", self->base.name, offset);`
        );
        out.push(
          `        self->baselineNanos = SimulationClock_getNanos(self->base.rpchip->clock);`
        );
        out.push(`        self->ctrl &= ~RTC_LOAD_BITS;`);
        out.push(`      }`);
        out.push(`    } else {`);
        out.push(`      self->ctrl &= ~RTC_ENABLE_BITS;`);
        out.push(`      self->ctrl &= ~RTC_ACTIVE_BITS;`);
        out.push(`    }`);
        out.push(`    break;`);
        out.push(`  default:`);
        out.push(`    BasePeripheral__RP2040_writeUint32(&self->base, offset, value);`);
        out.push(`  }`);
      }
      out.push(`}`);
      out.push('');
      continue;
    }

    // Skip methods that use unsupported patterns (RegExp, string ops, interface property chains)
    if (['printDisassembly', 'checkTraceMagic'].includes(mname)) {
      const params = [{ name: 'self', type: `${name}*` }, ...msig.params];
      const paramStr = params.map((p) => `${p.type} ${cName(p.name)}`).join(', ');
      out.push(
        `static ${
          msig.retType
        } ${name}_${mname}(${paramStr}) { /* TODO: stubbed: uses unsupported JS${loc(member)} */ }`
      );
      out.push('');
      continue;
    }

    if (msig.isConstructor) {
      const params = msig.params;
      const paramStr = params.map((p) => `${p.type} ${cName(p.name)}`).join(', ');
      out.push(`static ${name}* ${name}_new(${paramStr}) {`);
      out.push(`  ${name}* self = calloc(1, sizeof(${name}));`);

      // Build scope for type tracking
      const allParams = [{ name: 'self', type: `${name}*` }, ...params];
      const scope = { self: name };
      for (const p of params) {
        const tsName = p.tsType;
        scope[p.name] = tsName ?? null;
      }
      const classContext = { className: name, fields: info.fields, varTypes: scope };
      // See emitBody's own comment — a `let x = null;` declaration anywhere in the
      // body looks ahead through this for its first reassignment's type.
      classContext.funcBodyNode = member.body;

      // Real TS/JS constructor order: super() (if present) runs first, THEN parameter
      // property assignment, THEN field initializers, THEN the rest of the body. A
      // leading `super(...)` call sets up `self->base` (the parent class's fields) —
      // field initializers that read an INHERITED field through it (e.g. pio.ts's
      // `machines = [new StateMachine(this.rp2040, this, 0), ...]`, where `rp2040` is
      // BasePeripheral's field, reached via `self->base.rp2040`) need that value to
      // already be there. Emitting it first, before this class's own param-property
      // assignment and field initializers, is what makes that correct.
      const bodyStmts = member.body.body;
      const leadingSuperCall =
        bodyStmts[0]?.type === 'ExpressionStatement' &&
        bodyStmts[0].expression?.type === 'CallExpression' &&
        bodyStmts[0].expression.callee?.type === 'Super';
      if (leadingSuperCall) emitStmt(bodyStmts[0], name, allParams, out, classContext);

      // Store this class's OWN concrete vtable for each interface it implements — see
      // assignInterfaceSelfVtableFields for why (real dispatch for `this.method()`
      // calls made from a shared ancestor method). Every class in the hierarchy sets
      // this unconditionally in its own constructor, so the leaf class (whichever
      // constructor runs last) always leaves the true most-derived vtable behind.
      // MUST run after the leading super() call above: super() compiles to a memcpy
      // of the entire parent struct (including its own __vtable_* field) into
      // `self->base` — setting our vtable before that memcpy just gets clobbered by
      // the parent's vtable a moment later.
      const implIfaces = getImplementedInterfaces(name);
      for (const ifaceName of implIfaces) {
        const root = findInterfaceRootClass(name, ifaceName);
        const fieldPath = root === name ? 'self' : selfPathTo('self', name, root);
        out.push(`  (${fieldPath})->__vtable_${ifaceName} = &${getVTableName(name, ifaceName)};`);
      }

      // TS parameter properties (`constructor(readonly rp2040: ChipType, ...)`) were
      // already collected as real struct fields (see collectTypes's `TSParameterProperty`
      // handling), but the actual `self->x = x;` assignment must also be emitted here —
      // collection only tracks the struct layout, not the runtime behavior a real TS
      // constructor auto-generates for each parameter property.
      for (const p of member.params) {
        if (p.type !== 'TSParameterProperty') continue;
        // `readonly x: T = default` — a parameter property WITH a default value — has an
        // AssignmentPattern as `p.parameter`, so its name lives on `.left`, not on the
        // parameter node itself; guarding on `p.parameter?.name` alone would skip it.
        const realParam =
          p.parameter?.type === 'AssignmentPattern' ? p.parameter.left : p.parameter;
        const pname = realParam?.name;
        if (!pname) continue;
        out.push(`  self->${cName(pname)} = ${cName(pname)};`);
      }

      // Class field initializers (real TS/JS semantics: they execute in declaration
      // order, after super()/parameter properties, before the rest of the constructor
      // body) — see the "Class field initializers" comment at their collection site
      // for why this was missing entirely before.
      emitFieldInitializers(node, name, out, classContext, allParams);

      for (const stmt of leadingSuperCall ? bodyStmts.slice(1) : bodyStmts) {
        emitStmt(stmt, name, allParams, out, classContext);
      }
      out.push(`  return self;`);
      out.push(`}`);
      out.push('');
    } else {
      const params = [{ name: 'self', type: `${name}*` }, ...msig.params];
      const paramStr = params.map((p) => `${p.type} ${cName(p.name)}`).join(', ');
      // Optimization: noinline stepPios as otherwise stepThings' prologue
      // would get much more expensive
      const noInline = mname === 'stepPios' ? '__attribute__((noinline)) ' : '';
      out.push(`${noInline}static ${msig.retType} ${name}_${mname}(${paramStr}) {`);
      const scope = { self: name };
      for (const p of msig.params) {
        // Prefer the TS type name collected at param-collection time (handles
        // anything cTypeOf maps to void* — Record, Map, etc. — where stripping the
        // C type's trailing '*' would wrongly yield "void" instead of e.g. "Record").
        // Only fall back to that guess for params with no tracked tsType at all.
        scope[p.name] = p.tsType ?? (p.type.endsWith('*') ? p.type.slice(0, -1) : null);
      }
      const classContext = {
        className: name,
        fields: info.fields,
        varTypes: scope,
        retType: msig.retType,
      };
      emitBody(member.body, name, params, out, classContext);
      emitFallbackReturn(member.body, msig.retType, out);
      out.push(`}`);
      out.push('');
    }
  }
}

// C requires a non-void function to return a value on every path; TS/JS lets one just
// fall off the end (the caller gets `undefined`). Without a terminal return, such a
// function returns whatever garbage is in the return register — gcc `-Wreturn-type`
// flagged two: RPUART_wordLength_get (an exhaustive switch over a 2-bit field, so gcc
// can't prove it always returns) and RPPWM_writeUint32 (inferred non-void because some
// paths return a value, but its `default:` branch doesn't). Both are benign today purely
// by luck. Emitted as a compound literal so one form covers a scalar, a pointer, and an
// interface fat-pointer struct alike.
function emitFallbackReturn(body, retType, out) {
  if (!retType || retType === 'void') return;
  // An arrow's expression body always compiles to a single `return <expr>;` (see emitBody).
  if (body?.type !== 'BlockStatement') return;
  const last = body.body[body.body.length - 1];
  if (last && (last.type === 'ReturnStatement' || last.type === 'ThrowStatement')) return;
  out.push(`  return (${retType}){0};`);
}

// ─── Statement emission ─────────────────────────────────────────────
function emitBody(body, funcName, params, out, ctx) {
  // Stash the whole function/method body so a `let x = null;` declaration (see
  // VariableDeclaration in emitStmt) can look ahead for the first `x = <expr>`
  // reassignment anywhere in this body and infer its real type from that, instead of
  // defaulting to int32_t just because its own initializer carries no type info.
  ctx.funcBodyNode = body;
  if (body.type === 'BlockStatement') {
    for (const stmt of body.body) {
      emitStmt(stmt, funcName, params, out, ctx);
    }
  } else {
    // Expression body (arrow)
    const expr = emitExpr(body, funcName, params, ctx);
    out.push(`  return ${expr};`);
  }
}

function emitStmt(node, funcName, params, out, ctx) {
  switch (node.type) {
    case 'VariableDeclaration': {
      for (const decl of node.declarations) {
        // Object destructuring: const { a, b } = expr → expand
        if (decl.id?.type === 'ObjectPattern') {
          const initStr = emitExpr(decl.init, funcName, params, ctx);
          const destructFieldType = resolveExprType(decl.init, ctx);
          // Evaluate the initializer exactly once into a temp, then destructure every
          // property from THAT — using `initStr` directly at each property instead
          // would re-emit, and so re-evaluate, the initializer once per destructured
          // property, harmless for a bare field read but wrong for a call expression
          // with side effects. Only applied when the resolved type is a known class (a
          // real pointer type to declare the temp as); otherwise falls back to the
          // direct-emit behavior rather than declaring a temp with an unsafe type.
          const destructTmp =
            destructFieldType && classes.has(destructFieldType)
              ? `__destruct_tmp_${(ctx.__destructCounter = (ctx.__destructCounter || 0) + 1)}`
              : null;
          if (destructTmp) out.push(`  ${destructFieldType}* ${destructTmp} = ${initStr};`);
          const destructInitStr = destructTmp ?? initStr;
          for (const prop of decl.id.properties) {
            const varName = prop.value?.name || prop.key?.name;
            if (!varName) continue;
            // Resolve type from the source object's field type
            let varType = 'int32_t';
            let tsTypeName = null;
            const fieldType = destructFieldType;
            if (fieldType && classes.has(fieldType)) {
              const field = classes.get(fieldType)?.fields?.get(prop.key?.name);
              if (field) {
                varType = field.type;
                tsTypeName = field.tsType;
                // Array-shaped fields don't track a plain tsType (see the isArray
                // comments elsewhere) — without tracking *something* here, a later
                // computed access on this destructured local (`gpio[idx]`) has no way
                // to resolve its element type at all (ctx.varTypes has nothing for it),
                // defaulting the whole chain back to int32_t. Track the field's own C
                // type, pre-stripped by one level for double-pointer (class-array)
                // fields the same way the struct-field lookup branches already do, so
                // the computed-access consumer's own single strip lands on the bare
                // element type instead of an still-a-pointer string.
                if (!tsTypeName && field.isArray) {
                  tsTypeName = field.type.endsWith('**') ? field.type.slice(0, -1) : field.type;
                }
                // Carry the source field's sizeNode (if any) forward onto this local —
                // `.length` on the destructured local (`qspi.length` from `const {
                // qspi } = this.rp2040;`) needs the SAME lookup the direct `this.field
                // .length` case already gets (see the MemberExpression '.length' case),
                // which only ever consults resolveFieldInfo — a no-op once the field is
                // reached through a plain local Identifier instead of another
                // MemberExpression.
                if (field.sizeNode && ctx) {
                  ctx.localSizeNodes ??= {};
                  ctx.localSizeNodes[varName] = field.sizeNode;
                }
              }
            }
            if (tsTypeName && ctx?.varTypes) ctx.varTypes[varName] = tsTypeName;
            const isGetter =
              fieldType && classes.has(fieldType)
                ? classes.get(fieldType)?.getters?.has(prop.key?.name)
                : false;
            const rhs = isGetter
              ? `${fieldType}_${cName(prop.key?.name)}_get(${destructInitStr})`
              : `${destructInitStr}->${cName(prop.key?.name)}`;
            out.push(`  ${varType} ${cName(varName)} = ${rhs};`);
          }
          continue;
        }

        // Array destructuring: const [a, b] = expr → expand (limited)
        if (decl.id?.type === 'ArrayPattern') {
          const initStr = emitExpr(decl.init, funcName, params, ctx);
          for (let i = 0; i < decl.id.elements.length; i++) {
            const el = decl.id.elements[i];
            if (!el?.name) continue;
            out.push(`  int32_t ${cName(el.name)} = ${initStr}[${i}];`);
          }
          continue;
        }

        const name = decl.id?.name;
        if (!name) continue;

        // Check for typed array allocation
        if (decl.init?.type === 'NewExpression') {
          const ctor = decl.init.callee?.name;
          if (ctor && ctor.match(/^(Int|Uint|Float)(8|16|32|53|64)Array$/)) {
            const elType = typedArrayCType(ctor);
            const size = emitExpr(decl.init.arguments[0], funcName, params, ctx);
            out.push(`  ${elType}* ${cName(name)} = calloc(${size}, sizeof(${elType}));`);
            continue;
          }
        }

        // Local arrow function: capture for inlining
        if (decl.init?.type === 'ArrowFunctionExpression') {
          const arrowParams = collectParams(decl.init.params);
          const bodyExpr = decl.init.body;
          // Store in context for call inlining
          if (!ctx.localFunctions) ctx.localFunctions = {};
          ctx.localFunctions[name] = { params: arrowParams, body: bodyExpr };
          // Emit as a local function definition.
          // An arrow with no return-type annotation (the common case — e.g. `const
          // distance = (crossing: number) => { ...; return d <= 0 ? d + period : d;
          // };`) always defaulted to 'void', regardless of whether it actually
          // returns a value — every OTHER untyped-return-type inference in cts2c
          // (class methods, free functions) instead checks for a bare/no return vs.
          // a value-returning one and falls back to int32_t, not void. Match that.
          let retType = 'void';
          if (decl.init.returnType) {
            retType = cTypeOf(decl.init.returnType);
          } else {
            if (bodyExpr.type !== 'BlockStatement' || hasValueReturn(bodyExpr)) retType = 'int32_t';
          }
          const paramStr = arrowParams.map((p) => `${p.type} ${cName(p.name)}`).join(', ');
          out.push(`  ${retType} ${name}(${paramStr || 'void'}) {`);
          // Recursively emit the body with the arrow's own context
          const arrowCtx = {
            className: ctx.className,
            fields: ctx.fields,
            varTypes: { ...ctx.varTypes },
            localFunctions: ctx.localFunctions,
          };
          for (const ap of arrowParams) if (ap.tsType) arrowCtx.varTypes[ap.name] = ap.tsType;
          emitBody(bodyExpr, name, arrowParams, out, arrowCtx);
          emitFallbackReturn(bodyExpr, retType, out);
          out.push(`  }`);
          continue;
        }

        let init = decl.init ? emitExpr(decl.init, funcName, params, ctx) : '0';
        // Infer type from annotation, or from the initializer expression
        let varType = 'int32_t';
        let tsTypeName = null;
        if (decl.id.typeAnnotation) {
          let inner = decl.id.typeAnnotation;
          if (inner.type === 'TSTypeAnnotation') inner = inner.typeAnnotation;
          if (inner.type === 'TSTypeReference') tsTypeName = inner.typeName?.name;
          varType = cTypeOf(decl.id.typeAnnotation);
          // An explicit array/tuple-of-class annotation (e.g. `const states: [Foo,
          // Foo] = ...`) resolves to a class-pointer-array C type (Foo**) — track it
          // in varTypes the same "one already stripped" way an array-shaped class
          // FIELD does (see the isArray comments elsewhere), so a later computed
          // access (`states[i]`) resolves through Identifier lookup instead of
          // silently defaulting to int32_t.
          if (!tsTypeName && varType.endsWith('**') && classes.has(varType.slice(0, -2))) {
            tsTypeName = varType.slice(0, -1);
          }
        } else if (decl.init?.type === 'StringLiteral') {
          // `let profTag = '';` — a plain string-literal initializer, no annotation.
          varType = 'const char*';
        } else if (decl.init) {
          // Try to infer type from the initializer
          const inferred = resolveExprType(decl.init, ctx);
          if (inferred) {
            tsTypeName = inferred;
            if (classes.has(inferred)) varType = `${inferred}*`;
            else if (interfaces.has(inferred)) varType = inferred;
            else if (enums.has(inferred)) varType = inferred;
          }
          // Also check field type directly (for interface fields accessed via base chain)
          if (
            varType === 'int32_t' &&
            decl.init?.type === 'MemberExpression' &&
            !decl.init.computed
          ) {
            const fieldInfo = resolveFieldInfo(decl.init, ctx);
            if (fieldInfo?.type) {
              varType = fieldInfo.type;
              if (fieldInfo.tsType) tsTypeName = fieldInfo.tsType;
            }
          }
          // `const a = regs.s[sn];` — indexing into an array/typed-array field. The
          // check just above only matches a BARE (non-computed) field reference:
          // resolveFieldInfo on the whole `regs.s[sn]` node tries to look up a field
          // named after the INDEX variable ("sn"), not "s", and finds nothing.
          // Resolve fieldInfo on the object being indexed instead, and strip one
          // trailing '*' to reach the per-element type (e.g. Float32Array's own
          // `float*` field type → `float` for a single indexed read). Without this,
          // `const a = regs.s[sn];` defaulted to int32_t, truncating every real
          // float32 register value to an integer before any FPU arithmetic ran.
          if (
            varType === 'int32_t' &&
            decl.init?.type === 'MemberExpression' &&
            decl.init.computed
          ) {
            const containerInfo = resolveFieldInfo(decl.init.object, ctx);
            if (
              containerInfo?.type?.endsWith('*') &&
              !containerInfo.type.includes(' ') &&
              (containerInfo.isArray || containerInfo.isTypedArray)
            ) {
              varType = containerInfo.type.slice(0, -1);
            }
          }
          // free_function(...) → use its own collected/inferred retType directly (not
          // just for class pointers — e.g. `const hours = leftPad(...)` needs
          // `const char*`, which isn't a class/interface/enum name resolveExprType's
          // generic handling above would recognize).
          if (
            varType === 'int32_t' &&
            decl.init?.type === 'CallExpression' &&
            decl.init.callee?.type === 'Identifier'
          ) {
            const fn = freeFunctions.get(decl.init.callee.name);
            if (fn && fn.retType !== 'int32_t' && fn.retType !== 'void') {
              varType = fn.retType;
              if (varType.endsWith('*') && !varType.includes(' ')) {
                const base = varType.slice(0, -1);
                if (classes.has(base)) tsTypeName = base;
              }
            }
          }
          // `const buf = arr.slice(...)` / `arr.subarray(...)` — emitExpr's TODO-stub
          // for both just returns the object expression itself unmodified (no real
          // slicing support yet), so the declared local's type should match the
          // object's own type, not fall back to int32_t (which produced "int32_t x =
          // <a real pointer expression>", a genuine type error, not just a TODO gap).
          if (
            varType === 'int32_t' &&
            decl.init?.type === 'CallExpression' &&
            decl.init.callee?.type === 'MemberExpression' &&
            (decl.init.callee.property?.name === 'slice' ||
              decl.init.callee.property?.name === 'subarray')
          ) {
            const sliceObj = decl.init.callee.object;
            let fieldInfo =
              sliceObj?.type === 'MemberExpression' ? resolveFieldInfo(sliceObj, ctx) : null;
            if (!fieldInfo && sliceObj?.type === 'MemberExpression') {
              // resolveFieldInfo only handles a direct this./identifier-typed object —
              // fall back to the general resolver for a chained access like
              // `this.rp2040.usbDPRAM` (object is itself a MemberExpression).
              const objType = resolveExprType(sliceObj.object, ctx);
              const propName = sliceObj.property?.name;
              let cls = objType ? classes.get(objType) : null;
              while (cls && propName) {
                fieldInfo = cls.fields?.get(propName);
                if (fieldInfo) break;
                cls = cls.parent ? classes.get(cls.parent) : null;
              }
            }
            if (fieldInfo?.type) varType = fieldInfo.type;
          }
          // `const data = readFileSync(path)` — always a real string (see the
          // `readFileSync` runtime helper in the preamble).
          if (
            varType === 'int32_t' &&
            decl.init?.type === 'CallExpression' &&
            decl.init.callee?.type === 'Identifier' &&
            decl.init.callee.name === 'readFileSync'
          ) {
            varType = 'const char*';
          }
          // `const s = line.substring(a, b)` — always a real string (strSubstring, see
          // preamble), unlike slice/subarray above which need the source object's own
          // type since they're still TODO-stubbed passthroughs.
          if (
            varType === 'int32_t' &&
            decl.init?.type === 'CallExpression' &&
            decl.init.callee?.type === 'MemberExpression' &&
            decl.init.callee.property?.name === 'substring'
          ) {
            varType = 'const char*';
          }
          // `const x = arr.shift()` / `arr.pop()` — same TODO-stub-typing gap as slice/
          // subarray above, but these return one ELEMENT (one pointer level stripped
          // from the array's own storage type), not the whole array.
          if (
            varType === 'int32_t' &&
            decl.init?.type === 'CallExpression' &&
            decl.init.callee?.type === 'MemberExpression' &&
            (decl.init.callee.property?.name === 'shift' ||
              decl.init.callee.property?.name === 'pop')
          ) {
            const arrObj = decl.init.callee.object;
            let fieldInfo =
              arrObj?.type === 'MemberExpression' ? resolveFieldInfo(arrObj, ctx) : null;
            if (fieldInfo?.type?.endsWith('*')) varType = fieldInfo.type.slice(0, -1);
          }
          // this.method()/obj.method(...) → same idea as the free-function case just
          // above, but for method calls: resolveExprType's generic handling only ever
          // returns a class-pointer or bare-interface-name "TS type name", so a method
          // declared to return a raw C scalar type (`disasmContext(...): string |
          // undefined` → const char*) was never picked up here.
          if (
            varType === 'int32_t' &&
            decl.init?.type === 'CallExpression' &&
            decl.init.callee?.type === 'MemberExpression'
          ) {
            const methodName = decl.init.callee.property?.name;
            const objType =
              decl.init.callee.object?.type === 'ThisExpression'
                ? ctx.className
                : resolveExprType(decl.init.callee.object, ctx);
            let cls = objType ? classes.get(objType) : null;
            while (cls) {
              const msig = cls.methods?.get(methodName);
              if (msig) {
                if (msig.retType !== 'int32_t' && msig.retType !== 'void') varType = msig.retType;
                break;
              }
              cls = cls.parent ? classes.get(cls.parent) : null;
            }
          }
          // `const x = a + b;` where the `+` is string concatenation (see the
          // BinaryExpression '+' case's own isCharPtrExpr check) — the initializer
          // compiles to a real `strConcat2(...)` call, but without this the local's
          // OWN declared C type still defaulted to int32_t (BinaryExpression's usual
          // numeric-result assumption), producing an "initialization of int32_t from
          // char*" mismatch.
          if (
            varType === 'int32_t' &&
            decl.init?.type === 'BinaryExpression' &&
            decl.init.operator === '+' &&
            (isCharPtrExpr(decl.init.left, params, ctx) ||
              isCharPtrExpr(decl.init.right, params, ctx))
          ) {
            varType = 'const char*';
          }
          // `let x = null;` carries no type info of its own — look ahead in the rest of
          // this function/method for the first `x = <expr>` reassignment and infer from
          // that (common pattern: declare a nullable "found it yet?" pointer before a
          // loop, assign the real value inside the loop).
          if (varType === 'int32_t' && decl.init?.type === 'NullLiteral' && ctx.funcBodyNode) {
            const t = findReassignmentType(name, ctx.funcBodyNode, ctx);
            if (t) {
              tsTypeName = t;
              if (classes.has(t)) varType = `${t}*`;
              else if (interfaces.has(t)) varType = t;
              else if (enums.has(t)) varType = t;
            }
          }
        }
        // Track type in scope for method dispatch
        if (tsTypeName && ctx?.varTypes) ctx.varTypes[name] = tsTypeName;
        // Track const-char*-typed locals separately (ctx.varTypes only holds TS
        // class/interface/enum names, not raw C types) — isCharPtrExpr consults this
        // to decide whether a local participates in string concatenation/comparison
        // codegen (e.g. `const recordType = line.substring(7, 9);` then `recordType
        // === '04'`).
        if (varType === 'const char*' && ctx) {
          ctx.charPtrLocals ??= new Set();
          ctx.charPtrLocals.add(name);
        }
        // `let loadBase = Infinity;` (a "no real value found yet" sentinel, updated via
        // a running `if (addr < loadBase) loadBase = addr;` minimum search) — with no
        // type annotation this falls through to plain int32_t, but the initializer
        // would still emit the literal `INFINITY` (a double macro); assigning that to
        // an int32_t is UB in C and in practice becomes INT32_MIN, which no real
        // address compares less than, so the running-minimum update never fires.
        // INT32_MAX is the correct finite sentinel: any real address compares less
        // than it, so the first update still fires correctly.
        if (
          varType.match(/^u?int(8|16|32|64)_t$/) &&
          decl.init?.type === 'Identifier' &&
          decl.init.name === 'Infinity'
        ) {
          init = 'INT32_MAX';
        }
        out.push(`  ${varType} ${cName(name)} = ${castStubForType(init, varType)};`);
      }
      break;
    }
    case 'ExpressionStatement': {
      // `this.field = [new A(...), new B(...)]` — an array-literal-of-`new` assigned
      // mid-constructor (as opposed to at field-declaration time, which
      // emitFieldInitializers already handles) — e.g. rp2350.ts's `this.core = [new
      // CortexM33Core(...), new CortexM33Core(...)]` inside an `if (coreArch ===
      // 'arm')` branch. The generic ArrayExpression case has no target type to build
      // against and always stubs to a bare 0, so `self->core` would stay NULL forever.
      // Each element may need boxing into an interface fat pointer (core's declared
      // type is `ICpuCore[]`, a behavioral interface both CortexM33Core and CPU
      // implement) — reuse wrapArgIfInterfaceParam per element, same as everywhere
      // else a concrete instance meets an interface-typed slot.
      const assignExpr = node.expression;
      if (
        assignExpr?.type === 'AssignmentExpression' &&
        assignExpr.operator === '=' &&
        assignExpr.left.type === 'MemberExpression' &&
        !assignExpr.left.computed &&
        assignExpr.left.object?.type === 'ThisExpression' &&
        assignExpr.right.type === 'ArrayExpression' &&
        assignExpr.right.elements.length > 0 &&
        assignExpr.right.elements.every(
          (e) =>
            (e?.type === 'NewExpression' && classes.has(e.callee?.name)) ||
            // `this.coreState = [this.makeCoreState(0), this.makeCoreState(1)];` — same
            // idiom as the `new`-expression case above, but each element is a `this.`
            // method call (returning an already-heap-allocated pointer of the field's
            // own element type) rather than a fresh `new` allocation.
            (e?.type === 'CallExpression' &&
              e.callee?.type === 'MemberExpression' &&
              !e.callee.computed &&
              e.callee.object?.type === 'ThisExpression')
        )
      ) {
        const fname = assignExpr.left.property?.name;
        // `ctx.className`, not `funcName`: the two happen to coincide for a method or
        // constructor body, but inside a LOCAL ARROW FUNCTION nested in one, funcName is
        // the arrow's own name — so `this.field = [...]` there found no class and fell
        // through to the bare-`0` ArrayExpression stub, silently leaving the field NULL.
        const field = classes.get(ctx?.className)?.fields.get(fname);
        if (field?.isArray && (field.type.endsWith('**') || field.type.endsWith('*'))) {
          const elemType = field.type.slice(0, -1);
          const lhs = emitExpr(assignExpr.left, funcName, params, ctx);
          if (!field.inlineArray) {
            out.push(
              `  ${lhs} = calloc(${assignExpr.right.elements.length}, sizeof(${elemType}));`
            );
          }
          assignExpr.right.elements.forEach((e, i) => {
            const val = emitExpr(e, funcName, params, ctx);
            const wrapped = wrapArgIfInterfaceParam(val, e, elemType, ctx, funcName, params);
            out.push(`  ${lhs}[${i}] = ${wrapped};`);
          });
          break;
        }
      }
      // `this.field = { a: ..., b: ... };` — a plain object-literal assignment (as
      // opposed to a class-property initializer, which normalizePureDataInterfaces/
      // the field-initializer paths already handle) to a field whose type is a
      // promoted pure-data interface or a plain data class. The generic
      // ObjectExpression case has no target type to build a struct against and
      // stubs to a bare 0, so the field would stay NULL forever — e.g. a reusable
      // out-parameter scratch field set up once in the constructor (pio.ts's
      // `this.irqTargetScratch = { targetPio: pio, irqBit: 0 };`). Heap-allocated
      // (matches every other object-literal-return/argument construction site —
      // see wrapArgIfInterfaceParam) — a one-time per-instance cost, not per-call.
      if (
        assignExpr?.type === 'AssignmentExpression' &&
        assignExpr.operator === '=' &&
        assignExpr.left.type === 'MemberExpression' &&
        !assignExpr.left.computed &&
        assignExpr.left.object?.type === 'ThisExpression' &&
        assignExpr.right.type === 'ObjectExpression'
      ) {
        const fname = assignExpr.left.property?.name;
        // See the `ctx.className` note on the array-literal branch just above.
        const field = classes.get(ctx?.className)?.fields.get(fname);
        if (field?.type?.endsWith('*') && !field.type.includes(' ')) {
          const targetClass = field.type.slice(0, -1);
          const cls = classes.get(targetClass);
          if (cls) {
            const lhs = emitExpr(assignExpr.left, funcName, params, ctx);
            const inits = assignExpr.right.properties
              .filter(
                (p) =>
                  p.type === 'ObjectProperty' &&
                  (p.key?.name || p.key?.value) &&
                  cls.fields.has(p.key.name ?? p.key.value)
              )
              .map(
                (p) =>
                  `.${cName(p.key.name ?? p.key.value)} = ${emitExpr(
                    p.value,
                    funcName,
                    params,
                    ctx
                  )}`
              );
            out.push(
              `  ${lhs} = memcpy(malloc(sizeof(${targetClass})), &(${targetClass}){ ${inits.join(
                ', '
              )} }, sizeof(${targetClass}));`
            );
            break;
          }
        }
      }
      // `super(...)` — as an EXPRESSION this can only be `memcpy(&self->base,
      // Parent_new(args), sizeof(Parent))` (see emitExpr's Super case), which drops the
      // pointer Parent_new() just malloc'd on the floor: a leaked parent struct per
      // construction, at all 18 super() sites. As a STATEMENT — which is the only place
      // super() can legally appear in TS anyway — there's room for a temporary, so the
      // allocation can actually be freed. resolveMissingConstructors' synthesized wrapper
      // has always done exactly this (see its `free(__base)`); the hand-written path just
      // never caught up.
      if (node.expression?.type === 'CallExpression' && node.expression.callee?.type === 'Super') {
        const parentName = classes.get(ctx?.className)?.parent;
        if (parentName) {
          const args = node.expression.arguments.map((a) => emitExpr(a, funcName, params, ctx));
          const tmp = `__super_${switchTmpCounter++}`;
          out.push(`  {`);
          out.push(`    ${parentName}* ${tmp} = ${parentName}_new(${args.join(', ')});`);
          out.push(`    self->base = *${tmp};`);
          out.push(`    free(${tmp});`);
          out.push(`  }`);
          break;
        }
      }
      const expr = emitExpr(node.expression, funcName, params, ctx);
      out.push(`  ${expr};`);
      break;
    }
    case 'IfStatement': {
      const test = emitCondExpr(node.test, funcName, params, ctx);
      out.push(`  if (${test}) {`);
      if (node.consequent.type === 'BlockStatement') {
        for (const s of node.consequent.body) emitStmt(s, funcName, params, out, ctx);
      } else {
        emitStmt(node.consequent, funcName, params, out, ctx);
      }
      if (node.alternate) {
        out.push(`  } else {`);
        if (node.alternate.type === 'BlockStatement') {
          for (const s of node.alternate.body) emitStmt(s, funcName, params, out, ctx);
        } else {
          emitStmt(node.alternate, funcName, params, out, ctx);
        }
      }
      out.push(`  }`);
      break;
    }
    case 'ForStatement': {
      out.push(`  for (`);
      if (node.init) {
        if (node.init.type === 'VariableDeclaration') {
          // Emit every declarator, not just the first, so `for (let i = 0, n = ...; ...)`
          // declares both — all share the one hardcoded int32_t type, matching what a
          // comma-separated C for-init declaration requires.
          const decls = node.init.declarations
            .filter((d) => d.id?.name)
            .map((d) => `${cName(d.id.name)} = ${emitExpr(d.init, funcName, params, ctx)}`);
          out.push(`int32_t ${decls.join(', ')}`);
        } else {
          out.push(emitExpr(node.init, funcName, params, ctx));
        }
      }
      out.push(
        `; ${node.test ? emitCondExpr(node.test, funcName, params, ctx) : '1'}; ${
          node.update ? emitExpr(node.update, funcName, params, ctx) : ''
        }) {`
      );
      if (node.body.type === 'BlockStatement') {
        for (const s of node.body.body) emitStmt(s, funcName, params, out, ctx);
      } else {
        emitStmt(node.body, funcName, params, out, ctx);
      }
      out.push(`  }`);
      break;
    }
    // Handle an unbraced single-statement body (`while (x) x--;`) same as IfStatement/
    // ForStatement do, so it doesn't silently become an infinite `while (x) { }`.
    case 'WhileStatement': {
      const test = emitCondExpr(node.test, funcName, params, ctx);
      out.push(`  while (${test}) {`);
      if (node.body.type === 'BlockStatement') {
        for (const s of node.body.body) emitStmt(s, funcName, params, out, ctx);
      } else {
        emitStmt(node.body, funcName, params, out, ctx);
      }
      out.push(`  }`);
      break;
    }
    case 'DoWhileStatement': {
      out.push(`  do {`);
      if (node.body.type === 'BlockStatement') {
        for (const s of node.body.body) emitStmt(s, funcName, params, out, ctx);
      } else {
        emitStmt(node.body, funcName, params, out, ctx);
      }
      const test = emitCondExpr(node.test, funcName, params, ctx);
      out.push(`  } while (${test});`);
      break;
    }
    case 'SwitchStatement': {
      // C can't switch on strings (case labels must be integer constants) — lower to an
      // if/else-if chain of strcmp() instead. Wrapped in `do {} while(0)` (not a bare
      // block) so any `break;` in the original case bodies — which targeted the switch,
      // not an enclosing loop — still has something to break out of. Safe as long as
      // none of the case bodies contain `continue` (which in real JS/TS switch targets
      // an enclosing loop, not the switch, and `do-while` would wrongly intercept it) —
      // not worth a general check since a `switch` body containing a bare `continue`
      // that skips past the switch is a vanishingly rare pattern in this codebase.
      if (node.cases.some((c) => c.test?.type === 'StringLiteral')) {
        const discStr = emitExpr(node.discriminant, funcName, params, ctx);
        const tmp = `__switch_tmp_${switchTmpCounter++}`;
        out.push(`  do { const char* ${tmp} = ${discStr};`);
        // `default` becomes the chain's final `else`, so it has to be emitted LAST
        // regardless of where it sits in the source — an `else { }` followed by another
        // `else if` isn't even valid C. Every string switch in this codebase happens to
        // put `default` last today, so this is a latent-shape fix, not a live one.
        const strCases = [
          ...node.cases.filter((c) => c.test),
          ...node.cases.filter((c) => !c.test),
        ];
        let first = true;
        for (const c of strCases) {
          if (c.test) {
            const val = emitExpr(c.test, funcName, params, ctx);
            out.push(`  ${first ? 'if' : 'else if'} (strcmp(${tmp}, ${val}) == 0) {`);
          } else {
            out.push(`  else {`);
          }
          first = false;
          for (const s of c.consequent) emitStmt(s, funcName, params, out, ctx);
          out.push(`  }`);
        }
        out.push(`  } while (0);`);
        break;
      }

      // Emit every case label up front (once — emitting a label expression twice would
      // also repeat emitExpr's own bookkeeping side effects). C requires a case label to
      // be an integer CONSTANT expression, but this codebase legitimately uses
      // runtime-valued ones — `case INTR + this.irq_reg_offset:` (pio.ts), `case
      // this.INTE:` (timer.ts) — for a peripheral whose interrupt-register block sits
      // at an instance-specific offset.
      //
      // Handled without giving up either the switch (and its jump table — this is
      // every peripheral's MMIO dispatch, squarely on the hot path) or C's fallthrough
      // semantics, both of which an if/else-if lowering would cost: pio.ts's `case
      // RP2350_GPIOBASE:` genuinely relies on CONDITIONAL fallthrough into `default:`.
      // Instead, give each dynamic case a real C label in the exact position its `case`
      // would have occupied, and reach it with a plain `goto` from an if-chain emitted
      // just BEFORE the switch — jumping into a switch body is ordinary standard C (a
      // label inside a switch is just a label). Source order among the pre-dispatch
      // tests is preserved, and all of them run before the switch is entered, so a
      // dynamic label can never lose a match to `default:`.
      const caseLabels = node.cases.map((c) =>
        c.test ? emitExpr(c.test, funcName, params, ctx) : null
      );
      const isDynamicLabel = (s) =>
        s !== null &&
        (s.includes('->') ||
          s.includes('self') ||
          s.startsWith('(0)') ||
          s.includes('__extension__'));
      const dynamicIdx = caseLabels
        .map((s, i) => (isDynamicLabel(s) ? i : -1))
        .filter((i) => i !== -1);
      const disc = emitExpr(node.discriminant, funcName, params, ctx);
      // Only a switch that actually HAS a dynamic label pays for the enclosing block and
      // the discriminant temporary; a fully-static switch is emitted exactly as before.
      const dynTag = dynamicIdx.length ? `__dyncase_${switchTmpCounter++}` : null;
      let discExpr = disc;
      if (dynTag) {
        // The discriminant feeds both the pre-dispatch chain and the switch — evaluate
        // it exactly once (it's an arbitrary expression, e.g. a shifted register field).
        discExpr = `${dynTag}_disc`;
        out.push(`  {`);
        out.push(`  int32_t ${discExpr} = ${disc};`);
        for (const i of dynamicIdx) {
          out.push(`  if (${discExpr} == (${caseLabels[i]})) goto ${dynTag}_${i};`);
        }
      }
      out.push(`  switch (${discExpr}) {`);
      for (let i = 0; i < node.cases.length; i++) {
        const c = node.cases[i];
        if (!c.test) {
          out.push(`  default:`);
        } else if (isDynamicLabel(caseLabels[i])) {
          // Trailing `;` so the label always has a statement to attach to, even when
          // this case is last in the switch or has an empty (fallthrough) body.
          out.push(`  ${dynTag}_${i}: /* dynamic case ${caseLabels[i]}${loc(c)} */;`);
        } else {
          out.push(`  case ${caseLabels[i]}:`);
        }
        for (const s of c.consequent) emitStmt(s, funcName, params, out, ctx);
      }
      out.push(`  }`);
      if (dynTag) out.push(`  }`);
      break;
    }
    case 'BreakStatement':
      out.push(`  break;`);
      break;
    case 'ContinueStatement':
      out.push(`  continue;`);
      break;
    case 'ReturnStatement': {
      if (node.argument) {
        const declaredRetType = ctx.retType ?? freeFunctions.get(funcName)?.retType;
        // `return voidCall();` — a valid JS/TS idiom (early-return, discarding
        // whatever the callee returns) becomes a real "void value not ignored" error
        // in C if the ENCLOSING function isn't itself void — e.g. RPPWM.writeUint32
        // has no return-type annotation, infers non-void because it also has value-
        // returning paths elsewhere, yet has one early `return
        // this.channels[i].writeRegister(...)` (a void method). Split into the call
        // (for its side effects) followed by a bare/dummy return matching the
        // function's own declared return type.
        if (
          isVoidReturningCall(node.argument, ctx) &&
          declaredRetType &&
          declaredRetType !== 'void'
        ) {
          out.push(`  ${emitExpr(node.argument, funcName, params, ctx)};`);
          out.push(`  return 0;`);
          break;
        }
        let retExpr = emitExpr(node.argument, funcName, params, ctx);
        // Box a concrete-class return value into its declared interface return type
        // (e.g. `createAlarm(): IAlarm { return new ClockAlarm(...); }`) — same gap as
        // boxing a class instance passed where an interface-typed *parameter* is
        // expected, just on the return side.
        if (declaredRetType)
          retExpr = wrapArgIfInterfaceParam(
            retExpr,
            node.argument,
            declaredRetType,
            ctx,
            funcName,
            params
          );
        // `declaredRetType` here is always a real, fully-qualified C type (straight
        // from the function's own signature, e.g. `fn.retType`) — unlike some other
        // callers of `resolveExprType`-derived types elsewhere, safe to cast with.
        out.push(`  return ${castStubForType(retExpr, declaredRetType)};`);
      } else {
        out.push(`  return;`);
      }
      break;
    }
    case 'ThrowStatement': {
      // Convert to abort/printf — we'll improve this later
      const msg = node.argument?.arguments?.[0];
      if (msg) {
        out.push(`  fprintf(stderr, "Error: %s\\n", ${emitExpr(msg, funcName, params, ctx)});`);
      }
      out.push(`  abort();`);
      break;
    }
    case 'BlockStatement': {
      out.push(`  {`);
      for (const s of node.body) emitStmt(s, funcName, params, out, ctx);
      out.push(`  }`);
      break;
    }
    case 'EmptyStatement':
      break;
    // C has no exceptions — ThrowStatement already compiles to an unconditional
    // fprintf+abort() (see below), so by the time anything would actually "throw",
    // the process has already terminated; the catch block (typically just a rethrow)
    // is dropped entirely, but the try body must still be emitted for real — it's the
    // actual code path being guarded, not optional. `finally` (rare in this codebase)
    // still needs to run on the normal exit path, so it's emitted right after.
    case 'TryStatement': {
      if (node.block?.type === 'BlockStatement') {
        for (const s of node.block.body) emitStmt(s, funcName, params, out, ctx);
      }
      if (node.finalizer?.type === 'BlockStatement') {
        for (const s of node.finalizer.body) emitStmt(s, funcName, params, out, ctx);
      }
      break;
    }
    // `for (const line of strExpr.split(delim)) { ... }` — the one ForOfStatement shape
    // actually needed (Intel HEX/UF2 loading line-by-line parses this way; see
    // load-hex.ts/load-firmware.ts's inspectHex). General for-of-over-array support
    // isn't implemented (every other shape still falls to the generic TODO below) —
    // this is narrowly the split-into-lines idiom, via strtok_r (a real heap copy of
    // the source, so the original string is left untouched — JS's split() doesn't
    // mutate its receiver either). strtok_r collapses consecutive delimiters (unlike
    // JS split, which preserves empty elements between them); harmless here since
    // every consumer only acts on lines that match a specific non-empty prefix.
    case 'ForOfStatement': {
      const right = node.right;
      if (
        right?.type === 'CallExpression' &&
        right.callee?.type === 'MemberExpression' &&
        !right.callee.computed &&
        right.callee.property?.name === 'split' &&
        node.left.type === 'VariableDeclaration'
      ) {
        const delimNode = right.arguments[0];
        const delim = delimNode?.type === 'StringLiteral' ? delimNode.value : '\n';
        const srcStr = emitExpr(right.callee.object, funcName, params, ctx);
        const varName = cName(node.left.declarations[0].id.name);
        const cDelim = cStringEscape(delim);
        out.push(`  {`);
        out.push(`    char* __forof_copy = strdup(${srcStr});`);
        out.push(`    char* __forof_save = NULL;`);
        out.push(`    char* ${varName} = strtok_r(__forof_copy, "${cDelim}", &__forof_save);`);
        out.push(`    while (${varName} != NULL) {`);
        if (node.body.type === 'BlockStatement') {
          for (const s of node.body.body) emitStmt(s, funcName, params, out, ctx);
        } else {
          emitStmt(node.body, funcName, params, out, ctx);
        }
        out.push(`      ${varName} = strtok_r(NULL, "${cDelim}", &__forof_save);`);
        out.push(`    }`);
        out.push(`    free(__forof_copy);`);
        out.push(`  }`);
        break;
      }
      // `for (const reg of xreg_list[rlist]) { ... }` — iterating one row of a
      // ragged 2D array const (see its own collection comment for why this needs a
      // parallel `_lens` array). `rlist` may be an arbitrary runtime expression, not
      // just a bare identifier, hence evaluating it into a temporary once up front.
      if (
        right?.type === 'MemberExpression' &&
        right.computed &&
        right.object?.type === 'Identifier' &&
        ragged2DArrayNames.has(right.object.name) &&
        node.left.type === 'VariableDeclaration'
      ) {
        const arrName = right.object.name;
        const idxC = emitExpr(right.property, funcName, params, ctx);
        const loopVar = cName(node.left.declarations[0].id.name);
        out.push(`  {`);
        out.push(`    int32_t __forof_idx = ${idxC};`);
        out.push(
          `    for (int32_t __forof_i = 0; __forof_i < ${arrName}_lens[__forof_idx]; __forof_i++) {`
        );
        out.push(`      int32_t ${loopVar} = ${arrName}[__forof_idx][__forof_i];`);
        if (node.body.type === 'BlockStatement') {
          for (const s of node.body.body) emitStmt(s, funcName, params, out, ctx);
        } else {
          emitStmt(node.body, funcName, params, out, ctx);
        }
        out.push(`    }`);
        out.push(`  }`);
        break;
      }
      // `for (const x of [this, this.otherCore]) { ... }` — a for-of over a small
      // fixed-size array LITERAL (not a runtime array). Since the element count is
      // known at compile time, unroll into one copy of the body per element rather
      // than building a real C array (elements may have differing storage — `this`
      // is the enclosing self pointer, not a value that lives in memory anywhere).
      if (right?.type === 'ArrayExpression' && node.left.type === 'VariableDeclaration') {
        const loopVar = cName(node.left.declarations[0].id.name);
        const elemType = `${ctx.className}*`;
        // Register the loop variable's type for the body (so a METHOD call on it
        // dispatches, not just a plain field read), and restore whatever the name meant
        // before — a for-of's binding is scoped to its own loop, and leaking it would let
        // a later same-named variable of a different type mis-dispatch.
        const savedLoopVarType = ctx?.varTypes ? ctx.varTypes[loopVar] : undefined;
        if (ctx?.varTypes) ctx.varTypes[loopVar] = ctx.className;
        for (const elem of right.elements) {
          const elemC = emitExpr(elem, funcName, params, ctx);
          out.push(`  {`);
          out.push(`    ${elemType} ${loopVar} = ${elemC};`);
          if (node.body.type === 'BlockStatement') {
            for (const s of node.body.body) emitStmt(s, funcName, params, out, ctx);
          } else {
            emitStmt(node.body, funcName, params, out, ctx);
          }
          out.push(`  }`);
        }
        if (ctx?.varTypes) {
          if (savedLoopVarType === undefined) delete ctx.varTypes[loopVar];
          else ctx.varTypes[loopVar] = savedLoopVarType;
        }
        break;
      }
      // `for (const x of this.field as ConcreteClass[])` — a for-of over an
      // interface-typed fixed array, cast to a concrete class before the loop so the
      // body can call a CONCRETE-only method (one with a signature the interface
      // itself doesn't declare, e.g. `CortexM33Core.reset(enableCoprocessors)` vs
      // `ICpuCore.reset(): void`) without going through the interface vtable. Each
      // element is really an interface fat pointer (`{ obj, vtable }` struct value,
      // not itself a pointer) — reach through `.obj` and cast IT, mirroring what the
      // hand-written C test harness already does for the same reason
      // (`(CortexM33Core*)(mcu->core[0].obj)`). Resolves the underlying field exactly
      // like the plain-MemberExpression case below (same sizeNode/isGrowableArray
      // lookup), just with the loop var bound to the cast's concrete pointer type
      // instead of the field's own (interface) element type — a `TSAsExpression`
      // wouldn't match the plain-MemberExpression case at all, falling to the TODO
      // stub regardless of sizeNode.
      if (
        right?.type === 'TSAsExpression' &&
        right.typeAnnotation?.type === 'TSArrayType' &&
        right.expression?.type === 'MemberExpression' &&
        !right.expression.computed &&
        node.left.type === 'VariableDeclaration'
      ) {
        const inner = right.expression;
        const fieldInfo = resolveFieldInfo(inner, ctx);
        const lengthC = fieldInfo?.sizeNode
          ? emitExpr(fieldInfo.sizeNode, funcName, params, ctx)
          : fieldInfo?.isGrowableArray
          ? `${emitExpr(inner, funcName, params, ctx)}_count`
          : null;
        const castElemType = right.typeAnnotation.elementType?.typeName?.name;
        if (fieldInfo && lengthC && castElemType && classes.has(castElemType)) {
          const loopVar = cName(node.left.declarations[0].id.name);
          const arrC = emitExpr(inner, funcName, params, ctx);
          const savedElemType = ctx?.varTypes ? ctx.varTypes[loopVar] : undefined;
          if (ctx?.varTypes) ctx.varTypes[loopVar] = castElemType;
          out.push(`  {`);
          out.push(`    int32_t __forof_n = ${lengthC};`);
          out.push(`    for (int32_t __forof_i = 0; __forof_i < __forof_n; __forof_i++) {`);
          out.push(
            `      ${castElemType}* ${loopVar} = (${castElemType}*)((${arrC}[__forof_i]).obj);`
          );
          if (node.body.type === 'BlockStatement') {
            for (const s of node.body.body) emitStmt(s, funcName, params, out, ctx);
          } else {
            emitStmt(node.body, funcName, params, out, ctx);
          }
          out.push(`    }`);
          out.push(`  }`);
          if (ctx?.varTypes) {
            if (savedElemType === undefined) delete ctx.varTypes[loopVar];
            else ctx.varTypes[loopVar] = savedElemType;
          }
          break;
        }
      }
      // `for (const x of this.field)` / `for (const x of obj.field)` over a REAL
      // array field (not a literal) — either a fixed-size array-of-instances (has a
      // compile-time sizeNode) or a growable array (has a runtime `_count` companion,
      // see the collectTypes `isGrowableArray` comment). Emits a real bounded C
      // for-loop indexing the field directly.
      if (
        right?.type === 'MemberExpression' &&
        !right.computed &&
        node.left.type === 'VariableDeclaration'
      ) {
        const fieldInfo = resolveFieldInfo(right, ctx);
        const lengthC = fieldInfo?.sizeNode
          ? emitExpr(fieldInfo.sizeNode, funcName, params, ctx)
          : fieldInfo?.isGrowableArray
          ? `${emitExpr(right, funcName, params, ctx)}_count`
          : null;
        if (fieldInfo && lengthC) {
          const loopVar = cName(node.left.declarations[0].id.name);
          const elemType = fieldInfo.type.slice(0, -1);
          const arrC = emitExpr(right, funcName, params, ctx);
          // Register the loop variable's (bare, no `*`) type so a method call on it
          // inside the body (e.g. `listener.fire()`) resolves via the normal
          // class/interface method-dispatch lookup instead of falling to a stub.
          // Restored after the loop — see the array-literal case above for why.
          const savedElemType = ctx?.varTypes ? ctx.varTypes[loopVar] : undefined;
          if (ctx?.varTypes) ctx.varTypes[loopVar] = elemType.replace(/\*+$/, '');
          out.push(`  {`);
          out.push(`    int32_t __forof_n = ${lengthC};`);
          out.push(`    for (int32_t __forof_i = 0; __forof_i < __forof_n; __forof_i++) {`);
          out.push(`      ${elemType} ${loopVar} = ${arrC}[__forof_i];`);
          if (node.body.type === 'BlockStatement') {
            for (const s of node.body.body) emitStmt(s, funcName, params, out, ctx);
          } else {
            emitStmt(node.body, funcName, params, out, ctx);
          }
          out.push(`    }`);
          out.push(`  }`);
          if (ctx?.varTypes) {
            if (savedElemType === undefined) delete ctx.varTypes[loopVar];
            else ctx.varTypes[loopVar] = savedElemType;
          }
          break;
        }
      }
      out.push(
        `  /* TODO: ForOfStatement${loc(node)} */ ${stubAbortStmt(`ForOfStatement${loc(node)}`)}`
      );
      break;
    }
    default:
      out.push(
        `  /* TODO: ${node.type}${loc(node)} */ ${stubAbortStmt(`${node.type}${loc(node)}`)}`
      );
  }
}

// Would evaluating this expression twice differ from evaluating it once? Consulted only
// by the `||`/`&&`/`??` lowering below: all three yield one of their OPERANDS in JS (not
// a 0/1 boolean), so a faithful C lowering is a ternary — which has to name the left
// operand twice. A pure operand can simply be repeated; an impure one needs a
// single-evaluation temporary instead.
// Deliberately conservative — anything not positively recognized as pure is treated as
// impure (the safe direction: a needless temporary, never a duplicated side effect).
// A non-computed property read counts as pure: it's a plain struct-field load, and the
// handful of real getters in this codebase are all pure computations over stored state.
function isPureExpr(node) {
  if (!node) return true;
  switch (node.type) {
    case 'NumericLiteral':
    case 'StringLiteral':
    case 'BooleanLiteral':
    case 'NullLiteral':
    case 'Identifier':
    case 'ThisExpression':
      return true;
    case 'ParenthesizedExpression':
    case 'TSAsExpression':
    case 'TSNonNullExpression':
      return isPureExpr(node.expression);
    case 'UnaryExpression':
      return node.operator !== 'delete' && isPureExpr(node.argument);
    case 'BinaryExpression':
    case 'LogicalExpression':
      return isPureExpr(node.left) && isPureExpr(node.right);
    case 'ConditionalExpression':
      return isPureExpr(node.test) && isPureExpr(node.consequent) && isPureExpr(node.alternate);
    case 'MemberExpression':
      return isPureExpr(node.object) && (!node.computed || isPureExpr(node.property));
    default:
      return false; // calls, `new`, assignments, ++/--, everything unrecognized
  }
}

// Build the C shift-count operand for a JS shift, applying JS's own "mask the count to 5
// bits" rule (see the `>>>` case in emitExpr for why). A NumericLiteral count is masked
// here at transpile time so the emitted C is exactly as cheap as before; anything else
// gets a real `& 31`, which is one AND instruction on a path that was previously
// undefined behavior for any count of 32 or more.
function shiftCount(node, emittedStr) {
  if (node?.type === 'NumericLiteral' && Number.isInteger(node.value)) {
    return `(${node.value & 31})`;
  }
  return `(((int32_t)(${emittedStr})) & 31)`;
}

// ─── Expression emission ────────────────────────────────────────────
// `opts.boolCtx` marks a position whose value is only ever tested for truthiness (a
// loop/if/ternary condition, a `!` operand, another `&&`/`||` operand). There, C's
// boolean `&&`/`||` are exactly right and cheaper than the operand-preserving ternary
// the value positions need — see the LogicalExpression case.
function emitExpr(node, funcName, params, ctx, opts) {
  if (!node) return '0';

  switch (node.type) {
    case 'NumericLiteral': {
      // A JS numeric literal above INT32_MAX (e.g. `0xa500a500`) is still just a
      // plain `number` in TS. Every other number here is modeled as int32_t, and
      // comparisons against a literal rely on C's usual-arithmetic-conversion rule
      // that same-rank signed/unsigned operands compare bitwise-correctly — but
      // C's constant-type rules only give `unsigned int` to OCTAL/HEX literals,
      // not decimal: an unsuffixed decimal constant this large becomes `long`
      // (64-bit here), so comparing it against a sign-extended int32_t silently
      // compares two different 64-bit values and never matches. A `u` suffix makes
      // the literal `unsigned int`, restoring the correct same-rank conversion.
      const v = node.value;
      if (Number.isInteger(v) && v > 2147483647 && v <= 4294967295) {
        return `${v}u`;
      }
      return String(v);
    }

    case 'StringLiteral':
      return `"${cStringEscape(node.value)}"`;

    case 'BooleanLiteral':
      return node.value ? 'true' : 'false';

    // null/undefined → 0. Valid as a null-pointer constant, an enum zero value, or a
    // plain int — whichever the surrounding declared type needs.
    case 'NullLiteral':
      return '0';

    case 'Identifier':
      if (node.name === 'undefined') return '0';
      if (node.name === 'Infinity') return 'INFINITY';
      if (node.name === 'NaN') return 'NAN';
      // A module-private const declared in this file collided (same name, different
      // value) with one from another file already emitted under the bare name — this
      // file's own declaration was renamed (see emitScalarConstDecl); every reference
      // within this file must follow.
      if (currentFileConstRenames.has(node.name)) return currentFileConstRenames.get(node.name);
      return cName(node.name);

    case 'ThisExpression':
      return 'self';

    case 'MemberExpression': {
      const prop = node.property?.name;
      const obj = node.object;

      // Enum.member → ENUM_MEMBER (C enums are flat)
      if (obj?.type === 'Identifier' && enums.has(obj.name)) {
        return `${obj.name}_${prop}`;
      }

      // namespaceObj.EXPORTED_CONST → EXPORTED_CONST (bare) — `import * as fpu from
      // './fpu-helpers'` then `fpu.FPSCR_IOC`, where FPSCR_IOC is a real top-level
      // export already hoisted as a global enum/const by cts2c. namespaceObj.someFunc()
      // calls are left alone (handled separately, as a generic unresolved-dispatch
      // stub — that already compiles fine as-is).
      if (
        obj?.type === 'Identifier' &&
        namespaceImports.has(obj.name) &&
        !node.computed &&
        emittedConstants.has(prop)
      ) {
        return cName(prop);
      }

      // .length on arrays → hardcoded size (we'd need array length tracking; stub for now)
      if (prop === 'length' && obj?.type !== 'ThisExpression') {
        // `this.field.length` (or `someLocal.field.length`) where `field` is a typed
        // `this.field.length` (or `someLocal.field.length`) where `field` is a typed
        // array constructed as `new XArray(sizeExpr)` — collectTypes stashed that same
        // size expression (`sizeNode`) at field-collection time, so it can be
        // re-emitted here instead of unconditionally stubbing to 0.
        if (obj?.type === 'MemberExpression') {
          const fieldInfo = resolveFieldInfo(obj, ctx);
          if (fieldInfo?.sizeNode) return emitExpr(fieldInfo.sizeNode, funcName, params, ctx);
          // Growable array (see the collectTypes `isGrowableArray` comment): the real
          // count lives in a runtime companion field, not a compile-time sizeNode.
          if (fieldInfo?.isGrowableArray) return `${emitExpr(obj, funcName, params, ctx)}_count`;
        }
        // `localVar.length` where `localVar` was destructured from a field with a
        // known sizeNode (e.g. `const { qspi } = this.rp2040;` then `qspi.length`)
        // — see the ObjectPattern destructuring case's `localSizeNodes` tracking.
        if (obj?.type === 'Identifier' && ctx?.localSizeNodes?.[obj.name]) {
          return emitExpr(ctx.localSizeNodes[obj.name], funcName, params, ctx);
        }
        // `someString.length` — same isCharPtrExpr check `.substring()`'s own
        // missing-end-arg fallback already relies on (strSubstring calls strlen
        // internally); just exposes that as a real value here instead of only
        // implicitly, inside a different method's codegen.
        if (isCharPtrExpr(obj, params, ctx)) {
          return `((int32_t)strlen(${emitExpr(obj, funcName, params, ctx)}))`;
        }
        // The object is deliberately NOT emitted — nothing consumes it (this is the
        // unresolved-length stub), and emitting it purely to discard the string still ran
        // its codegen side effects.
        return `/* TODO: .length${loc(node)} */ ${stubAbortExpr(`.length${loc(node)}`)}`;
      }

      // this.field → self->field or self->base.field (inherited)
      if (obj?.type === 'ThisExpression') {
        const cprop = cName(prop);
        if (prop === 'length') {
          // Bare `this.length` (no intermediate field) — not the `this.field.length`
          // shape (handled above, this class has no array-typed `length` field of its
          // own to speak of).
          return `/* TODO: this.length${loc(node)} */ ${stubAbortExpr(`this.length${loc(node)}`)}`;
        }
        // `this.prop` where `prop` has a REAL getter (own class or inherited) — call
        // through it instead of reading a plain struct field. Getters are never
        // array-indexed, so only applies to the non-computed case. (Assignment TARGETS
        // never reach here — a getter-only property can't be assigned to in valid TS,
        // and AssignmentExpression intercepts setter-backed properties before ever
        // calling emitExpr on its own left-hand side — see there.)
        if (!node.computed && ctx?.className) {
          const getterClass = findGetterDefiningClass(ctx.className, prop);
          if (getterClass) {
            return `${getterClass}_${prop}_get(${selfPathTo('self', ctx.className, getterClass)})`;
          }
        }
        // Check if field is inherited from an ancestor
        if (ctx?.className) {
          const ownField = classes.get(ctx.className)?.fields?.get(prop);
          if (!ownField) {
            // Walk the parent chain to find the field, COUNTING how many levels up it
            // sits: a class embeds its direct parent as `base`, which embeds ITS parent as
            // `base.base`, and so on. A single hardcoded `self->base.x` was emitted no
            // matter the depth, so a field inherited from a GRANDparent read the wrong
            // struct member (or didn't compile). The method-call path already got this
            // right via selfPathTo; this one never did. Latent today — no class in this
            // codebase currently has an inheritance depth of 2 or more — so it's a
            // correctness guard, not an observed failure.
            let cls = classes.get(ctx.className);
            let depth = 0;
            while (cls?.parent) {
              const parentCls = classes.get(cls.parent);
              depth++;
              if (parentCls?.fields?.has(prop)) {
                const basePath = `self->${'base.'.repeat(depth)}${cprop}`;
                if (!node.computed) return basePath;
                return `${basePath}[${emitExpr(node.property, funcName, params, ctx, {
                  intCtx: true,
                })}]`;
              }
              cls = parentCls;
            }
          }
        }
        if (!node.computed) return `self->${cprop}`;
        return `self->${cprop}[${emitExpr(node.property, funcName, params, ctx, {
          intCtx: true,
        })}]`;
      }

      // Check if object is an interface fat pointer (struct, not pointer)
      // This must come BEFORE the computed-access check so iface.arr[i] is stubbed
      const objType = resolveExprType(obj, ctx);
      if (objType && interfaces.has(objType)) {
        return `/* TODO: iface.${prop}${loc(node)} */ ${stubAbortExpr(
          `iface.${prop}${loc(node)}`
        )}`;
      }
      // Object is an opaque dynamic type (Record<string, unknown>, Map, etc.) — no
      // real field to bind to (it's void* in C), so stub instead of emitting a blind
      // `->field` on it.
      if (objType && OPAQUE_DYNAMIC_TYPES.has(objType)) {
        return `/* TODO: dynamic.${prop}${loc(node)} */ ${stubAbortExpr(
          `dynamic.${prop}${loc(node)}`
        )}`;
      }
      // Check if object is this.base.rp2040 (interface inherited field)
      if (obj?.type === 'MemberExpression') {
        const baseType = resolveExprType(obj, ctx);
        if (baseType && interfaces.has(baseType)) {
          return `/* TODO: iface.${prop}${loc(node)} */ ${stubAbortExpr(
            `iface.${prop}${loc(node)}`
          )}`;
        }
      }

      // TypedArray indexing: arr[i]
      // But first check if arr resolves to an interface property (stub the whole thing)
      if (node.computed) {
        const computedObjType = resolveExprType(obj, ctx);
        if (computedObjType && interfaces.has(computedObjType)) {
          return `/* TODO: iface.${prop}[idx]${loc(node)} */ ${stubAbortExpr(
            `iface.${prop}[idx]${loc(node)}`
          )}`;
        }
        // Check if obj is a member access on an interface (e.g. this.rp2040.qspi)
        if (obj?.type === 'MemberExpression') {
          const grandObjType = resolveExprType(obj.object, ctx);
          if (grandObjType && interfaces.has(grandObjType)) {
            return `/* TODO: iface.${obj.property?.name}.${prop}[idx]${loc(
              node
            )} */ ${stubAbortExpr(`iface.${obj.property?.name}.${prop}[idx]${loc(node)}`)}`;
          }
        }
        const objStr = emitExpr(obj, funcName, params, ctx);
        // A subscript must be an integer in C — an integer context (see BinaryExpression's `/`).
        return `${objStr}[${emitExpr(node.property, funcName, params, ctx, { intCtx: true })}]`;
      }

      // Check if object is an interface type (already checked above for direct, but this catches locals)
      if (objType == null) {
        // Try resolving from the object expression itself
        const t = resolveExprType(obj, ctx);
        if (t && interfaces.has(t)) {
          return `/* TODO: iface.${prop}${loc(node)} */ ${stubAbortExpr(
            `iface.${prop}${loc(node)}`
          )}`;
        }
      }

      // obj.field where `field` has a REAL getter on obj's own (known concrete) class
      // or an ancestor — call through it instead of reading a plain struct field.
      // Same "assignment targets never reach here" reasoning as the `this.field` case
      // above (AssignmentExpression intercepts setter-backed properties first).
      if (!node.computed && objType && classes.has(objType)) {
        const getterClass = findGetterDefiningClass(objType, prop);
        if (getterClass) {
          const objStr = emitExpr(obj, funcName, params, ctx);
          return `${getterClass}_${prop}_get(${selfPathTo(objStr, objType, getterClass)})`;
        }
      }

      // obj.field → obj->field (if pointer) or obj.field (if embedded)
      // Fallback: if we can't resolve obj type, return stub to avoid compile error
      const objStr = emitExpr(obj, funcName, params, ctx);
      // If object resolved to a stub (interface/TODO), propagate the stub instead of
      // appending `->field` to it — TODO stubs come in two shapes depending on the emit
      // site (`(0) /* TODO: ... */` vs `/* TODO: ... */ 0`), so check for the marker
      // text anywhere rather than only as a prefix, or the second shape (e.g. the
      // generic "unhandled node type" default case) slips through and produces
      // `/* TODO: X */ 0->field`, an actual field access on the integer literal 0.
      if (objStr.includes('/* TODO')) {
        return `/* TODO: chained ${prop}${loc(node)} */ ${stubAbortExpr(
          `chained ${prop}${loc(node)}`
        )}`;
      }
      return `${objStr}->${cName(prop)}`;
    }

    case 'CallExpression': {
      const callee = node.callee;

      // super(args) → Parent_new(args) — call parent constructor on our base
      if (callee.type === 'Super') {
        const className = ctx?.className;
        const cls = classes.get(className);
        const parentName = cls?.parent;
        if (parentName) {
          const args = node.arguments.map((a) => emitExpr(a, funcName, params, ctx));
          // Call parent constructor, copying result into base
          return `(memcpy(&self->base, ${parentName}_new(${args.join(
            ', '
          )}), sizeof(${parentName})))`;
        }
        return `/* TODO: super()${loc(node)} */ ${stubAbortExpr(`super()${loc(node)}`)}`;
      }

      // super.method(args) → Parent_method(&self->base, args)
      if (callee.type === 'MemberExpression' && callee.object?.type === 'Super') {
        const methodName = callee.property.name;
        const className = ctx?.className;
        const cls = classes.get(className);
        const parentName = cls?.parent;
        if (parentName) {
          const args = node.arguments.map((a) => emitExpr(a, funcName, params, ctx));
          return `${parentName}_${methodName}(&self->base${
            args.length ? ', ' + args.join(', ') : ''
          })`;
        }
      }

      // this.method(args) → Class_method(self, args)
      if (callee.type === 'MemberExpression') {
        const methodName = callee.property.name;

        // `[a, b, c].includes(x)` — a fixed array LITERAL used purely as an inline
        // membership-test set (not a real runtime array with any other use), e.g.
        // `[0x4, 0x5, 0xc, 0xd].includes((hw0 >>> 4) & 0xf)`. This has no target
        // type/storage of its own to build a real C array against (same as the
        // generic ArrayExpression case), but doesn't need one either — expand
        // directly into an OR-chain of equality comparisons against the single
        // probe argument.
        if (
          methodName === 'includes' &&
          callee.object?.type === 'ArrayExpression' &&
          callee.object.elements.length > 0 &&
          callee.object.elements.every((e) => e?.type === 'NumericLiteral')
        ) {
          const probe = emitExpr(node.arguments[0], funcName, params, ctx);
          const probeVar = `__inc_${includesCallCounter++}`;
          const checks = callee.object.elements
            .map((e) => `${probeVar} == ${e.value}`)
            .join(' || ');
          return `(__extension__({ __typeof__(${probe}) ${probeVar} = (${probe}); ${checks}; }))`;
        }

        // Math.* → C builtins
        if (callee.object?.type === 'Identifier' && callee.object.name === 'Math') {
          const args = node.arguments.map((a) => emitExpr(a, funcName, params, ctx));
          const mathMap = {
            imul: 'imul32',
            clz32: 'clz32',
            fround: '(float)',
            floor: 'floor',
            ceil: 'ceil',
            trunc: 'trunc',
            round: 'round',
            abs: 'abs',
            sqrt: 'sqrt',
            min: 'min',
            max: 'max',
            pow: 'pow',
            sign: 'sign',
          };
          const cFn = mathMap[methodName];
          if (cFn) return `${cFn}(${args.join(', ')})`;
          return `/* TODO: Math.${methodName}${loc(node)} */ ${stubAbortExpr(
            `Math.${methodName}${loc(node)}`
          )}`;
        }

        // Number.* → C builtins (mirrors Number.isNaN(x) to the same isnan((double)(...))
        // output the bare-identifier isNaN(x) form already produces below)
        if (callee.object?.type === 'Identifier' && callee.object.name === 'Number') {
          const args = node.arguments.map((a) => emitExpr(a, funcName, params, ctx));
          if (methodName === 'isNaN') return `isnan((double)(${args.join(',')}))`;
          if (methodName === 'isFinite') return `isfinite((double)(${args.join(',')}))`;
        }

        // console.* → no-op (logging) — deliberately NOT converted to an abort like
        // every other stub here: logging is hit constantly during entirely normal,
        // correct operation, and dropping it doesn't affect emulation correctness.
        if (callee.object?.type === 'Identifier' && callee.object.name === 'console') {
          return `/* TODO: console.${methodName}${loc(node)} */ 0`;
        }

        // Set/Map methods → stub (non-hot path). NOT 'set' — that's also TypedArray's
        // bulk-copy method (`dest.set(sourceArray)`), handled separately below with a
        // real memcpy when the source resolves to a known fixed-size C array; this
        // bucket must not catch it first and leave it permanently stubbed to a no-op.
        if (['add', 'delete', 'has', 'get', 'clear', 'forEach'].includes(methodName)) {
          return `/* TODO: ${methodName}${loc(node)} */ ${stubAbortExpr(
            `${methodName}${loc(node)}`
          )}`;
        }

        // String.fromCharCode → stub
        if (
          callee.object?.type === 'Identifier' &&
          callee.object.name === 'String' &&
          methodName === 'fromCharCode'
        ) {
          return `/* TODO: String.fromCharCode${loc(node)} */ ${stubAbortExpr(
            `String.fromCharCode${loc(node)}`
          )}`;
        }

        // *.logger.X(...) → no-op (logging via chip interface, not in hot path) —
        // regardless of what precedes `.logger` (`this.logger.X()`,
        // `this.chip.logger.X()`, `this.rp2040.logger.X()`, ...): Logger is a real
        // interface with several implementers, but this codebase never needs logging
        // in the transpiled hot path, so every call site is stubbed uniformly rather
        // than routing through real vtable dispatch (which would need `this.rp2040`'s
        // own `logger` field — currently untyped/inferred void* in several places —
        // fixed rather than chased through the interface machinery).
        if (
          callee.object?.type === 'MemberExpression' &&
          callee.object.property?.name === 'logger'
        ) {
          return `/* TODO: log${loc(node)} */ 0`;
        }

        // namespaceObj.freeFunction(args) → freeFunction(args) — `import * as fpu
        // from './fpu-helpers'` then `fpu.getFpscrNzcv(...)`; the callee is a real
        // top-level free function, just namespace-qualified at the call site (same
        // idea as the namespaceObj.CONST → CONST handling in the MemberExpression
        // case). Without this, every such call fell through to the generic
        // "unknown dispatch" TODO stub.
        if (
          callee.object?.type === 'Identifier' &&
          namespaceImports.has(callee.object.name) &&
          freeFunctions.has(methodName)
        ) {
          const targetFn = freeFunctions.get(methodName);
          let args = node.arguments.map((a) => emitExpr(a, funcName, params, ctx));
          while (args.length < targetFn.params.length) {
            args.push(targetFn.params[args.length]?.default ?? '0');
          }
          args = args.map((a, i) =>
            castStubForType(
              wrapArgIfInterfaceParam(
                a,
                node.arguments[i],
                targetFn.params[i]?.type,
                ctx,
                funcName,
                params
              ),
              targetFn.params[i]?.type
            )
          );
          return `${methodName}(${args.join(', ')})`;
        }

        const objStr = emitExpr(callee.object, funcName, params, ctx);

        // DataView.getUint32/setUint32/getUint16/setUint16/getUint8/setUint8 over a
        // `new DataView(x.buffer)` field (see the `isDataView` field-collection
        // comment) — a raw byte-offset read/write of the aliased buffer. The
        // endianness argument (always `true`/little-endian at every call site in this
        // codebase) is ignored: x86_64 is natively little-endian, so a plain pointer
        // cast already produces the right byte order.
        if (
          ['getUint32', 'setUint32', 'getUint16', 'setUint16', 'getUint8', 'setUint8'].includes(
            methodName
          )
        ) {
          const fieldInfo = resolveFieldInfo(callee.object, ctx);
          if (fieldInfo?.isDataView) {
            const byteType = methodName.includes('32')
              ? 'uint32_t'
              : methodName.includes('16')
              ? 'uint16_t'
              : 'uint8_t';
            const offsetC = emitExpr(node.arguments[0], funcName, params, ctx);
            const ptrExpr = `(${byteType}*)((${objStr}) + (${offsetC}))`;
            if (methodName.startsWith('get')) return `(*${ptrExpr})`;
            const valueC = emitExpr(node.arguments[1], funcName, params, ctx);
            return `(*${ptrExpr} = (${byteType})(${valueC}))`;
          }
        }

        // TypedArray/Array built-in methods
        if (methodName === 'fill') {
          const arg = emitExpr(
            node.arguments[0] ?? { type: 'NumericLiteral', value: 0 },
            funcName,
            params,
            ctx
          );
          // `this.someArrayField.fill(v)` — the field's own element count is already
          // tracked as `sizeNode` at collection time (e.g. `new Array<number>(512)`,
          // or a literal/mapped array initializer), just never consulted here before.
          const fieldInfo = resolveFieldInfo(callee.object, ctx);
          if (fieldInfo?.sizeNode && fieldInfo.type) {
            const elemType = fieldInfo.type.endsWith('*')
              ? fieldInfo.type.slice(0, -1)
              : fieldInfo.type;
            const count = emitExpr(fieldInfo.sizeNode, funcName, params, ctx);
            return `/* memset */ memset(${objStr}, ${arg}, (${count}) * sizeof(${elemType}))`;
          }
          return `/* memset */ memset(${objStr}, ${arg}, /* TODO: size${loc(
            node
          )} */ ${stubAbortExpr(`.fill() size${loc(node)}`)})`;
        }
        // Array methods → unsupported (non-hot path)
        if (
          [
            'reduceRight',
            'sort',
            'filter',
            'some',
            'every',
            'map',
            'forEach',
            'reduce',
            'join',
            'includes',
          ].includes(methodName)
        ) {
          return stubAbortExpr(`${methodName}${loc(node)}`);
        }
        // `dest.set(sourceArray)` — TypedArray bulk copy. Only handled when the source
        // resolves to a real, fixed-size C array (arrayConstNames — e.g. a bundled
        // bootrom image): sizeof(sourceArray) is then known at compile time, giving an
        // exact byte count for memcpy. A dynamic/parameter source has no length
        // metadata attached to its raw pointer in this codebase (same reason `.length`
        // is unresolved elsewhere), so that shape is left stubbed.
        // Same shadowing hazard as 'push' just below: a class can define its own real
        // `set` method (e.g. Timer32.set(value, zigZagDown)) — check for that FIRST,
        // otherwise a real method call silently degrades into this TypedArray stub.
        if (methodName === 'set') {
          const setObjType = resolveExprType(callee.object, ctx);
          const isRealClassSet =
            setObjType && classes.has(setObjType) && findMethodDefiningClass(setObjType, 'set');
          if (!isRealClassSet) {
            const argNode = node.arguments[0];
            if (argNode?.type === 'Identifier' && arrayConstNames.has(argNode.name)) {
              const srcName = cName(argNode.name);
              return `memcpy(${objStr}, ${srcName}, sizeof(${srcName}))`;
            }
            return `/* TODO: .set()${loc(node)} */ ${stubAbortExpr(`.set()${loc(node)}`)}`;
          }
        }
        // `.substring(start, end)` only exists on strings in JS/TS (arrays use
        // `.slice`/`.subarray`, handled separately below), so the method name alone
        // disambiguates without needing the object's resolved type.
        if (methodName === 'substring') {
          const start = emitExpr(
            node.arguments[0] ?? { type: 'NumericLiteral', value: 0 },
            funcName,
            params,
            ctx
          );
          const end = node.arguments[1]
            ? emitExpr(node.arguments[1], funcName, params, ctx)
            : `(int32_t)strlen(${objStr})`;
          return `strSubstring(${objStr}, ${start}, ${end})`;
        }
        if (methodName === 'subarray' || methodName === 'slice')
          return `/* TODO: ${methodName}${loc(node)} */ ${stubAbortExpr(
            `${methodName}${loc(node)}`
          )}`;
        if (methodName === 'indexOf')
          return `/* TODO: indexOf${loc(node)} */ ${stubAbortExpr(`indexOf${loc(node)}`)}`;
        // `.push()` is a no-op stub EXCEPT when the receiver is a real class instance
        // that itself defines a `push` method (e.g. FIFO — a fixed-capacity ring
        // buffer, not a growable JS array). That real method must dispatch through
        // the normal class-method-call path below instead of being caught here,
        // otherwise every FIFO.push() in every peripheral (and cpu.ts's `meicand`
        // interrupt-candidate list, though that one really is a growable array and
        // stays stubbed) silently becomes a no-op — data never actually lands in
        // the ring buffer despite every other FIFO op (pull/empty/full) working.
        if (methodName === 'push') {
          const pushObjType = resolveExprType(callee.object, ctx);
          const isRealClassPush =
            pushObjType && classes.has(pushObjType) && findMethodDefiningClass(pushObjType, 'push');
          if (!isRealClassPush) {
            // `growableField.push(x)` (single arg only — a spread push like
            // `this.descriptors.push(...buffer)` isn't this shape) — see the
            // collectTypes `isGrowableArray` comment. No capacity guard: every real
            // growable-array field in the "full" transpile set stays well under
            // GROWABLE_ARRAY_CAPACITY in practice.
            const growableFieldInfo =
              node.arguments.length === 1 ? resolveFieldInfo(callee.object, ctx) : null;
            if (growableFieldInfo?.isGrowableArray) {
              const fieldC = emitExpr(callee.object, funcName, params, ctx);
              const elemType = growableFieldInfo.type.slice(0, -1); // e.g. "AlarmCallback*" → "AlarmCallback"
              const rawValueC = emitExpr(node.arguments[0], funcName, params, ctx);
              // Box a concrete class instance into the element interface's fat-pointer
              // value struct (same as any other interface-typed argument/slot) —
              // needed when the array element type is itself an interface (e.g.
              // Timer32.listeners: AlarmCallback[]).
              const valueC = wrapArgIfInterfaceParam(
                rawValueC,
                node.arguments[0],
                elemType,
                ctx,
                funcName,
                params
              );
              // Capacity guard: the slot array is a fixed GROWABLE_ARRAY_CAPACITY block, so
              // an unguarded `arr[count++] = v` is a straight buffer overflow once the
              // count reaches capacity. Every real growable-array field in the transpile
              // set stays well under it in practice, which is why this was originally left
              // out — but "in practice" is doing a lot of work for a heap write, and a
              // silent overflow would corrupt whatever follows rather than failing.
              // Wrapped in a statement expression (no call site uses push's return value —
              // verified across src/ — so a void result is fine).
              return `(__extension__({ if (${fieldC}_count < ${GROWABLE_ARRAY_CAPACITY}) { ${fieldC}[${fieldC}_count++] = ${valueC}; } else { fprintf(stderr, "cts2c: %s capacity (%d) exceeded\\n", "${cName(
                callee.property?.name === 'push'
                  ? callee.object?.property?.name ?? 'array'
                  : 'array'
              )}", ${GROWABLE_ARRAY_CAPACITY}); abort(); } }))`;
            }
            return `/* TODO: push${loc(node)} */ ${stubAbortExpr(`push${loc(node)}`)}`;
          }
        }

        if (callee.object?.type === 'ThisExpression') {
          // Find class name from context
          const className = ctx?.className;
          if (className) {
            // `this.foo(...)` only compiles to a real call if some class in the
            // parent chain actually DEFINES a method named `foo` — otherwise `foo`
            // is a data field holding a function value (e.g. `onADCRead: (n:
            // number) => void = ...`), which C has no way to call generically
            // (it's emitted as an opaque void*). Blindly emitting
            // `${className}_${methodName}(self, ...)` for a field produced a call
            // to a function that was never generated at all.
            const definingClass = findMethodDefiningClass(className, methodName);
            if (!definingClass) {
              const closureCall = tryClosureFieldCall(node, funcName, params, ctx);
              if (closureCall) return closureCall;
              return `/* TODO: ${methodName}${loc(node)} */ ${stubAbortExpr(
                `${methodName}${loc(node)}`
              )}`;
            }
            let args = node.arguments.map((a) => emitExpr(a, funcName, params, ctx));
            // Pad with defaults for methods with default params
            const methodSig = classes.get(definingClass)?.methods.get(methodName);
            if (methodSig) {
              while (args.length < methodSig.params.length) {
                args.push(methodSig.params[args.length]?.default ?? '0');
              }
              args = args.map((a, i) =>
                castStubForType(
                  wrapArgIfInterfaceParam(
                    a,
                    node.arguments[i],
                    methodSig.params[i]?.type,
                    ctx,
                    funcName,
                    params
                  ),
                  methodSig.params[i]?.type
                )
              );
            }
            // `this.method()` where `method` is a member of an interface THIS class
            // implements — route through the stored self-vtable (see
            // assignInterfaceSelfVtableFields) instead of a static call to whichever
            // class the calling code happens to be lexically defined in, so a
            // subclass's override is reached correctly from a shared ancestor method
            // (e.g. BasePeripheral.writeUint32Atomic's `this.writeUint32(...)` must
            // reach RPBootRAM's/RPUART's own override, not BasePeripheral's own stub).
            // Reuses the same `${iface}_${method}(fatPointerValue, args)` dispatch
            // helper external interface-boxed calls already use — self's address is
            // numerically identical to the leaf-most class pointer regardless of
            // which ancestor's method body this call is written in (parent-embedded-
            // as-first-struct-member guarantees pointer equality), so `(void*)self`
            // is always the correct `.obj` to box here.
            // Only applies when the interface's OWN declared arity matches the
            // resolved method's — otherwise this is a same-named-but-different method
            // (e.g. RP2350's own `reset(enableCoprocessors)` vs. IRPChip's abstract
            // `reset()`, a coincidental name collision), and routing through the
            // interface's signature would be a real arity mismatch.
            let vtableIface = null;
            if (classHasSubclasses(className))
              for (const iface of getImplementedInterfaces(className)) {
                const ifaceMethods = interfaces.get(iface);
                const ifaceSig = ifaceMethods?.get(methodName);
                if (
                  ifaceSig &&
                  !ifaceSig.isProperty &&
                  ifaceSig.params?.length === methodSig?.params?.length
                ) {
                  vtableIface = iface;
                  break;
                }
              }
            if (vtableIface) {
              const root = findInterfaceRootClass(className, vtableIface);
              const fieldPath = root === className ? 'self' : selfPathTo('self', className, root);
              return `${vtableIface}_${methodName}((${vtableIface}){ .obj = (void*)self, .vtable = (${fieldPath})->__vtable_${vtableIface} }${
                args.length ? ', ' + args.join(', ') : ''
              })`;
            }
            // Inherited method (defined on an ancestor, not this class): self is
            // this class's pointer, but the target function expects the ancestor
            // type — pass through &self->base the same way super.method() does.
            const selfArg = definingClass === className ? 'self' : `&self->base`;
            return `${definingClass}_${methodName}(${selfArg}${
              args.length ? ', ' + args.join(', ') : ''
            })`;
          }
        }

        // obj.method(args) → Class_method(obj, args) when type known
        let args = node.arguments.map((a) => emitExpr(a, funcName, params, ctx));
        const objType = resolveExprType(callee.object, ctx);

        // Case 1: known concrete class → direct call
        if (objType && classes.has(objType)) {
          // Same gap as this.method() above: `methodName` may be a data field
          // holding a function value (e.g. RP2040/RP2350's `onTrace = (core, pc,
          // tag) => {}`), not a real class method — no `Class_methodName` function
          // exists to call in that case.
          const definingClass = findMethodDefiningClass(objType, methodName);
          if (!definingClass) {
            const closureCall = tryClosureFieldCall(node, funcName, params, ctx);
            if (closureCall) return closureCall;
            return `/* TODO: ${methodName}${loc(node)} */ ${stubAbortExpr(
              `${methodName}${loc(node)}`
            )}`;
          }
          // Pad missing optional args with their default (mirrors the this.method() case
          // above) — otherwise e.g. `chip.reset()` where `reset(enableCoprocessors =
          // false)` takes an optional param compiles a call with too few arguments.
          const methodSig = classes.get(definingClass)?.methods.get(methodName);
          if (methodSig) {
            while (args.length < methodSig.params.length) {
              args.push(methodSig.params[args.length]?.default ?? '0');
            }
            args = args.map((a, i) =>
              castStubForType(
                wrapArgIfInterfaceParam(
                  a,
                  node.arguments[i],
                  methodSig.params[i]?.type,
                  ctx,
                  funcName,
                  params
                ),
                methodSig.params[i]?.type
              )
            );
          }
          const objArg = definingClass === objType ? objStr : `&(${objStr})->base`;
          return `${definingClass}_${methodName}(${objArg}${
            args.length ? ', ' + args.join(', ') : ''
          })`;
        }

        // Case 2: known interface type → vtable dispatch
        if (objType && interfaces.has(objType)) {
          const methodSig = interfaces.get(objType)?.get(methodName);
          if (methodSig) {
            args = args.map((a, i) =>
              castStubForType(
                wrapArgIfInterfaceParam(
                  a,
                  node.arguments[i],
                  methodSig.params?.[i]?.type,
                  ctx,
                  funcName,
                  params
                ),
                methodSig.params?.[i]?.type
              )
            );
          }
          return `${objType}_${methodName}(${objStr}${args.length ? ', ' + args.join(', ') : ''})`;
        }

        // Case 3: unknown — return stub (avoids compile errors from broken dispatch)
        return `/* TODO: dispatch ${methodName}${loc(node)} */ ${stubAbortExpr(
          `dispatch ${methodName}${loc(node)}`
        )}`;
      }

      // Regular function call
      const name = callee.name;

      // ChipType-generic free function call (e.g. `loadFirmware(chip, ...)`) — route to
      // the concrete monomorphized instantiation for whatever type `chip` resolves to
      // here (see "ChipType monomorphization" above), instead of the generic/erased
      // signature. Covers both a class method calling with `this` and one generic
      // function forwarding its own chip-typed param to another.
      if (genericFreeFunctionDecls.has(name)) {
        const decl = genericFreeFunctionDecls.get(name);
        const chipArgNode = node.arguments[decl.chipParamIndex];
        const concreteType = resolveExprType(chipArgNode, ctx) || 'RP2350';
        const mangled = registerGenericInstantiation(name, concreteType);
        const targetFn = freeFunctions.get(mangled);
        let genArgs = node.arguments.map((a) => emitExpr(a, funcName, params, ctx));
        while (genArgs.length < targetFn.params.length) {
          genArgs.push(targetFn.params[genArgs.length]?.default ?? '0');
        }
        genArgs = genArgs.map((a, i) =>
          wrapArgIfInterfaceParam(
            a,
            node.arguments[i],
            targetFn.params[i]?.type,
            ctx,
            funcName,
            params
          )
        );
        return `${mangled}(${genArgs.join(', ')})`;
      }

      let args = node.arguments.map((a) => emitExpr(a, funcName, params, ctx));

      // Pad with defaults for free functions/methods/local arrow functions with default
      // (or plain optional, e.g. `core?: number`) params — C has no such thing, so a
      // call site that legitimately omits a trailing optional arg in TS needs the
      // missing slots filled in to match the emitted C function's fixed arity.
      const targetFn =
        freeFunctions.get(name) ??
        classes.get(ctx.className)?.methods.get(name) ??
        ctx.localFunctions?.[name];
      if (targetFn) {
        // self is already passed for class methods; compare to param count
        while (args.length < targetFn.params.length) {
          const missingIdx = args.length;
          const missingParam = targetFn.params[missingIdx];
          args.push(missingParam?.default ?? '0');
        }
        args = args.map((a, i) =>
          castStubForType(
            wrapArgIfInterfaceParam(
              a,
              node.arguments[i],
              targetFn.params[i]?.type,
              ctx,
              funcName,
              params
            ),
            targetFn.params[i]?.type
          )
        );
      }

      // Boolean(x) → (x != 0), Number(x) → (int32_t)(x)
      if (name === 'Boolean') return `((${args.join(',')}) != 0)`;
      if (name === 'Number') return `((int32_t)(${args.join(',')}))`;
      // isNaN/isFinite → their <math.h> namesakes (isnan/isfinite) — both are
      // type-generic macros over "real floating type" only, so an int32_t-typed
      // argument (cts2c's default for any not-specifically-double expression) needs
      // an explicit cast; passing it bare doesn't satisfy the generic association.
      if (name === 'isNaN') return `isnan((double)(${args.join(',')}))`;
      if (name === 'isFinite') return `isfinite((double)(${args.join(',')}))`;
      // parseInt(str, radix?) → strtoul(str, NULL, radix) — strtoul's signature is
      // (str, endptr, base), not (str, base, endptr, ...); the previous version just
      // appended ", NULL, 0" after ALL of parseInt's args, so parseInt(s, 16) produced
      // a 4-argument strtoul(s, 16, NULL, 0) instead of the correct strtoul(s, NULL, 16).
      if (name === 'parseInt') return `((int32_t)strtoul(${args[0]}, NULL, ${args[1] ?? '0'}))`;

      // Builtin number helpers
      // Bit helpers from utils/bit.ts
      if (name === 'u32') return `((uint32_t)(${args.join(',')}))`;
      if (name === 's32') return `((int32_t)(${args.join(',')}))`;
      if (name === 'bit') return `(1 << (${args.join(',')}))`;

      // Int53 pack/unpack intrinsics — utils/types.ts's int53High/int53Pack back onto
      // native uint64_t bit ops (the JS helpers use float division/addition to dodge the
      // ToInt32 truncation of JS bitwise ops on values >2^31). Unchecked calls fall back
      // to the real JS helper function bodies, which transpile (correctly, just slowly).
      if (name === 'int53High' && args.length === 1)
        return `((uint32_t)((uint64_t)(${args[0]}) >> 32))`;
      if (name === 'int53Pack' && args.length === 2)
        return `(((uint64_t)(uint32_t)(${args[0]})) | (((uint64_t)(uint32_t)(${args[1]})) << 32))`;

      const builtins = { signExtend8: 'signExtend8', signExtend16: 'signExtend16' };
      if (builtins[name]) return `${builtins[name]}(${args.join(', ')})`;

      // Host/JS-runtime-only functions with no C equivalent (timers) — stub rather
      // than emit a call to a function that was never generated. decodeBlock:
      // imported from the external `uf2` npm package, not something defined anywhere
      // in src/ — cts2c has no way to transpile a third-party package's
      // implementation, so this one's necessarily unsupported too. readFileSync is
      // NOT stubbed here — it's a real runtime helper (see the preamble), needed to
      // actually load firmware into the emulator; call sites pass either (path) or
      // (path, encoding), handled by its variadic C signature.
      if (
        [
          'setTimeout',
          'clearTimeout',
          'setInterval',
          'clearInterval',
          'writeFileSync',
          'decodeBlock',
        ].includes(name)
      ) {
        return `/* TODO: ${name}()${loc(node)} */ ${stubAbortExpr(`${name}()${loc(node)}`)}`;
      }

      // readFileSync's path argument is sometimes itself derived from an unresolved
      // TODO stub (e.g. tryLoadDisassembly's `path.replace(new RegExp(...), '.dis')` —
      // regex-based path manipulation isn't supported, so `disPath` stays a bare
      // int32_t 0) — calling the real readFileSync with that would pass a small
      // integer where a pointer is expected. Fall back to the safe no-op stub
      // whenever the argument doesn't positively resolve to a real string.
      if (name === 'readFileSync' && !isCharPtrExpr(node.arguments[0], params, ctx)) {
        return `/* TODO: readFileSync() with unresolved path${loc(node)} */ ${stubAbortExpr(
          `readFileSync() with unresolved path${loc(node)}`
        )}`;
      }

      return `${name}(${args.join(', ')})`;
    }

    case 'BinaryExpression': {
      // instanceof — no runtime type info to check against in C in general, BUT this
      // project transpiles a fixed, single concrete target (RP2350), and cts2c's whole
      // ChipType-monomorphization model already treats every
      // generic `ChipType`-typed value as concretely RP2350 (see cTypeOf's ChipType
      // case). A blind `(0)` stub silently means "always false", which is wrong
      // whenever the source code uses `instanceof` specifically to special-case
      // RP2350 behavior.
      //
      // Resolve using the left operand's own known static type when one exists (a
      // concrete class, walking its parent chain, decides the answer exactly); fall
      // back to true only for the project's hardcoded concrete chip type (RP2350)
      // itself, matching a ChipType-generic parameter/field's own real resolved type.
      if (node.operator === 'instanceof') {
        const rightName = node.right?.name;
        if (rightName && classes.has(rightName)) {
          const leftType = resolveExprType(node.left, ctx);
          if (leftType) {
            let cur = leftType;
            while (cur) {
              if (cur === rightName) return '1';
              cur = classes.get(cur)?.parent;
            }
            return '0';
          }
          if (rightName === 'RP2350') return '1';
        }
        return '(0)';
      }

      // in operator → stub
      if (node.operator === 'in') return '(0)';

      // `opts.intCtx` (see the `/` case below) propagates into the operands of any
      // operator that converts its own operands to an integer anyway — the bitwise and
      // shift operators, which already emit explicit `(int32_t)`/`(uint32_t)` casts. It
      // deliberately does NOT propagate through `+`/`-`/`*`/`%` from nothing: an integer
      // consumer of a SUM says nothing about whether a division inside that sum was meant
      // to be fractional (`(elapsed / 1e9) * freq` is exactly that shape). It does keep
      // propagating once already inside an integer context, so an expression like
      // `1 << (x / 4 + 1)` stays integral throughout and still compiles.
      //
      // EXCEPT: `X >>> 0` / `X | 0` — a right operand that's the literal `0` isn't a
      // real bitwise operation at all, it's this codebase's extremely common "truncate
      // to (u)int32" idiom (JS has no dedicated cast syntax). `X` there is a value being
      // computed with its own, independent floating-point semantics and THEN truncated
      // — the truncation doesn't mean every division nested anywhere inside X was ALSO
      // meant to be integer division. Contrast a real shift/mask (`1 << (x/4+1)`, `a &
      // (b/2)`): there the non-zero right operand marks a genuine bitwise operation
      // whose left operand really does want integer semantics throughout.
      const isZeroRhsTruncationIdiom =
        ['>>>', '|'].includes(node.operator) &&
        node.right?.type === 'NumericLiteral' &&
        node.right.value === 0;
      const intOperands =
        !isZeroRhsTruncationIdiom &&
        (['|', '&', '^', '<<', '>>', '>>>'].includes(node.operator) ||
          (opts?.intCtx && ['+', '-', '*', '%'].includes(node.operator)));
      const operandOpts = intOperands ? { intCtx: true } : undefined;
      const left = emitExpr(node.left, funcName, params, ctx, operandOpts);
      const right = emitExpr(node.right, funcName, params, ctx, operandOpts);

      // JS `/` is ALWAYS floating-point division; C's `/` on two integers truncates. Most
      // divisions here are plainly integer-intent (a register-offset-to-index conversion
      // like `(offset - ALARM0) / 4`, RISC-V's own DIV/DIVU instructions) and emitting
      // double division for those would be slower for no gain — so it's applied only where
      // the result ISN'T immediately converted back to an integer anyway, which `intCtx`
      // marks (bitwise/shift operands and counts, array subscripts, `~`). RV32M's `(a / b)
      // | 0` and `((a >>> 0) / (b >>> 0)) >>> 0` therefore stay integer division. Without
      // this, any division on a genuinely fractional value (e.g. a nanosecond delta
      // divided by 1e9 to get elapsed seconds) truncates to 0 whenever the true result is
      // under 1. Also makes `Math.floor(a / b)` genuinely floor for negative operands
      // (integer division truncates toward zero, not floors).
      if (node.operator === '/' && !opts?.intCtx) {
        return `((double)(${left}) / (double)(${right}))`;
      }

      // String concatenation (`a + b` where both sides are const char*) — C has no `+`
      // for strings. Only handled when we can positively identify a string operand
      // (StringLiteral, or an Identifier/field known to be typed const char*); anything
      // else keeps the plain numeric `+` below, same as before.
      if (
        node.operator === '+' &&
        (isCharPtrExpr(node.left, params, ctx) || isCharPtrExpr(node.right, params, ctx))
      ) {
        return `strConcat2(${castStubForType(left, 'const char*')}, ${castStubForType(
          right,
          'const char*'
        )})`;
      }

      // ** (exponentiation) → pow() — C has no exponent operator; left as the literal
      // `**` operator, this doesn't even parse as valid C (`2 ** 32` lexes as `2 * (*32)`
      // — multiplication followed by a dereference of the integer literal 32).
      if (node.operator === '**') {
        return `pow(${left}, ${right})`;
      }

      // % on a genuinely floating-point operand (e.g. `Math.floor(x) % TWO32`, common
      // for splitting a millisecond timestamp into hi/lo 32-bit halves — TWO32 itself
      // is 2**32, already too big for int32_t) needs fmod(), not C's integer-only %.
      // JS's own `%` is always fmod-like semantics regardless of operand type, but
      // rewriting every integer modulo (the overwhelmingly common case, e.g. array
      // indexing) to fmod() would be a real, needless perf cost in a project whose
      // whole point is performance — restrict this to the specific double-producing
      // shapes actually seen (Math.floor/ceil/round/trunc/sqrt/pow, or a nested **).
      const looksDouble = (n) =>
        (n?.type === 'BinaryExpression' && (n.operator === '**' || n.operator === '/')) ||
        (n?.type === 'CallExpression' &&
          n.callee?.type === 'MemberExpression' &&
          n.callee.object?.type === 'Identifier' &&
          n.callee.object.name === 'Math' &&
          ['floor', 'ceil', 'round', 'trunc', 'sqrt', 'pow', 'abs'].includes(
            n.callee.property?.name
          ));
      if (node.operator === '%' && (looksDouble(node.left) || looksDouble(node.right))) {
        return `fmod((double)(${left}), (double)(${right}))`;
      }

      // JS's three shift operators all mask the shift COUNT to its low 5 bits (`x >>> 36`
      // means `x >>> 4`); C leaves a count >= the operand's width undefined. `shiftCount`
      // reconciles them: a literal count is folded at transpile time (free), a runtime
      // one gets an explicit `& 31`, since nothing stops a runtime count from reaching
      // 32 or more.
      if (node.operator === '>>>') {
        return `((uint32_t)(${left}) >> ${shiftCount(node.right, right)})`;
      }

      // Handle arithmetic >> (signed)
      if (node.operator === '>>') {
        return `((int32_t)(${left}) >> ${shiftCount(node.right, right)})`;
      }

      // Map JS-only operators to C equivalents
      const op = node.operator === '===' ? '==' : node.operator === '!==' ? '!=' : node.operator;

      // `str[i] === 'x'` — JS string indexing yields a 1-character STRING, but
      // cts2c represents strings as bare char*, so `line[0]` compiles to a raw `char`
      // (int), not a pointer. A single-character string literal compared against a
      // computed index access is this idiom (common in line-based parsers, e.g.
      // load-hex.ts's `line[0] !== ':'`) — compare as a C char literal, not a string.
      // Must be checked before the general string-equality case below, which would
      // otherwise wrongly try to strcmp a raw int against a char* literal.
      const isSingleCharLit = (n) => n?.type === 'StringLiteral' && n.value.length === 1;
      const isComputedIndex = (n) => n?.type === 'MemberExpression' && n.computed;
      if (
        (op === '==' || op === '!=') &&
        ((isSingleCharLit(node.left) && isComputedIndex(node.right)) ||
          (isSingleCharLit(node.right) && isComputedIndex(node.left)))
      ) {
        const toCharLit = (n, str) => (isSingleCharLit(n) ? `'${cStringEscape(n.value)}'` : str);
        return `(${toCharLit(node.left, left)} ${op} ${toCharLit(node.right, right)})`;
      }

      // String equality (`===`/`==`, `!==`/`!=`) — bare pointer `==` only happens to
      // "work" when both sides are compile-time string literals GCC pools into the
      // same address (technically unspecified behavior per the C standard); it
      // silently always returns false for a genuinely dynamic string (e.g.
      // `line.substring(...)`) compared against a literal, which is exactly the shape
      // Intel HEX record-type parsing needs (see load-hex.ts's inspectHex). Real
      // strcmp handles both cases. Requires BOTH sides to positively resolve as
      // char* (not just either, which would also misfire on the char-vs-literal case
      // above whenever the char side isn't recognized as a computed index).
      if (
        (op === '==' || op === '!=') &&
        isCharPtrExpr(node.left, params, ctx) &&
        isCharPtrExpr(node.right, params, ctx)
      ) {
        return op === '=='
          ? `(strcmp(${left}, ${right}) == 0)`
          : `(strcmp(${left}, ${right}) != 0)`;
      }

      // |, &, ^ implicitly ToInt32-coerce both operands in JS — cast explicitly, same
      // as >>/>>> just above. Without this, an operand that's genuinely a C `double`
      // (e.g. `Math.floor(x) | 0`, the common JS truncate-to-int32 idiom — `floor()`
      // maps straight to C's double-returning floor()) is a real "invalid operands to
      // binary |" compile error, not just an imprecision.
      if (['|', '&', '^'].includes(op)) {
        return `((int32_t)(${left}) ${op} (int32_t)(${right}))`;
      }
      // `<<` needs an UNSIGNED left operand, not just an int32_t cast — shifting a
      // negative value left is undefined behavior in C (the standard requires a
      // non-negative left operand), unlike JS, which defines `<<` precisely as a
      // 32-bit wraparound regardless of sign — and a negative left operand is entirely
      // ordinary in this codebase (any register can hold one). Cast back to int32_t
      // after the shift, matching every other operator here.
      if (op === '<<') {
        return `((int32_t)((uint32_t)(${left}) << ${shiftCount(node.right, right)}))`;
      }

      // Handle +, -, *, /, %, ==, !=, <, >, <=, >=
      return `(${left} ${op} ${right})`;
    }

    // `&&`, `||` and `??` all evaluate to one of their OPERANDS in JS — never to a 0/1
    // boolean. C's `&&`/`||` do produce a 0/1 boolean, so emitting them directly is only
    // correct where the result is immediately tested for truthiness. In a VALUE position
    // it silently discards the operand instead (e.g. `const period = top * 2 || 1;`
    // compiling to `((top * 2) || 1)`, always 1 regardless of `top`).
    //
    // So: keep the cheap boolean form in boolean context (which is where essentially
    // every `&&`/`||` in the CPU cores' hot paths lives — see emitCondExpr), and lower a
    // value-position use to the operand-preserving ternary JS actually specifies.
    //
    // Truthiness here stays cts2c's usual approximation — a falsy/zero test, not a strict
    // null/undefined test, so `??` and `||` coincide (0 is indistinguishable from
    // null/undefined once everything is an int32_t). Deliberately NOT marked with a
    // `/* TODO */` in the emitted C: these produce working, correctly-typed values, and
    // the stub-propagation check in the MemberExpression case (`objStr.includes('/*
    // TODO')`) would wrongly discard a subsequent `(x ?? y).field` as unresolved.
    case 'LogicalExpression': {
      const op = node.operator;
      if (opts?.boolCtx && (op === '&&' || op === '||')) {
        // Operands of a boolean-context `&&`/`||` are themselves only tested for
        // truthiness, so the context propagates (and an interface-typed operand gets its
        // fat pointer unwrapped by emitCondExpr, which a bare emitExpr would not do).
        const l = emitCondExpr(node.left, funcName, params, ctx);
        const r = emitCondExpr(node.right, funcName, params, ctx);
        return `(${l} ${op} ${r})`;
      }
      const left = emitExpr(node.left, funcName, params, ctx);
      const right = emitExpr(node.right, funcName, params, ctx);
      // `a ?? b` differs from `a || b`: JS `??` only falls back to `b` when `a` is
      // strictly null/undefined, NOT for every other falsy value (0, false, '').
      // For a pointer-shaped operand (class/interface instance, const char*, array) C
      // has exactly one "no value" state — the null pointer — which already means
      // the same thing JS's null/undefined does here, so a truthy check on the
      // pointer genuinely IS a correct null check; no gap. It's only a plain scalar
      // (int32_t/bool/double) operand where this approximation can go wrong: once a
      // TS-optional scalar field (e.g. `initChip?: boolean`) has been flattened into
      // an ordinary struct member (see collectTypes' interface/TSTypeLiteral field
      // handling), the struct has no separate "never set" bit distinct from the
      // type's own zero value — a real fix needs an actual presence-tracking
      // representation (a companion `_isSet` flag, or promoting the field to a
      // pointer), which nothing in this file does yet. This is the same known gap as
      // the `loadFirmware(path, { initChip: false })` case — not a new bug, and not
      // reachable in this project's own transpiled
      // call graph today (every in-scope call site either passes a pointer-shaped
      // `??` operand, omits the options object entirely, or happens to use a
      // fallback that equals the falsy value it'd wrongly trigger on).
      const ternary = (l) =>
        op === '&&' ? `(${l} ? ${right} : ${l})` : `(${l} ? ${l} : ${right})`;
      if (isPureExpr(node.left)) return ternary(left);
      // An impure left operand can't be named twice. A GNU statement expression binds it
      // to a single temporary of its own type — gcc-only, which this project already is
      // (see the transpile-check gcc invocation), and unavailable at file scope, hence
      // the funcName guard (a top-level `const` initializer, the only funcName-less emit
      // site, can only hold literal/constant forms anyway, which are always pure).
      if (funcName) {
        // Uniquely numbered rather than a fixed name: a nested logical expression puts
        // one of these inside another's operand (i2c.ts's three-way `a && b && c` does),
        // and a repeated name would shadow — legal C, but needlessly confusing to read
        // and a -Wshadow tripwire.
        const t = `__lg_${switchTmpCounter++}`;
        return `(__extension__({ __typeof__(${left}) ${t} = (${left}); ${
          op === '&&' ? `${t} ? (${right}) : ${t}` : `${t} ? ${t} : (${right})`
        }; }))`;
      }
      return ternary(left);
    }

    case 'UnaryExpression': {
      if (node.operator === 'typeof') return '0';
      // `!x` tests its operand for truthiness and nothing else — so the operand is a
      // boolean context: an interface-typed one needs its fat pointer unwrapped to
      // `.obj` (a bare struct isn't something gcc can apply `!` to at all), and a nested
      // `&&`/`||` can keep the cheap boolean form.
      if (node.operator === '!') return `(!${emitCondExpr(node.argument, funcName, params, ctx)})`;
      // `-2147483648` (a NumericLiteral argument, not a folded constant): the
      // NumericLiteral case below gives any literal > INT32_MAX a `u` suffix for
      // unsigned comparison correctness — but negating an unsigned literal wraps
      // (e.g. `-2147483648u` evaluates to +2147483648, not INT32_MIN), silently
      // inverting any comparison against it. A negative value is never unsigned,
      // so emit the already-negated literal directly, with no suffix.
      if (node.operator === '-' && node.argument?.type === 'NumericLiteral') {
        return `(${-node.argument.value})`;
      }
      // `~` ToInt32-coerces its operand in JS and is integer-only in C — an integer
      // context, same as the bitwise binary operators (see the `/` case in BinaryExpression).
      const arg = emitExpr(
        node.argument,
        funcName,
        params,
        ctx,
        node.operator === '~' ? { intCtx: true } : undefined
      );
      if (node.operator === 'void') return `(void)${arg}`;
      return `(${node.operator}${arg})`;
    }

    case 'UpdateExpression': {
      const arg = emitExpr(node.argument, funcName, params, ctx);
      return node.prefix ? `(${node.operator}${arg})` : `(${arg}${node.operator})`;
    }

    case 'AssignmentExpression': {
      // Cross-instance closure override (`this.watchdog.onWatchdogTrigger = () => {
      // this.reset(); ... };`) — collectExternalClosureAssignments (run once, up
      // front, from emitClassImpl) already emitted the actual function and stashed
      // its name directly on this AST node; just wire up the two struct members.
      if (node.__closureFnName) {
        const receiverStr =
          node.left.object.type === 'ThisExpression'
            ? 'self'
            : emitExpr(node.left.object, funcName, params, ctx);
        const field = resolveFieldInfo(node.left, ctx);
        return `(__extension__({ ${receiverStr}->${field.fnField} = ${node.__closureFnName}; ${receiverStr}->${field.ctxField} = (void*)self; }))`;
      }

      // [a, b] = expr — array-destructuring assignment (as opposed to a destructuring
      // *declaration*, which VariableDeclaration already handles separately). The RHS
      // is always a tuple-returning ([T, T] → T*, by convention) call in this codebase,
      // which can't be meaningfully split across scalar targets in C — assigning the
      // whole tuple pointer into each (scalar-typed) target would just trade the
      // original "TODO text used as an lvalue" error for a pointer-into-int assignment
      // error instead. Evaluate the RHS once, for any side effects, and leave it there;
      // don't touch the destructured targets at all.
      if (node.left.type === 'ArrayPattern') {
        const right = emitExpr(node.right, funcName, params, ctx);
        return `/* TODO: array destructuring assignment${loc(
          node
        )} */ (__extension__({ (void)(${right}); ${stubAbortStmt(
          `array destructuring assignment${loc(node)}`
        )} 0; }))`;
      }

      // `this.prop = value` / `obj.prop = value` where `prop` has a REAL setter — call
      // through it (`ClassName_prop_set(self, value)`) instead of assigning to a plain
      // struct field. Must be intercepted here, BEFORE emitExpr(node.left) runs the
      // generic MemberExpression path below (which handles READS — calling it on an
      // assignment TARGET would either emit a getter call as an invalid lvalue, if a
      // getter also exists, or silently write to a stub field that nothing reads back
      // from, if it doesn't). A getter-only property can't be assigned to in valid TS,
      // so this is the only place a setter-backed property's write can appear.
      if (node.left.type === 'MemberExpression' && !node.left.computed) {
        const prop = node.left.property?.name;
        const ownerClassName =
          node.left.object?.type === 'ThisExpression'
            ? ctx?.className
            : classes.has(resolveExprType(node.left.object, ctx))
            ? resolveExprType(node.left.object, ctx)
            : null;
        const setterClass = ownerClassName ? findSetterDefiningClass(ownerClassName, prop) : null;
        if (setterClass) {
          const selfExpr =
            node.left.object?.type === 'ThisExpression'
              ? selfPathTo('self', ownerClassName, setterClass)
              : selfPathTo(
                  emitExpr(node.left.object, funcName, params, ctx),
                  ownerClassName,
                  setterClass
                );
          const sig = classes.get(setterClass).setters.get(prop);
          let rightVal = emitExpr(node.right, funcName, params, ctx);
          rightVal = wrapArgIfInterfaceParam(
            rightVal,
            node.right,
            sig?.paramType,
            ctx,
            funcName,
            params
          );
          if (node.operator === '=') {
            return `${setterClass}_${prop}_set(${selfExpr}, ${rightVal})`;
          }
          // Compound assignment (`+=`, `|=`, ...) on a setter-backed property — read
          // the current value back through emitExpr on the SAME left-hand-side node
          // (routes through the getter-call codegen above if one exists for this
          // property, or the plain zeroed-stub field read if it's setter-only —
          // matching real JS's "reading a write-only accessor gives undefined").
          const currentVal = emitExpr(node.left, funcName, params, ctx);
          const op = node.operator.slice(0, -1); // '+=' -> '+', etc.
          return `${setterClass}_${prop}_set(${selfExpr}, (${currentVal} ${op} ${rightVal}))`;
        }
      }

      const left = emitExpr(node.left, funcName, params, ctx);

      // Assignment to an unresolved interface/dynamic property target — the LHS isn't
      // a real lvalue in the generated C (it's a stub), so this can't become a normal
      // `lhs = rhs` assignment. Checked via `.includes` (not `.startsWith`) since the
      // stub text can appear after a leading abort-expression rather than at the very
      // start of the string.
      if (left.includes('/* TODO: iface') || left.includes('/* TODO: chained')) {
        return stubAbortExpr(`iface assign${loc(node)}`);
      }

      let right = emitExpr(
        node.right,
        funcName,
        params,
        ctx,
        ['|=', '&=', '^=', '<<=', '>>=', '>>>='].includes(node.operator)
          ? { intCtx: true }
          : undefined
      );

      // `x = expr` where `x` is declared as a behavioral interface (e.g. `clock:
      // IClock`) but `expr` resolves to a concrete class implementing it (e.g.
      // `rp2040.clock`, itself untyped and inferred as the concrete
      // `SimulationClock*`) — box into the interface's fat pointer, same gap as
      // call-argument/return boxing above.
      if (node.operator === '=') {
        const leftType = resolveExprType(node.left, ctx);
        right = wrapArgIfInterfaceParam(right, node.right, leftType, ctx, funcName, params);
        // `leftType` above is a bare class/interface NAME (resolveExprType's own
        // convention for the boxing check just done) — missing whatever `*`s a real
        // C type needs, so it's unsafe to cast a stub with directly (casting e.g. an
        // array-of-instances field's stub to a name one pointer-star short of its
        // real type just trades one compile error for another). `resolveFieldInfo`
        // returns the field's actual, fully-qualified C type instead, for the direct
        // `this.field = ...` / `obj.field = ...` shape (not a computed/array target,
        // a different shape resolveFieldInfo doesn't cover here).
        if (node.left.type === 'MemberExpression' && !node.left.computed) {
          const fieldType = resolveFieldInfo(node.left, ctx)?.type;
          right = castStubForType(right, fieldType);
        }
      }

      // Handle >>>= for unsigned right shift assignment
      // Same JS-masks-the-shift-count rule as the BinaryExpression shift cases (see
      // `shiftCount`) — a compound shift-assignment is no different.
      if (node.operator === '>>>=') {
        return `(${left} = (uint32_t)(${left}) >> ${shiftCount(node.right, right)})`;
      }
      if (node.operator === '>>=') {
        return `(${left} = (int32_t)(${left}) >> ${shiftCount(node.right, right)})`;
      }
      // `x <<= n` — same undefined-behavior-on-negative-operand fix as the
      // BinaryExpression `<<` case (see there): a bare `(${left} <<= ${right})` would
      // shift `left`'s OWN (signed) value directly, UB in C whenever it's negative —
      // an entirely ordinary case for e.g. pio.ts's `this.outputShiftReg <<= bitCount`
      // (a 32-bit shift register, half its possible values have the sign bit set).
      if (node.operator === '<<=') {
        return `(${left} = (int32_t)((uint32_t)(${left}) << ${shiftCount(node.right, right)}))`;
      }

      // `str += other` (string concatenation, same string-operand detection as the
      // BinaryExpression '+' case) — C has no `+=` for pointers.
      if (
        node.operator === '+=' &&
        (isCharPtrExpr(node.left, params, ctx) || isCharPtrExpr(node.right, params, ctx))
      ) {
        return `(${left} = strConcat2(${castStubForType(left, 'const char*')}, ${castStubForType(
          right,
          'const char*'
        )}))`;
      }

      return `(${left} ${node.operator} ${right})`;
    }

    case 'ConditionalExpression': {
      const test = emitCondExpr(node.test, funcName, params, ctx);
      let cons = emitExpr(node.consequent, funcName, params, ctx);
      let alt = emitExpr(node.alternate, funcName, params, ctx);
      // A ternary's two branches must agree on type in C, unlike JS. If one branch is
      // one of cts2c's abort stubs, cast it to whatever the OTHER branch's type looks
      // like (a string literal is the common real case here — e.g. `x !== undefined ?
      // x.toString(16) : 'unknown'`, where the unsupported `.toString()` branch needs
      // to match its sibling's `const char*`).
      if (cons.includes(STUB_ABORT_MARKER) && isCharPtrExpr(node.alternate, params, ctx)) {
        cons = castStubForType(cons, 'const char*');
      } else if (alt.includes(STUB_ABORT_MARKER) && isCharPtrExpr(node.consequent, params, ctx)) {
        alt = castStubForType(alt, 'const char*');
      }
      return `(${test} ? ${cons} : ${alt})`;
    }

    case 'NewExpression': {
      const ctor = node.callee?.name;
      // TypedArray allocation
      if (ctor?.match(/^(Int|Uint|Float)(8|16|32|53|64)Array$/)) {
        const elType = typedArrayCType(ctor);
        const arg0 = node.arguments[0];
        // `new Uint16Array(someOtherTypedArray.buffer)` — the ArrayBuffer-aliasing
        // overload (a reinterpret view over existing memory), not the element-count
        // overload (`new Uint16Array(100)`). A raw typed array is just its own buffer
        // once transpiled to a bare C pointer, so this is a pointer cast, not an
        // allocation — treating `.buffer` as an element count and calloc()ing that many
        // bytes (the element-count codegen path) doesn't even compile (`.buffer` isn't
        // a real struct member on a bare pointer).
        if (
          arg0?.type === 'MemberExpression' &&
          !arg0.computed &&
          arg0.property?.name === 'buffer'
        ) {
          return `(${elType}*)(${emitExpr(arg0.object, funcName, params, ctx)})`;
        }
        // `new Uint32Array(SOME_CONST_ARRAY)` — the construct-FROM-an-existing-array
        // overload (copies values in), not the element-count overload (`new
        // Uint32Array(N)`) — telling them apart requires knowing whether the bare
        // identifier argument is itself an array or a number (arrayConstNames tracks
        // which top-level consts were emitted as a real C array). Without this, the
        // count-overload codegen path below treated the whole array as if it were a
        // single integer element count (`calloc(SOME_CONST_ARRAY, ...)` — passing an
        // array's address where an integer count is expected).
        if (arg0?.type === 'Identifier' && arrayConstNames.has(arg0.name)) {
          const name = cName(arg0.name);
          return `memcpy(calloc(sizeof(${name}) / sizeof(${name}[0]), sizeof(${elType})), ${name}, sizeof(${name}))`;
        }
        const size = emitExpr(arg0, funcName, params, ctx);
        return `calloc(${size}, sizeof(${elType}))`;
      }
      // Class allocation
      if (classes.has(ctor)) {
        let args = node.arguments.map((a) => emitExpr(a, funcName, params, ctx));
        // Pad missing optional constructor args with their default, same as every other
        // call site — `new RP2040()` when the constructor is `constructor(options:
        // RP2040Options = {})` compiled to a 0-arg call against a 1-param C function.
        const ctorSig = classes.get(ctor).methods.get('constructor');
        if (ctorSig) {
          while (args.length < ctorSig.params.length) {
            args.push(ctorSig.params[args.length]?.default ?? '0');
          }
          args = args.map((a, i) =>
            castStubForType(
              wrapArgIfInterfaceParam(
                a,
                node.arguments[i],
                ctorSig.params[i]?.type,
                ctx,
                funcName,
                params
              ),
              ctorSig.params[i]?.type
            )
          );
        }
        return `${ctor}_new(${args.join(', ')})`;
      }
      return `/* TODO: new ${ctor}()${loc(node)} */ ${stubAbortExpr(`new ${ctor}()${loc(node)}`)}`;
    }

    case 'ArrayExpression': {
      // A flat numeric-array literal (`[0, 0]`, `nvicPending`/`mpuMair`'s shape) used in
      // a VALUE position — e.g. as an object-literal property's value inside
      // wrapArgIfInterfaceParam's per-field `emitExpr(p.value, ...)` call — has no
      // target type of its own here, but unlike the general case below it doesn't NEED
      // one: every element is a self-contained compile-time numeric expression, so a
      // malloc'd/memcpy'd int32_t array can be built directly from the literal, the
      // value-position counterpart to collectTypes' own flat-numeric-array field-
      // initializer case. Heap-allocated (not a C99 compound literal) since the result
      // commonly escapes into a struct/field that outlives this statement — same
      // reasoning as wrapArgIfInterfaceParam's own memcpy.
      if (
        node.elements.length > 0 &&
        node.elements.every(
          (e) =>
            e?.type === 'NumericLiteral' ||
            e?.type === 'UnaryExpression' ||
            e?.type === 'BinaryExpression'
        )
      ) {
        const n = node.elements.length;
        const elemsC = node.elements.map((e) => emitExpr(e, funcName, params, ctx));
        return `memcpy(malloc(${n} * sizeof(int32_t)), (int32_t[]){ ${elemsC.join(
          ', '
        )} }, ${n} * sizeof(int32_t))`;
      }
      // The elements are deliberately NOT emitted: there's no target type here to build an
      // array against (the shapes that do have one are handled by emitFieldInitializers and
      // the ExpressionStatement assignment cases), so the result is a stub either way — and
      // emitting element expressions only to throw the strings away also ran their codegen
      // side effects (registering ChipType instantiations, recording const renames) for
      // output that never appears.
      return `/* TODO: array literal${loc(node)} */ ${stubAbortExpr(`array literal${loc(node)}`)}`;
    }

    case 'TemplateLiteral': {
      // Basic logger/error-message pattern: `text ${expr} more text` → a real C
      // string via fmtStr() (see its definition — a vsnprintf-into-a-static-buffer
      // helper), so messages like "Unimplemented peripheral read from 0x${offset
      // .toString(16)}" and `throw Error(...)` actually print something instead of
      // silently degrading to `/* TODO: template */ 0` (a literal 0 passed where a
      // const char* was expected, printing "(null)"). Only handles the patterns
      // actually used in this codebase's log/error messages: `${x.toString(16)}`
      // (hex), a plain string-typed expr (%s), and everything else as decimal (%d).
      let fmt = '';
      const args = [];
      for (let i = 0; i < node.quasis.length; i++) {
        fmt += node.quasis[i].value.raw
          .replace(/%/g, '%%')
          .replace(/\\/g, '\\\\')
          .replace(/"/g, '\\"')
          .replace(/\n/g, '\\n');
        if (i < node.expressions.length) {
          let exprNode = node.expressions[i];
          let radix = null;
          if (
            exprNode.type === 'CallExpression' &&
            exprNode.callee?.type === 'MemberExpression' &&
            !exprNode.callee.computed &&
            exprNode.callee.property?.name === 'toString' &&
            exprNode.arguments?.[0]?.type === 'NumericLiteral'
          ) {
            radix = exprNode.arguments[0].value;
            exprNode = exprNode.callee.object;
          }
          const argC = emitExpr(exprNode, funcName, params, ctx);
          if (radix === 16) {
            fmt += '%x';
            args.push(`(unsigned)(${argC})`);
          } else if (isCharPtrExpr(exprNode, params, ctx)) {
            fmt += '%s';
            args.push(argC);
          } else {
            // Covers radix-2/8 .toString() calls too (no direct printf equivalent) —
            // decimal is a reasonable approximation for a log message.
            fmt += '%d';
            args.push(argC);
          }
        }
      }
      return args.length ? `fmtStr("${fmt}", ${args.join(', ')})` : `"${fmt}"`;
    }

    case 'ParenthesizedExpression':
      return `(${emitExpr(node.expression, funcName, params, ctx)})`;

    case 'TSAsExpression': {
      // For type inference, the cast target type is what matters
      // (e.g. `this.rp2040 as unknown as RP2040` → variable is RP2040*)
      // The emitted expression is normally just the inner expression (a TS cast is a
      // no-op at runtime) — EXCEPT when the cast target is a different concrete class
      // than what the underlying expression's own type resolves to. This genuinely
      // happens: `ChipType` is always resolved to the concrete RP2350 (the "superset"
      // chip, used as cts2c's one universal build target), but some peripheral classes
      // (e.g. RPPPB) are only ever instantiated by RP2040, and their own code casts the
      // ChipType-generic field back to RP2040 (`this.rp2040 as unknown as RP2040`) —
      // correct in TS (untyped at runtime), but in C, self->base.rp2040 is genuinely
      // typed RP2350* everywhere, so assigning it to an RP2040* variable needs an actual
      // pointer cast or gcc rejects it outright.
      const innerStr = emitExpr(node.expression, funcName, params, ctx);
      const castType =
        node.typeAnnotation?.typeName?.name ?? node.typeAnnotation?.typeAnnotation?.typeName?.name;
      if (castType && classes.has(castType)) {
        const actualType = resolveExprType(node.expression, ctx);
        if (actualType && actualType !== castType && classes.has(actualType)) {
          return `((${castType}*)(${innerStr}))`;
        }
        // Casting an interface fat-pointer VALUE (e.g. `this.rp2040.core[i]`, typed
        // ICpuCore[] on the interface, even though it's really always a CortexM33Core)
        // back to a concrete class — reach through the fat pointer's `.obj` (the real
        // underlying pointer) rather than casting the whole `{ obj, vtable }` struct,
        // which isn't a pointer at all.
        if (actualType && interfaces.has(actualType)) {
          return `((${castType}*)((${innerStr}).obj))`;
        }
      }
      return innerStr;
    }

    // expr! (non-null assertion) — purely a TS type-narrowing hint, no runtime effect.
    case 'TSNonNullExpression':
      return emitExpr(node.expression, funcName, params, ctx);

    // `obj.callback?.(...)` — babel parses the `?.` call as its own node type,
    // distinct from a plain CallExpression even when the callee itself isn't
    // optional-chained. Only the closure-field-call shape (see tryClosureFieldCall)
    // is specifically supported; anything else falls back to the same generic stub
    // every other unsupported construct gets.
    case 'OptionalCallExpression': {
      const closureCall = tryClosureFieldCall(node, funcName, params, ctx);
      if (closureCall) return closureCall;
      return `/* TODO: ${node.type}${loc(node)} */ ${stubAbortExpr(`${node.type}${loc(node)}`)}`;
    }

    default:
      return `/* TODO: ${node.type}${loc(node)} */ ${stubAbortExpr(`${node.type}${loc(node)}`)}`;
  }
}

// Resolve a field's type info from a MemberExpression chain (walks parent classes)
// Best-effort check for "this expression is typed const char*" — used only to decide
// whether `a + b` means string concatenation (needs strConcat2) or numeric addition.
// Deliberately conservative: false negatives just mean a string-concat call site falls
// back to plain numeric `+`, never a false positive that wrongly routes a numeric
// addition through strConcat2.
function isCharPtrExpr(node, params, ctx) {
  if (!node) return false;
  if (node.type === 'StringLiteral') return true;
  if (node.type === 'Identifier') {
    const p = params?.find((pp) => pp.name === node.name);
    if (p?.type === 'const char*') return true;
    if (stringConstNames.has(node.name)) return true;
    return !!ctx?.charPtrLocals?.has(node.name);
  }
  if (node.type === 'MemberExpression') {
    return resolveFieldInfo(node, ctx)?.type === 'const char*';
  }
  // `x.substring(...)`/`readFileSync(...)`/a known free function returning
  // `const char*`, used directly inline (e.g. `line.substring(7, 9) === '04'`) rather
  // than stored in an intermediate local first — the intermediate-local case is
  // covered by ctx.charPtrLocals instead, since by the time it's referenced again
  // this node-shape info is long gone.
  if (node.type === 'CallExpression') {
    if (node.callee?.type === 'MemberExpression' && node.callee.property?.name === 'substring')
      return true;
    if (node.callee?.type === 'Identifier') {
      if (node.callee.name === 'readFileSync') return true;
      const fn = freeFunctions.get(node.callee.name);
      if (fn?.retType === 'const char*') return true;
    }
  }
  return false;
}

function resolveFieldInfo(node, ctx) {
  if (!node || (node.type !== 'MemberExpression' && node.type !== 'OptionalMemberExpression'))
    return null;
  // Resolve the object's class
  let className = null;
  if (node.object?.type === 'ThisExpression') className = ctx.className;
  else if (node.object?.type === 'Identifier') {
    className = ctx.varTypes?.[node.object.name];
    // Normalize the generic `ChipType` parameter name to its resolved concrete type,
    // exactly as resolveExprType's own wrapper does (see there). Without this, a field
    // read off a ChipType-typed PARAMETER (`constructor(rp2040: ChipType, ...)`, whose
    // varTypes entry is the literal string "ChipType") never matched `classes.get(...)`
    // below, so the whole lookup returned null and every consumer fell back to its own
    // default. Same bug class already fixed once for load-firmware.ts's
    // `chip.identifier`, which reached its field type through a different path.
    if (className === 'ChipType') className = currentChipTypeOverride || 'RP2350';
  }
  // Handle this.base.rp2040 pattern
  else if (node.object?.type === 'MemberExpression' && node.object.property?.name === 'base') {
    if (node.object.object?.type === 'ThisExpression' && ctx.className) {
      const cls = classes.get(ctx.className);
      className = cls?.parent;
    }
  }
  // General chained field access (`this.otp.fuse`, `localVar.field.other`, ...) — the
  // narrower cases above only resolve the OBJECT'S class for a direct `this.x`/`x`/
  // `this.base.x`; anything deeper (an arbitrary MemberExpression object) falls
  // through to the generic type resolver, which already knows how to walk one more
  // level of field lookup on the CURRENT class.
  if (!className) className = resolveExprType(node.object, ctx);
  if (!className) return null;

  const propName = node.property?.name;
  if (!propName) return null;

  // Walk parent chain
  let cls = classes.get(className);
  while (cls) {
    const field = cls.fields?.get(propName);
    if (field) return field;
    cls = cls.parent ? classes.get(cls.parent) : null;
  }
  return null;
}

// `this.onWatchdogTrigger(...)` / `obj.onEndpointWrite?.(...)` — a call whose callee
// resolves to a closure-kind field (see buildClosureFieldInfo) rather than a real
// method. Dispatches through the field's `_fn`/`_ctx` pair, null-safe regardless of
// whether the source used `?.()` — a real method call syntax on a field that just
// happens to never have been assigned (e.g. usb.ts's optional onXxx hooks, never set
// anywhere reachable in the transpiled build) needs the exact same guard. Returns
// null (not a stub) when the callee isn't a closure-field call at all, so callers can
// fall through to their own existing stub/dispatch logic unchanged.
function tryClosureFieldCall(node, funcName, params, ctx) {
  const callee = node.callee;
  if (
    !callee ||
    (callee.type !== 'MemberExpression' && callee.type !== 'OptionalMemberExpression') ||
    callee.computed
  )
    return null;
  const field = resolveFieldInfo(callee, ctx);
  if (field?.kind !== 'closure') return null;
  const receiverStr =
    callee.object.type === 'ThisExpression'
      ? 'self'
      : emitExpr(callee.object, funcName, params, ctx);
  const args = node.arguments.map((a, i) =>
    castStubForType(emitExpr(a, funcName, params, ctx), field.paramTypes?.[i])
  );
  const allArgs = [`(${receiverStr})->${field.ctxField}`, ...args].join(', ');
  const voidSafe = field.retType === 'void' ? '(void)0' : '0';
  return `((${receiverStr})->${field.fnField} ? (${receiverStr})->${field.fnField}(${allArgs}) : ${voidSafe})`;
}

// Behavioral interfaces are emitted as a `{ void* obj; const VTable* vtable; }` fat-pointer
// struct, not a plain C pointer — truthiness checks (`if (x)`, `x && ...`, `x ? a : b`) need
// `x.obj` instead of the bare struct value (which isn't a scalar gcc can test).
function emitCondExpr(node, funcName, params, ctx) {
  // `boolCtx` tells the LogicalExpression case it may keep C's cheap boolean `&&`/`||`
  // instead of the operand-preserving ternary a value position needs (see there).
  const str = emitExpr(node, funcName, params, ctx, { boolCtx: true });
  const t = resolveExprType(node, ctx);
  if (t && interfaces.has(t)) return `(${str}).obj`;
  return str;
}

// Find the first `varName = <expr>` reassignment anywhere in `node` (recursing through
// the whole subtree — if/while/for/switch bodies, nested blocks, everything) and resolve
// its type. Used to backfill a type for `let x = null;`, which carries none of its own.
function findReassignmentType(varName, node, ctx) {
  if (!node || typeof node !== 'object') return null;
  if (Array.isArray(node)) {
    for (const n of node) {
      const t = findReassignmentType(varName, n, ctx);
      if (t) return t;
    }
    return null;
  }
  // Stop at a nested function boundary, like every other walker in this file does: an
  // assignment to a same-named variable inside an unrelated nested function/arrow says
  // nothing about the type of the OUTER `let x = null;` being inferred here.
  if (
    node.type === 'FunctionDeclaration' ||
    node.type === 'FunctionExpression' ||
    node.type === 'ArrowFunctionExpression'
  )
    return null;
  if (
    node.type === 'AssignmentExpression' &&
    node.operator === '=' &&
    node.left?.type === 'Identifier' &&
    node.left.name === varName
  ) {
    const t = resolveExprType(node.right, ctx);
    if (t) return t;
  }
  for (const key in node) {
    if (key === 'loc' || key === 'start' || key === 'end' || key === 'range' || key[0] === '_')
      continue;
    const t = findReassignmentType(varName, node[key], ctx);
    if (t) return t;
  }
  return null;
}

// Wrapper: normalize the generic `ChipType` parameter name to its resolved concrete
// type (RP2350) at every exit path, not just the ones that happen to check for it —
// previously only the Identifier branch did this, so e.g. a field typed `ChipType`
// (`protected rp2040: ChipType`) resolved via the this.field branch would leak the bare
// "ChipType" name to callers, which never matches `classes.has(...)`.
function resolveExprType(node, ctx) {
  const t = resolveExprTypeImpl(node, ctx);
  return t === 'ChipType' ? currentChipTypeOverride || 'RP2350' : t;
}

function resolveExprTypeImpl(node, ctx) {
  if (!ctx) return null;
  if (node.type === 'ThisExpression') return ctx.className;
  // expr! (non-null assertion) — purely a type-narrowing hint (matches emitExpr's
  // TSNonNullExpression case); without this, `foo!.bar` couldn't resolve `foo`'s
  // type at all (no case matched), silently defaulting the whole chain to int32_t.
  if (node.type === 'TSNonNullExpression') return resolveExprType(node.expression, ctx);
  // `expr as unknown as ClassName` → resolve to ClassName
  if (node.type === 'TSAsExpression') {
    const castType =
      node.typeAnnotation?.typeName?.name ?? node.typeAnnotation?.typeAnnotation?.typeName?.name;
    if (castType && (classes.has(castType) || interfaces.has(castType))) return castType;
    // Nested: `as unknown as X` → X is the outer cast's typeAnnotation
    if (node.expression?.type === 'TSAsExpression') {
      const innerCast =
        node.expression.typeAnnotation?.typeName?.name ??
        node.expression.typeAnnotation?.typeAnnotation?.typeName?.name;
      if (innerCast && (classes.has(innerCast) || interfaces.has(innerCast))) return innerCast;
    }
    return resolveExprType(node.expression, ctx);
  }
  if (node.type === 'Identifier') {
    let t = ctx.varTypes?.[node.name];
    if (t === 'ChipType') t = currentChipTypeOverride || 'RP2350'; // resolve generic param to concrete
    return t ?? null;
  }
  // namespaceObj.freeFunction(...) → the free function's own return type (mirrors
  // the emitExpr CallExpression handling for the same shape).
  if (
    node.type === 'CallExpression' &&
    node.callee?.type === 'MemberExpression' &&
    node.callee.object?.type === 'Identifier' &&
    namespaceImports.has(node.callee.object.name)
  ) {
    const fn = freeFunctions.get(node.callee.property?.name);
    if (fn?.retType?.endsWith('*') && !fn.retType.includes(' ')) return fn.retType.slice(0, -1);
    if (fn?.retType && interfaces.has(fn.retType)) return fn.retType;
  }
  // new ClassName() → ClassName
  if (node.type === 'NewExpression') {
    const ctor = node.callee?.name;
    if (ctor && classes.has(ctor)) return ctor;
    return null;
  }
  // ClassName_new(...) → ClassName
  if (node.type === 'CallExpression' && node.callee?.type === 'Identifier') {
    const calleeName = node.callee.name;
    if (calleeName.endsWith('_new')) {
      const cls = calleeName.slice(0, -4);
      if (classes.has(cls)) return cls;
    }
  }
  // Shared by both method-call branches below: given a class's method-return C type
  // string, resolve it to a TS-ish type name resolveExprType can hand back — a class
  // pointer (stripped), or a behavioral interface's bare (non-pointer) fat-pointer
  // struct name, e.g. `Peripheral`.
  const methodReturnTypeName = (rt) => {
    if (rt.endsWith('*') && !rt.includes(' ')) {
      const base = rt.slice(0, -1);
      if (classes.has(base)) return base;
    }
    if (!rt.includes(' ') && !rt.endsWith('*') && interfaces.has(rt)) return rt;
    return null;
  };
  // this.method() → resolve method return type
  if (
    node.type === 'CallExpression' &&
    node.callee?.type === 'MemberExpression' &&
    node.callee.object?.type === 'ThisExpression' &&
    ctx.className
  ) {
    const mname = node.callee.property.name;
    let cls = classes.get(ctx.className);
    while (cls) {
      const msig = cls.methods?.get(mname);
      if (msig) return methodReturnTypeName(msig.retType);
      cls = cls.parent ? classes.get(cls.parent) : null;
    }
  }
  // obj.method() where obj is ANY expression resolving to a known class (a typed local
  // var/param, `this.field.method()`, etc.) — same idea as the this.method() branch
  // above, generalized. Covers e.g. `core.ppb()` where `core: CortexM33Core` is a plain
  // function parameter, not `this`.
  if (
    node.type === 'CallExpression' &&
    node.callee?.type === 'MemberExpression' &&
    node.callee.object?.type !== 'ThisExpression'
  ) {
    const objType = resolveExprType(node.callee.object, ctx);
    if (objType && classes.has(objType)) {
      const mname = node.callee.property.name;
      let cls = classes.get(objType);
      while (cls) {
        const msig = cls.methods?.get(mname);
        if (msig) return methodReturnTypeName(msig.retType);
        cls = cls.parent ? classes.get(cls.parent) : null;
      }
    }
  }
  // this.field where field is a class pointer (including inherited)
  if (node.type === 'MemberExpression') {
    // Computed access: this.field[index] → resolve field type, strip pointer
    if (node.computed) {
      const elemType = resolveExprType(node.object, ctx);
      if (elemType) {
        // For T* arrays, indexing returns T* → strip to T for var inference
        if (elemType.endsWith('*') && !elemType.includes(' ')) return elemType.slice(0, -1);
        return elemType;
      }
    }
    if (node.object?.type === 'ThisExpression' && ctx.className) {
      // Walk own + parent chain to find the field
      let cls = classes.get(ctx.className);
      while (cls) {
        const field = cls.fields?.get(node.property?.name);
        if (field) {
          if (field.tsType) return field.tsType;
          // Array-shaped fields (T*) denote a collection, not a pointer-to-one-T — bare
          // (non-computed) access to the field itself shouldn't resolve to the element type.
          if (field.isArray)
            return field.type.endsWith('**') ? field.type.slice(0, -1) : field.type; // Foo** (class-pointer array) needs one strip to reach the per-element Foo*, which the computed-access consumer above strips again to bare Foo; Foo* (interface/value array) is already the per-element shape and needs no extra strip here.
          const t = field.type;
          if (t.endsWith('*')) return t.slice(0, -1);
          if (interfaces.has(t)) return t;
          break;
        }
        cls = cls.parent ? classes.get(cls.parent) : null;
      }
    }
    // obj.field where obj is a known class param (including inherited)
    if (node.object?.type === 'Identifier') {
      const objType = ctx.varTypes?.[node.object.name];
      if (objType && classes.has(objType)) {
        let cls = classes.get(objType);
        while (cls) {
          const field = cls.fields?.get(node.property?.name);
          if (field) {
            if (field.tsType) return field.tsType;
            if (field.isArray)
              return field.type.endsWith('**') ? field.type.slice(0, -1) : field.type; // Foo** (class-pointer array) needs one strip to reach the per-element Foo*, which the computed-access consumer above strips again to bare Foo; Foo* (interface/value array) is already the per-element shape and needs no extra strip here.
            const t = field.type;
            if (t.endsWith('*')) return t.slice(0, -1);
            if (interfaces.has(t)) return t;
            break;
          }
          cls = cls.parent ? classes.get(cls.parent) : null;
        }
      }
    }
    // this.base.field → resolve base type then walk parent fields
    if (
      node.object?.type === 'MemberExpression' &&
      node.object.object?.type === 'ThisExpression' &&
      node.object.property?.name === 'base' &&
      ctx.className
    ) {
      const cls = classes.get(ctx.className);
      if (cls?.parent) {
        let parentCls = classes.get(cls.parent);
        while (parentCls) {
          const field = parentCls.fields?.get(node.property?.name);
          if (field) {
            if (field.tsType) return field.tsType;
            if (field.isArray)
              return field.type.endsWith('**') ? field.type.slice(0, -1) : field.type; // Foo** (class-pointer array) needs one strip to reach the per-element Foo*, which the computed-access consumer above strips again to bare Foo; Foo* (interface/value array) is already the per-element shape and needs no extra strip here.
            const t = field.type;
            if (t.endsWith('*')) return t.slice(0, -1);
            if (interfaces.has(t)) return t;
            break;
          }
          parentCls = parentCls.parent ? classes.get(parentCls.parent) : null;
        }
      }
    }
    // General fallback: obj.field where obj is ANY expression (not just `this` or a
    // plain local identifier) that resolves to a known class — covers chained access
    // through an intermediate field, e.g. `this.rp2040.core` (rp2040 is itself a
    // class-typed field on `this`), `someFn().field`, `arr[i].field`, etc. Deliberately
    // last: the more specific branches above are cheaper and already well-tested for
    // their exact shapes.
    if (node.object && !node.computed) {
      const objType = resolveExprType(node.object, ctx);
      if (objType && classes.has(objType)) {
        let cls = classes.get(objType);
        while (cls) {
          const field = cls.fields?.get(node.property?.name);
          if (field) {
            if (field.tsType) return field.tsType;
            if (field.isArray)
              return field.type.endsWith('**') ? field.type.slice(0, -1) : field.type;
            const t = field.type;
            if (t.endsWith('*')) return t.slice(0, -1);
            if (interfaces.has(t)) return t;
            break;
          }
          cls = cls.parent ? classes.get(cls.parent) : null;
        }
      }
    }
  }
  return null;
}

function collectParams(paramNodes, opts = {}) {
  return paramNodes
    .filter((p) => p.type === 'Identifier' || p.type === 'AssignmentPattern')
    .map((p) => {
      const name = p.type === 'Identifier' ? p.name : p.left.name;
      const anno = p.type === 'Identifier' ? p.typeAnnotation : p.left.typeAnnotation;
      return { name, type: cTypeOf(anno, opts), tsType: anno?.typeAnnotation?.typeName?.name };
    });
}

const MAX_INLINE_ARRAY_ELEMS = 4096;
function markInlineArrays() {
  for (const info of classes.values()) {
    for (const finfo of info.fields.values()) {
      if ((!finfo.isArray && !finfo.isTypedArray) || finfo.isGrowableArray) continue;
      // Reassignment would need the allocation rewritten as a zero-fill; readonly rules it
      // out, and tsc enforces that.
      if (finfo.isTypedArray && !finfo.isReadonly) continue;
      if (finfo.kind === 'closure' || typeof finfo.type !== 'string') continue;
      if (!finfo.type.endsWith('*')) continue;
      const size =
        typeof finfo.size === 'number'
          ? finfo.size
          : finfo.sizeNode?.type === 'NumericLiteral'
          ? finfo.sizeNode.value
          : undefined;
      if (!Number.isInteger(size) || size <= 0 || size > MAX_INLINE_ARRAY_ELEMS) continue;
      finfo.inlineArray = size;
    }
  }
}

// Emit all collected enums
function emitAllEnums(out) {
  out.push('// ─── Enum definitions ───');
  for (const [name, members] of enums) {
    out.push(`typedef enum {`);
    for (const [member, value] of members) {
      out.push(`  ${name}_${member} = ${value},`);
    }
    out.push(`} ${name};`);
    out.push('');
  }
  // Emitted here because it takes enum parameters: a real function-pointer typedef, so
  // callbacks stored in a GPIOPinListener[] field can be called rather than being void*.
  out.push('typedef void (*GPIOPinListener)(GPIOPinState, GPIOPinState);');
  out.push('');
}

// A concrete class instance (`this`, `new Foo()`, a class-typed local var, ...) passed
// where a behavioral interface is expected (e.g. `createAlarm(callback: AlarmCallback)`
// called as `createAlarm(this)`) needs boxing into that interface's `{ obj, vtable }`
// fat pointer — the C function only ever sees the interface type, never the concrete
// class pointer. Without this, every such call site is a real class-pointer argument
// where an interface struct is expected (a genuine gcc type error, not a TODO stub).
//
// Separately: a ChipType-generic CLASS (as opposed to a free function — see "ChipType
// monomorphization" above) always has its ChipType parameter hardcoded to concrete
// RP2350 (a class isn't instantiated polymorphically the way a free function call site
// can be). Several peripherals (RPADC, RPUART,
// ...) are constructed by BOTH RP2040 and RP2350, so `new RPADC(this, ...)` from
// RP2040's own constructor passes an `RP2040*` where the generated C expects `RP2350*`
// — a real pointer-type mismatch, invisible until this class's field actually gets
// constructed for real (see the "Class field initializers" fix). Rather than leaking
// this transpile-time-only concern into hand-written TS (e.g. `this as unknown as
// RP2350` in rp2040.ts), insert the pointer cast in the generated C directly: it's
// exactly as safe as the hardcoded-to-RP2350 convention already assumes everywhere
// else, just made explicit at the one call site that actually mixes concrete types.
function wrapArgIfInterfaceParam(argStr, argNode, paramType, ctx, funcName, params) {
  if (!paramType || !argNode) return argStr;
  // An inline object literal (`createSetupPacket({ dataDirection: ..., ... })`) passed
  // where a pure-data interface's promoted-to-synthetic-class type is expected —
  // emitExpr's ObjectExpression case always TODO-stubs to a bare 0 (it has no target
  // type of its own to build a struct against), discarding `argStr` entirely here in
  // favor of a real C99 compound literal built directly from this call site's known
  // target class and its declared field names.
  if (argNode.type === 'ObjectExpression' && paramType.endsWith('*') && !paramType.includes(' ')) {
    const paramClass = paramType.slice(0, -1);
    const cls = classes.get(paramClass);
    if (cls) {
      const inits = argNode.properties
        .filter(
          (p) =>
            p.type === 'ObjectProperty' &&
            (p.key?.name || p.key?.value) &&
            cls.fields.has(p.key.name ?? p.key.value)
        )
        .map((p) => {
          const propName = p.key.name ?? p.key.value;
          const fieldType = cls.fields.get(propName)?.type;
          // `Array.from({ length: N }, (v, i) => ({ ...struct fields... }))` assigned
          // into a field typed as an array of struct pointers (`T**`) — the same
          // "construct N instances" shape emitFieldInitializers already supports for
          // the `Array(N).fill().map(() => new T(...))` idiom, just via Array.from's
          // `{length}`-object + arrow-returning-a-PLAIN-OBJECT-LITERAL spelling instead
          // of `new T(...)` (used by M33CoreState's mpuRegions/sauRegions, whose
          // elements are plain data structs promoted to a synthetic class by
          // normalizePureDataInterfaces, not `new`-constructed instances). Wrapped in a
          // GNU statement expression (same established precedent as push()/`??=`
          // elsewhere in this file) so the whole thing stays a single value-producing
          // expression fitting into this same `.field = <expr>` init-list slot.
          if (
            p.value.type === 'CallExpression' &&
            p.value.callee?.type === 'MemberExpression' &&
            p.value.callee.object?.type === 'Identifier' &&
            p.value.callee.object.name === 'Array' &&
            !p.value.callee.computed &&
            p.value.callee.property?.name === 'from' &&
            fieldType?.endsWith('**')
          ) {
            const lenArg = p.value.arguments[0];
            const mapFn = p.value.arguments[1];
            const lenProp =
              lenArg?.type === 'ObjectExpression'
                ? lenArg.properties.find(
                    (pp) => pp.type === 'ObjectProperty' && pp.key?.name === 'length'
                  )
                : null;
            const elemType = fieldType.slice(0, -2);
            const elemCls = classes.get(elemType);
            if (
              lenProp &&
              mapFn?.type === 'ArrowFunctionExpression' &&
              mapFn.body?.type === 'ObjectExpression' &&
              elemCls
            ) {
              const n = emitExpr(lenProp.value, funcName, params, ctx);
              const idxName = cName(mapFn.params[1]?.name ?? '__af_i');
              const elemInits = mapFn.body.properties
                .filter(
                  (ep) =>
                    ep.type === 'ObjectProperty' &&
                    (ep.key?.name || ep.key?.value) &&
                    elemCls.fields.has(ep.key.name ?? ep.key.value)
                )
                .map(
                  (ep) =>
                    `.${cName(ep.key.name ?? ep.key.value)} = ${emitExpr(
                      ep.value,
                      funcName,
                      params,
                      ctx
                    )}`
                );
              return (
                `.${cName(propName)} = (__extension__({ ` +
                `${elemType}** __af_arr = calloc(${n}, sizeof(${elemType}*)); ` +
                `for (int32_t ${idxName} = 0; ${idxName} < ${n}; ${idxName}++) { ` +
                `__af_arr[${idxName}] = memcpy(malloc(sizeof(${elemType})), &(${elemType}){ ${elemInits.join(
                  ', '
                )} }, sizeof(${elemType})); ` +
                `} __af_arr; }))`
              );
            }
          }
          return `.${cName(propName)} = ${emitExpr(p.value, funcName, params, ctx)}`;
        });
      // Heap-allocated, not `&(Type){...}` (a stack compound literal): a C99 compound
      // literal's lifetime is only the enclosing block, which is fine when this value
      // is used as a same-statement call argument, but this same construction site
      // also covers `return { ...struct fields... };` (an object-literal return where
      // the target type is a promoted pure-data interface) — there the pointer
      // escapes the block, and the caller would read a dead stack frame.
      // insurance against a call site silently outliving the stack version.
      // TODO: leaks the allocated struct — no ownership/lifetime tracking yet.
      return `memcpy(malloc(sizeof(${paramClass})), &(${paramClass}){ ${inits.join(
        ', '
      )} }, sizeof(${paramClass}))`;
    }
  }
  if (interfaces.has(paramType)) {
    const argType = resolveExprType(argNode, ctx);
    if (argType && classes.has(argType) && getImplementedInterfaces(argType).has(paramType)) {
      return `(${paramType}){ .obj = (void*)(${argStr}), .vtable = &${getVTableName(
        argType,
        paramType
      )} }`;
    }
    return argStr;
  }
  if (paramType.endsWith('*') && !paramType.includes(' ')) {
    const paramClass = paramType.slice(0, -1);
    if (classes.has(paramClass)) {
      const argType = resolveExprType(argNode, ctx);
      if (argType && classes.has(argType) && argType !== paramClass) {
        return `(${paramType})(${argStr})`;
      }
    }
  }
  return argStr;
}

// ─── Vtable generation ──────────────────────────────────────────────

// Collect all interfaces a class implements (including inherited)
function getImplementedInterfaces(className) {
  const cls = classes.get(className);
  if (!cls) return new Set();
  const result = new Set(cls.implements);
  // Walk parent chain
  if (cls.parent && classes.has(cls.parent)) {
    for (const i of getImplementedInterfaces(cls.parent)) result.add(i);
  }
  return result;
}

// Find which class defines a method (for vtable resolution)
function findMethodDefiningClass(className, methodName) {
  const cls = classes.get(className);
  if (!cls) return null;
  if (cls.methods.has(methodName)) return className;
  if (cls.parent && classes.has(cls.parent)) return findMethodDefiningClass(cls.parent, methodName);
  return null;
}

function findGetterDefiningClass(className, propName) {
  const cls = classes.get(className);
  if (!cls) return null;
  if (cls.getters?.has(propName)) return className;
  if (cls.parent && classes.has(cls.parent)) return findGetterDefiningClass(cls.parent, propName);
  return null;
}

function findSetterDefiningClass(className, propName) {
  const cls = classes.get(className);
  if (!cls) return null;
  if (cls.setters?.has(propName)) return className;
  if (cls.parent && classes.has(cls.parent)) return findSetterDefiningClass(cls.parent, propName);
  return null;
}

// Builds the `self`-relative expression to pass as a getter's/setter's own `self`
// argument when the accessor is defined on an ANCESTOR of `className` (not
// `className` itself) — same "&self->base" chain as inherited method calls, just
// walked however many levels deep the defining class actually is (a class embeds its
// direct parent as `base`, which itself embeds ITS parent as `base.base`, etc.).
function selfPathTo(selfExpr, className, definingClass) {
  if (className === definingClass) return selfExpr;
  let path = selfExpr;
  let curName = className;
  while (curName && curName !== definingClass) {
    path = `&(${path})->base`;
    curName = classes.get(curName)?.parent ?? null;
  }
  return path;
}

function emitInterfaceVTables(out) {
  out.push('// ─── Interface vtable typedefs ───');
  for (const [ifaceName, methods] of interfaces) {
    // Forward-declare the fat-pointer typedef itself before the vtable struct that
    // references it — needed when a method takes the interface's OWN type as a
    // parameter (e.g. ICpuCore.setOtherCore(other: ICpuCore)): without this, the
    // vtable struct (emitted first, below) referenced `ICpuCore` as a function-
    // pointer parameter type before its own `typedef struct ICpuCore {...} ICpuCore;`
    // existed — an "unknown type name" compile error.
    out.push(`typedef struct ${ifaceName} ${ifaceName};`);
    // Emit vtable struct
    out.push(`typedef struct ${ifaceName}VTable {`);
    for (const [mname, msig] of methods) {
      if (msig.isProperty) continue; // skip property signatures for now
      const paramTypes = msig.params.map((p) => p.type).join(', ');
      // First param is always void* self
      out.push(`  ${msig.retType} (*${mname})(void* self${paramTypes ? ', ' + paramTypes : ''});`);
    }
    out.push(`} ${ifaceName}VTable;`);

    // Fat pointer: { void* obj; const VTable* vtable; }
    out.push(`typedef struct ${ifaceName} {`);
    out.push(`  void* obj;`);
    out.push(`  const ${ifaceName}VTable* vtable;`);
    out.push(`} ${ifaceName};`);
    out.push('');

    // Helper macro for virtual dispatch
    out.push(`// ${ifaceName} virtual dispatch helpers`);
    for (const [mname, msig] of methods) {
      if (msig.isProperty) continue;
      const paramDecls = msig.params.map((p) => `${p.type} ${cName(p.name)}`).join(', ');
      // cName() on BOTH sides: the declaration escaped a C-keyword parameter name (`int` ->
      // `int_`) while the forwarded argument kept the raw one, so such a parameter would
      // reference an undeclared identifier. No interface method in this codebase currently
      // has a C-keyword parameter name, so this is latent.
      const paramNames = msig.params.map((p) => cName(p.name)).join(', ');
      out.push(
        `static inline ${msig.retType} ${ifaceName}_${mname}(${ifaceName} p${
          paramDecls ? ', ' + paramDecls : ''
        }) {`
      );
      out.push(`  return p.vtable->${mname}(p.obj${paramNames ? ', ' + paramNames : ''});`);
      out.push(`}`);
    }
    out.push('');
  }
}

function emitStructForwardDecls(out) {
  out.push('// ─── Struct forward declarations ───');
  for (const className of classes.keys()) {
    out.push(`typedef struct ${className} ${className};`);
  }
  out.push('');
  // Closure-field function-pointer typedefs (see buildClosureFieldInfo) — emitted
  // after every struct's own forward typedef above, since a param type here can
  // itself be a class pointer.
  out.push('// ─── Closure field typedefs ───');
  for (const cls of classes.values()) {
    for (const finfo of cls.fields.values()) {
      if (finfo.kind !== 'closure') continue;
      const params = ['void*', ...finfo.paramTypes].join(', ');
      out.push(`typedef ${finfo.retType} (*${finfo.fnTypeName})(${params});`);
    }
  }
  out.push('');
}

function emitClassVTableForwardDecls(out) {
  out.push('// ─── Method forward declarations ───');
  for (const [className, cls] of classes) {
    for (const [mname, msig] of cls.methods) {
      if (msig.isConstructor) {
        out.push(
          `static ${className}* ${className}_new(${msig.params
            .map((p) => `${p.type} ${cName(p.name)}`)
            .join(', ')});`
        );
      } else {
        out.push(
          `static ${msig.retType} ${className}_${mname}(${className}* self${
            msig.params.length
              ? ', ' + msig.params.map((p) => `${p.type} ${cName(p.name)}`).join(', ')
              : ''
          });`
        );
      }
    }
    for (const [pname, sig] of cls.getters ?? []) {
      out.push(`static ${sig.retType} ${className}_${pname}_get(${className}* self);`);
    }
    for (const [pname, sig] of cls.setters ?? []) {
      out.push(
        `static void ${className}_${pname}_set(${className}* self, ${sig.paramType} value);`
      );
    }
  }
  // Free functions. Type collection (Pass 0/1) always scans every .ts file under
  // src/ regardless of which files this mode actually emits (see main()'s "Pass 0"
  // comment) — a source file elsewhere in the tree (even one excluded from this
  // mode, e.g. rp2-emu-cli's CLI entry point) happening to declare its own top-level
  // `main` would otherwise get a real prototype here, conflicting with a C harness's
  // actual `int main(int, char**)`. `main` is never a legitimate call target for
  // transpiled code either way (it's the process entry point), so skip it outright.
  for (const [name, fn] of freeFunctions) {
    if (name === 'main') continue;
    out.push(
      `static ${fn.retType} ${name}(${
        fn.params.map((p) => `${p.type} ${cName(p.name)}`).join(', ') || 'void'
      });`
    );
  }
  // Arrow functions (static inline)
  for (const [name, fn] of arrowFunctions) {
    out.push(
      `static inline ${fn.retType} ${name}(${
        fn.params.map((p) => `${p.type} ${cName(p.name)}`).join(', ') || 'void'
      });`
    );
  }
  out.push('');
}

function emitClassVTableInstances(out) {
  for (const [className, cls] of classes) {
    const implIfaces = getImplementedInterfaces(className);
    if (implIfaces.size === 0) continue;

    for (const ifaceName of implIfaces) {
      const ifaceMethods = interfaces.get(ifaceName);
      if (!ifaceMethods) continue;

      out.push(`static const ${ifaceName}VTable ${className}_${ifaceName}_vtable = {`);
      const declLoc = cls.declSite
        ? ` [${cls.declSite}: ${className} implements ${ifaceName}]`
        : '';
      for (const [mname, msig] of ifaceMethods) {
        if (msig.isProperty) {
          out.push(`  /* TODO: .${mname} =${declLoc} */ NULL,`);
          continue;
        }
        const definingClass = findMethodDefiningClass(className, mname);
        if (definingClass) {
          out.push(`  .${mname} = (void*)${definingClass}_${mname},`);
        } else {
          out.push(`  .${mname} = NULL, /* TODO: not implemented${declLoc} */`);
        }
      }
      out.push(`};`);
      out.push('');
    }
  }
}

// Get the vtable instance name for a class/interface pair
function getVTableName(className, ifaceName) {
  return `${className}_${ifaceName}_vtable`;
}

function emitAllStructDefs(out) {
  out.push('// ─── Struct definitions ───');
  // Topological sort: parent structs before children
  const emitted = new Set();
  const emitCls = (name) => {
    if (emitted.has(name)) return;
    const info = classes.get(name);
    if (!info) return;
    if (info.parent && classes.has(info.parent) && !emitted.has(info.parent)) {
      emitCls(info.parent);
    }
    out.push(`struct ${name} {`);
    if (info.parent && classes.has(info.parent)) {
      out.push(`  ${info.parent} base; // parent class (must be first member)`);
    }
    for (const [fname, finfo] of info.fields) {
      // A property with a real getter is NEVER read via a plain struct-field access —
      // emitExpr's `this.prop`/`obj.prop` MemberExpression case checks
      // findGetterDefiningClass BEFORE falling back to a field read, and unconditionally
      // routes through `ClassName_prop_get(...)` whenever a match exists, with no
      // fallback path that would ever touch `self->prop` directly. (Whether or not a
      // setter also exists doesn't change this — a setter-backed WRITE is intercepted
      // the same way, before it ever reaches a plain field assignment.) The struct still
      // needs a `fields` map entry for this property (other code resolves its type
      // through that map — see resolveFieldInfo/resolveExprType), but a corresponding
      // STRUCT MEMBER is pure dead weight: never initialized, never read, never written.
      // Skipping its own AST 'fields' entry keeps the struct honest about what's
      // actually used — a getter-only property's dummy field is real but unused
      // storage, easy to reach for by accident from outside cts2c's own generated
      // call sites (a compile error there is sharper and safer than silently reading
      // an always-NULL dummy member).
      // A setter-ONLY property (no getter) is different: an unguarded READ of it falls
      // through to a plain field read (see the MemberExpression case) since there's no
      // getter to intercept it, so its struct member is still load-bearing and stays.
      if (info.getters.has(fname)) continue;
      if (finfo.kind === 'closure') {
        out.push(`  ${finfo.fnTypeName} ${finfo.fnField};`);
        out.push(`  void* ${finfo.ctxField};`);
        continue;
      }
      if (finfo.inlineArray) {
        const align = finfo.isTypedArray ? '__attribute__((aligned(8))) ' : '';
        out.push(`  ${align}${finfo.type.slice(0, -1)} ${cName(fname)}[${finfo.inlineArray}];`);
      } else {
        out.push(`  ${finfo.type} ${cName(fname)};`);
      }
      if (finfo.isGrowableArray) out.push(`  int32_t ${cName(fname)}_count;`);
    }
    out.push(`};`);
    out.push('');
    emitted.add(name);
  };
  for (const name of classes.keys()) emitCls(name);
}

// Emit only implementations (structs and decls already emitted globally)
function transpileFileImpls(filepath, out) {
  const src = readSourceFile(filepath);
  const ast = parser.parse(src, {
    sourceType: 'module',
    plugins: ['typescript'],
    ranges: false,
    loc: true,
  });

  currentFile = path.relative(process.cwd(), filepath);
  currentSrcLines = src.split('\n');
  currentFileConstRenames = new Map();

  for (const node of ast.program.body) {
    emitImpl(node, out);
  }
}
function main() {
  let files = process.argv.slice(2);
  if (files.length === 0) {
    console.error('Usage: cts2c.js <file1.ts> [file2.ts ...] [-o output.c] [--shadow-dir dir]');
    process.exit(1);
  }

  const shadowDirIdx = files.indexOf('--shadow-dir');
  if (shadowDirIdx !== -1) {
    shadowDir = files[shadowDirIdx + 1];
    files = files.filter((_, i) => i !== shadowDirIdx && i !== shadowDirIdx + 1);
  }

  const outFileIdx = files.indexOf('-o');
  let outFile = '/dev/stdout';
  let inputFiles = files;
  if (outFileIdx !== -1) {
    outFile = files[outFileIdx + 1];
    inputFiles = files.filter((_, i) => i !== outFileIdx && i !== outFileIdx + 1);
  }

  // Pass 0: collect types from ALL .ts files in src/ (for type resolution)
  const allTsFiles = [];
  function findTsFiles(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      // Match test directories by NAME, not by substring: `includes('test')` would also
      // exclude an ordinary directory called `latest/`, `protest/` or `test_utils/`.
      if (entry.isDirectory() && !/^(test|tests|__tests__|node_modules)$/.test(entry.name)) {
        findTsFiles(full);
      } else if (
        entry.name.endsWith('.ts') &&
        !entry.name.endsWith('.spec.ts') &&
        !entry.name.endsWith('.d.ts')
      ) {
        allTsFiles.push(full);
      }
    }
  }
  // Find the nearest ancestor directory literally named "src" (this project's convention),
  // walking up from the first input file — works for absolute or relative input paths.
  // Falls back to the input file's own directory if no "src" ancestor exists.
  function findSrcRoot(startDir) {
    let dir = path.resolve(startDir);
    while (path.basename(dir) !== 'src') {
      const parent = path.dirname(dir);
      if (parent === dir) return path.resolve(startDir); // hit filesystem root, give up
      dir = parent;
    }
    return dir;
  }
  const srcBase = findSrcRoot(path.dirname(inputFiles[0])) + '/';
  try {
    findTsFiles(srcBase);
  } catch (e) {}
  // Pass 0: pre-register all type names so forward references resolve
  for (const f of allTsFiles) preRegisterTypes(f);
  // Pass 1: collect full type info
  for (const f of allTsFiles) collectTypes(f);

  // Pass 1.4: retry getter return-type inference that failed only because it ran
  // before every class was collected (directory-traversal order, not dependency
  // order) — see resolveUnresolvedGetterTypes.
  resolveUnresolvedGetterTypes();

  markInlineArrays();

  // Pass 1.5: now that every interface is fully collected, rewrite references to
  // "pure data" interfaces (only property signatures, no methods — e.g.
  // LoadFirmwareOptions) from the bare interface name to void*. These aren't real
  // vtable-dispatch types, so passing them as a named-struct value breaks call sites
  // that pad a missing optional arg with a literal `0` (can't assign int 0 to a
  // struct); void* is compatible with both a real pointer and a bare `0`/NULL default.
  // Property access on them is already TODO-stubbed by the interface-property
  // resolution path regardless of the underlying C type, so this is purely a
  // signature/declaration fix, not a behavior change.
  normalizePureDataInterfaces();

  // Pass 1.6: a class with no own `constructor` (relying on JS/TS's implicit
  // inherited default constructor) never had a `methods.get('constructor')` entry —
  // collectTypes only ever looks at each class's OWN body. Left alone, both the
  // forward-declaration pass and emitClassImpl silently skip such classes entirely:
  // no `_new` prototype, no `_new` body — an "implicit declaration of function"
  // compile error at every call site. Climb each such class's parent chain (already
  // fully collected — every file has been through Pass 1 by now) and synthesize a
  // constructor signature/marker from the nearest ancestor that has a real one;
  // emitClassImpl checks the `inherited` marker to know to synthesize a wrapper body
  // instead of expecting a matching ClassMethod AST node.
  resolveMissingConstructors();

  // Pass 1.65: give every interface's root implementer a stored self-vtable field, so
  // `this.method()` calls from a shared ancestor method dispatch to the real most-
  // derived override instead of a static call to wherever the calling code happens to
  // be lexically defined — see assignInterfaceSelfVtableFields.
  assignInterfaceSelfVtableFields();

  // Pass 1.7: discover which ChipType-generic free-function instantiations are
  // actually needed (see "ChipType monomorphization" above) — must happen before any
  // real emission so forward declarations for the monomorphized instantiations can be
  // emitted ahead of their first use.
  discoverGenericInstantiations(inputFiles);

  // Pass 2: emit C
  const out = [];
  out.push('// Auto-generated by cts2c.js — do not edit');
  out.push('// https://github.com/c1570/rp2350js');
  out.push('#include <stdint.h>');
  out.push('#include <stdbool.h>');
  out.push('#include <stdlib.h>');
  out.push('#include <stdio.h>');
  out.push('#include <string.h>');
  out.push('#include <stdarg.h>');
  out.push('');
  out.push('// Helper functions');
  out.push('#include <math.h>');
  // `Math.imul(a, b)` is explicitly defined in JS as 32-bit-wraparound multiplication
  // (the reason it exists at all — plain `a * b` doesn't wrap until 2**53) — but
  // signed `int32_t * int32_t` overflow is UNDEFINED BEHAVIOR in C, unlike unsigned
  // multiplication overflow (well-defined modulo 2**32 per the standard). Multiplying
  // as uint32_t first and casting back afterward gets the exact same bit pattern
  // Math.imul produces, without the UB.
  out.push('#define imul32(a,b) ((int32_t)((uint32_t)(a) * (uint32_t)(b)))');
  // `Math.min`/`Math.max` as naive macros evaluate each argument TWICE — utils/timer32.ts's
  // `Math.min(distance(targetValue), distance(period - targetValue))` really did call
  // `distance` four times instead of two. Harmless there (it's a pure arrow function), but
  // a genuine miscompile waiting for the first side-effecting argument. GNU statement
  // expressions bind each argument to a temporary of its own type first, so each is
  // evaluated exactly once and mixed int/double arguments still promote as they did.
  out.push(
    '#define min(a,b) (__extension__({ __typeof__(a) __mina = (a); __typeof__(b) __minb = (b); __mina < __minb ? __mina : __minb; }))'
  );
  out.push(
    '#define max(a,b) (__extension__({ __typeof__(a) __maxa = (a); __typeof__(b) __maxb = (b); __maxa > __maxb ? __maxa : __maxb; }))'
  );
  // `Math.sign(x)` — mapped in emitExpr's Math table but never actually defined, so any
  // call would have been an implicit declaration and then a link error. Not reachable from
  // this codebase (Math.sign appears only inside a comment), defined for completeness.
  // Returns a double to keep JS's -0/NaN behavior rather than collapsing them to 0.
  out.push('static inline double sign(double x) { return x > 0 ? 1.0 : (x < 0 ? -1.0 : x); }');
  out.push('// String concatenation (`a + b` in TS/JS).');
  out.push('// TODO: leaks the allocated buffer — no ownership/lifetime tracking yet.');
  out.push('static inline char* strConcat2(const char* a, const char* b) {');
  out.push('  size_t la = strlen(a), lb = strlen(b);');
  out.push('  char* buf = malloc(la + lb + 1);');
  out.push('  memcpy(buf, a, la);');
  out.push('  memcpy(buf + la, b, lb + 1);');
  out.push('  return buf;');
  out.push('}');
  out.push('');
  out.push('// `str.substring(start, end)` — a real (null-terminated, clamped-to-length) copy,');
  out.push('// not just an offset pointer: downstream parseInt/strtoul reads to the first');
  out.push('// non-digit char, so an un-terminated view would read past the intended slice.');
  out.push('// TODO: leaks the allocated buffer — no ownership/lifetime tracking yet.');
  out.push('static inline char* strSubstring(const char* s, int32_t start, int32_t end) {');
  out.push('  size_t len = strlen(s);');
  out.push('  if (start < 0) start = 0;');
  out.push('  if ((size_t)end > len) end = (int32_t)len;');
  out.push('  if (end < start) end = start;');
  out.push('  size_t n = (size_t)(end - start);');
  out.push('  char* buf = malloc(n + 1);');
  out.push('  memcpy(buf, s + start, n);');
  out.push('  buf[n] = 0;');
  out.push('  return buf;');
  out.push('}');
  out.push('');
  out.push('// `fs.readFileSync(path[, encoding])` — call sites pass either 1 or 2 args (the');
  out.push("// encoding, when given, is always 'utf-8' text mode in this codebase and is");
  out.push('// otherwise unused here, hence the variadic signature to accept both shapes).');
  out.push('// TODO: leaks the allocated buffer — no ownership/lifetime tracking yet.');
  out.push('static char* readFileSync(const char* path, ...) {');
  out.push('  FILE* f = fopen(path, "rb");');
  out.push('  if (!f) { fprintf(stderr, "readFileSync: cannot open %s\\n", path); abort(); }');
  out.push('  fseek(f, 0, SEEK_END);');
  out.push('  long size = ftell(f);');
  out.push('  fseek(f, 0, SEEK_SET);');
  out.push('  char* buf = malloc((size_t)size + 1);');
  out.push('  size_t n = fread(buf, 1, (size_t)size, f);');
  out.push('  buf[n] = 0;');
  out.push('  fclose(f);');
  out.push('  return buf;');
  out.push('}');
  out.push('');
  out.push('// Real UF2 (github.com/microsoft/uf2) block decoder, hand-written because cts2c');
  out.push("// has no way to transpile the third-party `uf2` npm package's decodeBlock() —");
  out.push("// load-firmware.ts's loadFirmwareFromUF2 is recognized by name (see");
  out.push('// emitGenericFunctionInstantiations) and routed here instead of being');
  out.push('// transpiled; the JS/Node side still uses the real npm package, unaffected.');
  out.push('// Reads the file directly in binary via fopen/fread (not readFileSync above,');
  out.push('// which NUL-terminates its buffer — unsafe here since real UF2 payloads can and');
  out.push("// do contain genuine zero bytes, which readFileSync's callers can only ever see");
  out.push("// via strlen()). Each block's 476-byte payload is written straight into flash or");
  out.push('// sram depending on which side of ramBase its target address falls.');
  out.push(
    'static void cts2c_loadUF2(const char* path, uint8_t* flash, uint32_t flashBase, uint8_t* sram, uint32_t ramBase, bool* useSram, uint32_t* loadBase) {'
  );
  out.push('  FILE* f = fopen(path, "rb");');
  out.push('  if (!f) { fprintf(stderr, "cts2c_loadUF2: cannot open %s\\n", path); abort(); }');
  out.push('  *useSram = false;');
  out.push('  *loadBase = 0xffffffffu;');
  out.push('  uint8_t block[512];');
  out.push('  while (fread(block, 1, 512, f) == 512) {');
  out.push('    uint32_t magicStart0, magicStart1, targetAddr, payloadSize;');
  out.push('    memcpy(&magicStart0, block + 0, 4);');
  out.push('    memcpy(&magicStart1, block + 4, 4);');
  out.push('    memcpy(&targetAddr, block + 12, 4);');
  out.push('    memcpy(&payloadSize, block + 16, 4);');
  out.push('    if (magicStart0 != 0x0A324655u || magicStart1 != 0x9E5D5157u) {');
  out.push('      fprintf(stderr, "cts2c_loadUF2: bad block magic in %s\\n", path);');
  out.push('      abort();');
  out.push('    }');
  out.push(
    '    if (payloadSize > 476) payloadSize = 476; // per the UF2 spec, data is always <= 476 bytes'
  );
  out.push('    if (targetAddr >= ramBase) {');
  out.push('      memcpy(sram + (targetAddr - ramBase), block + 32, payloadSize);');
  out.push('      *useSram = true;');
  out.push('    } else {');
  out.push('      memcpy(flash + (targetAddr - flashBase), block + 32, payloadSize);');
  out.push('    }');
  out.push('    if (targetAddr < *loadBase) *loadBase = targetAddr;');
  out.push('  }');
  out.push('  fclose(f);');
  out.push('  if (*loadBase == 0xffffffffu) *loadBase = flashBase;');
  out.push('}');
  out.push('');
  out.push("// `Math.clz32(x)` is well-defined for x===0 (returns 32) in JS — GCC's");
  out.push('// __builtin_clz is explicitly UNDEFINED for a 0 argument, so this needs a');
  out.push("// zero-guard GCC's builtin doesn't provide.");
  out.push('static inline int32_t clz32(uint32_t x) { return x == 0 ? 32 : __builtin_clz(x); }');
  out.push('');
  out.push('// Backs template-literal codegen (see the `TemplateLiteral` case in emitExpr) and');
  out.push('// the logger/warn/error/debug/info method bodies below — both need a real');
  out.push('// interpolated `const char*` out of what was originally a JS template string, and');
  out.push('// C has no string interpolation of its own. A small ring of static buffers (rather');
  out.push('// than just one) lets a single fprintf/statement safely hold more than one');
  out.push('// fmtStr()-built string live at once (e.g. a log call whose own message argument');
  out.push('// was itself built by a nested fmtStr() call) without one overwriting the other.');
  out.push('static char __cts2c_fmtbuf[8][256];');
  out.push('static int __cts2c_fmtbuf_idx = 0;');
  out.push('static const char* fmtStr(const char* format, ...) {');
  out.push('  char* buf = __cts2c_fmtbuf[__cts2c_fmtbuf_idx];');
  out.push('  __cts2c_fmtbuf_idx = (__cts2c_fmtbuf_idx + 1) % 8;');
  out.push('  va_list ap;');
  out.push('  va_start(ap, format);');
  out.push('  vsnprintf(buf, sizeof(__cts2c_fmtbuf[0]), format, ap);');
  out.push('  va_end(ap);');
  out.push('  return buf;');
  out.push('}');
  out.push('');

  // Emit interface vtables and fat-pointer typedefs
  emitInterfaceVTables(out);

  // Emit ALL enums first (structs may reference enum types)
  emitAllEnums(out);

  // Emit top-level consts collected from every discovered file (see globalConstantDecls)
  if (globalConstantDecls.length) {
    out.push('// ─── Global constants (cross-file) ───');
    out.push(...globalConstantDecls);
    out.push('');
  }

  // Forward declarations of all structs (needed by method forward decls)
  emitStructForwardDecls(out);

  // Emit ALL struct definitions (topological order for embedded parents)
  emitAllStructDefs(out);

  // Forward declarations of all class methods (needed by vtables)
  emitClassVTableForwardDecls(out);

  // Emit class vtable instances right after the forward decls they need — function
  // bodies (emitted next) can reference these instances directly (e.g. boxing `this`
  // into an interface fat-pointer at a `createAlarm(this)`-style call site), so the
  // instances must exist before any function body that might use them.
  emitClassVTableInstances(out);

  // Emit all function/method implementations. RP2040/RP2350 chip variants sometimes
  // share an identical class name in two separate "$name.ts" / "$name_rp2350.ts"
  // files (e.g. sio.ts's vs sio_rp2350.ts's `class RPSIO`, with genuinely DIFFERENT
  // method bodies). A same-named method's C function body is only ever emitted
  // ONCE (see emitClassImpl's `emittedFunctions.has(fullName)` dedup) — whichever
  // file is processed FIRST wins, permanently shadowing the other's body no matter
  // which is actually correct for this always-RP2350 build (the identical "prefer
  // RP2350" reasoning already applied to field merging in collectTypes). The manifest order sorts plain alphabetically ("sio.ts" <
  // "sio_rp2350.ts"), so without this, RP2040's body always wins. Only swap an exact
  // "$name.ts"/"$name_rp2350.ts" PAIR's relative order — NOT a blanket "every
  // rp2350-named file first" sort, which reshuffles unrelated files against each
  // other too and breaks cross-file const/struct-field assumptions that happen to
  // depend on the current relative order of otherwise-unrelated files.
  const byBase = new Map(inputFiles.map((f) => [path.basename(f), f]));
  const alreadyPlaced = new Set();
  const emitOrder = [];
  for (const f of inputFiles) {
    if (alreadyPlaced.has(f)) continue;
    const base = path.basename(f);
    const rp2350Base = base.replace(/\.ts$/, '_rp2350.ts');
    const rp2350Sibling = rp2350Base !== base ? byBase.get(rp2350Base) : undefined;
    if (rp2350Sibling) {
      // Put the RP2350 variant first so its bodies win the emittedFunctions dedup,
      // then the plain variant right after (still emitted, for any OTHER
      // class/function in the same file the RP2350 sibling doesn't redefine).
      emitOrder.push(rp2350Sibling, f);
      alreadyPlaced.add(rp2350Sibling);
      alreadyPlaced.add(f);
    } else {
      emitOrder.push(f);
      alreadyPlaced.add(f);
    }
  }
  const emittedFiles = new Set(inputFiles.map((f) => path.resolve(f)));
  for (const f of emitOrder) {
    out.push(`// ─── ${path.basename(f)} ───`);
    transpileFileImpls(f, out);
  }

  // A monomorphized instantiation's body may reference module-private (bare, non-
  // exported) top-level consts from its OWN declaring file — normally emitted by the
  // per-file loop above, but that loop only ran over `inputFiles`. In `core` mode
  // (cpu-core.ts/rp2040.ts/rp2350.ts only), load-firmware.ts was never one of those,
  // so its own consts (WATCHDOG_SCRATCH0, VECTORED_BOOT_MAGIC, ...) were never
  // declared — even though a call site inside rp2040.ts/rp2350.ts genuinely reaches
  // this instantiation's body. Run the normal per-file pass on any declaring file not
  // already covered (harmless — it still skips the generic functions themselves,
  // per the FunctionDeclaration guard above, since it's the same emitImpl() path).
  if (genericInstantiations.size > 0) {
    const declaringFiles = new Set(
      [...genericInstantiations.values()]
        .map(({ name }) => genericFreeFunctionDecls.get(name)?.filepath)
        .filter(Boolean)
        .map((f) => path.resolve(f))
    );
    for (const f of declaringFiles) {
      if (emittedFiles.has(f)) continue;
      emittedFiles.add(f);
      out.push(`// ─── ${path.basename(f)} (pulled in by ChipType monomorphization) ───`);
      transpileFileImpls(f, out);
    }
  }

  // Emit the real monomorphized bodies for every ChipType-generic instantiation
  // discovered (see "ChipType monomorphization" above) — after the normal per-file
  // implementations, since their forward declarations (from freeFunctions, populated
  // during discovery) already precede this point.
  if (genericInstantiations.size > 0) {
    out.push('// ─── ChipType-generic instantiations ───');
    emitGenericFunctionInstantiations(out);
  }

  fs.writeFileSync(outFile, out.join('\n') + '\n');
  console.error(`cts2c: wrote ${out.length} lines to ${outFile}`);
}

main();
