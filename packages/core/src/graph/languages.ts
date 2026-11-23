/**
 * Tree-sitter queries per language. `@name` is a defined name; the node captured as `@def.<kind>`
 * gives its range. `@call` is a called, constructed or rendered name; `@call.jsx` only counts when
 * capitalised (components, not HTML tags).
 * `@inherit.child` extends or implements `@inherit.base` (Go: embeds). Grammar versions: see @vscode/tree-sitter-wasm 0.3.1.
 */
export type LanguageId = 'python' | 'go' | 'java' | 'ruby' | 'javascript' | 'typescript' | 'tsx';

const EXTENSIONS: Record<string, LanguageId> = {
  py: 'python',
  go: 'go',
  java: 'java',
  rb: 'ruby',
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  jsx: 'tsx',
  ts: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  tsx: 'tsx',
};

export function languageFor(path: string): LanguageId | undefined {
  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
  return path.includes('.') ? EXTENSIONS[ext] : undefined;
}

/** The grammar file in the package's wasm directory. JSX parses with the TSX grammar. */
export const GRAMMAR_FILE: Record<LanguageId, string> = {
  python: 'tree-sitter-python.wasm',
  go: 'tree-sitter-go.wasm',
  java: 'tree-sitter-java.wasm',
  ruby: 'tree-sitter-ruby.wasm',
  javascript: 'tree-sitter-javascript.wasm',
  typescript: 'tree-sitter-typescript.wasm',
  tsx: 'tree-sitter-tsx.wasm',
};

const JS_COMMON = `
(function_declaration name: (identifier) @name) @def.function
(method_definition name: (property_identifier) @name) @def.method
(variable_declarator name: (identifier) @name value: [(arrow_function) (function_expression)]) @def.function
(call_expression function: (identifier) @call)
(call_expression function: (member_expression property: (property_identifier) @call))
(new_expression constructor: (identifier) @call)
`;

const TS_TYPES = `
(interface_declaration name: (type_identifier) @name) @def.type
(type_alias_declaration name: (type_identifier) @name) @def.type
(class_declaration name: (type_identifier) @name) @def.class
`;

const TS_INHERIT = `
(class_declaration name: (type_identifier) @inherit.child (class_heritage (extends_clause value: [(identifier) @inherit.base (member_expression property: (property_identifier) @inherit.base)])))
(class_declaration name: (type_identifier) @inherit.child (class_heritage (implements_clause [(type_identifier) @inherit.base (generic_type (type_identifier) @inherit.base)])))
(interface_declaration name: (type_identifier) @inherit.child (extends_type_clause type: [(type_identifier) @inherit.base (generic_type (type_identifier) @inherit.base)]))
`;

const JSX = `
(jsx_opening_element name: (identifier) @call.jsx)
(jsx_self_closing_element name: (identifier) @call.jsx)
`;

export const QUERIES: Record<LanguageId, string> = {
  python: `
(class_definition name: (identifier) @name) @def.class
(function_definition name: (identifier) @name) @def.function
(call function: (identifier) @call)
(call function: (attribute attribute: (identifier) @call))
(class_definition name: (identifier) @inherit.child superclasses: (argument_list [(identifier) @inherit.base (attribute attribute: (identifier) @inherit.base)]))
`,
  go: `
(type_spec name: (type_identifier) @name) @def.type
(function_declaration name: (identifier) @name) @def.function
(method_declaration name: (field_identifier) @name) @def.method
(call_expression function: (identifier) @call)
(call_expression function: (selector_expression field: (field_identifier) @call))
(type_spec name: (type_identifier) @inherit.child type: (struct_type (field_declaration_list (field_declaration !name type: [(type_identifier) @inherit.base (qualified_type name: (type_identifier) @inherit.base)]))))
`,
  java: `
(class_declaration name: (identifier) @name) @def.class
(interface_declaration name: (identifier) @name) @def.type
(enum_declaration name: (identifier) @name) @def.type
(method_declaration name: (identifier) @name) @def.method
(constructor_declaration name: (identifier) @name) @def.method
(method_invocation name: (identifier) @call)
(object_creation_expression type: (type_identifier) @call)
(class_declaration name: (identifier) @inherit.child superclass: (superclass [(type_identifier) @inherit.base (generic_type (type_identifier) @inherit.base)]))
(class_declaration name: (identifier) @inherit.child interfaces: (super_interfaces (type_list [(type_identifier) @inherit.base (generic_type (type_identifier) @inherit.base)])))
(interface_declaration name: (identifier) @inherit.child (extends_interfaces (type_list [(type_identifier) @inherit.base (generic_type (type_identifier) @inherit.base)])))
`,
  ruby: `
(class name: (constant) @name) @def.class
(module name: (constant) @name) @def.class
(method name: (identifier) @name) @def.function
(singleton_method name: (identifier) @name) @def.function
(call method: (identifier) @call)
(class name: (constant) @inherit.child superclass: (superclass [(constant) @inherit.base (scope_resolution name: (constant) @inherit.base)]))
`,
  javascript: `(class_declaration name: (identifier) @name) @def.class
(class_declaration name: (identifier) @inherit.child (class_heritage [(identifier) @inherit.base (member_expression property: (property_identifier) @inherit.base)]))
${JS_COMMON}`,
  typescript: TS_TYPES + TS_INHERIT + JS_COMMON,
  tsx: TS_TYPES + TS_INHERIT + JS_COMMON + JSX,
};
