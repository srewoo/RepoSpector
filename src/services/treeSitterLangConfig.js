/**
 * Per-language tree-sitter extraction config for RepoSpector.
 *
 * Node-type knowledge here was derived empirically by dumping real ASTs from the
 * bundled grammar wasms (see scripts/ts-probe.mjs), not guessed. Each language
 * entry produces the SAME output shapes the legacy regex path emits, so every
 * downstream consumer (SymbolExtractor → graph nodes, CallGraphBuilder → edges)
 * is unchanged:
 *   - symbols:  { name, label, startLine, endLine, isExported }
 *   - imports:  { source }
 *   - calls:    { name, line }
 *   - heritage: { childName, parentName, type: 'extends' | 'implements' }
 *
 * Engine (traversal, grammar loading, memoised analysis) lives in TreeSitterParser.js.
 */

// Map file extension → { grammar: wasm grammar name, lang: config key }
export const EXT_TO_LANG = {
    js: { grammar: 'javascript', lang: 'javascript' },
    jsx: { grammar: 'javascript', lang: 'javascript' },
    mjs: { grammar: 'javascript', lang: 'javascript' },
    cjs: { grammar: 'javascript', lang: 'javascript' },
    ts: { grammar: 'typescript', lang: 'typescript' },
    tsx: { grammar: 'tsx', lang: 'typescript' },
    py: { grammar: 'python', lang: 'python' },
    java: { grammar: 'java', lang: 'java' },
    go: { grammar: 'go', lang: 'go' },
    rs: { grammar: 'rust', lang: 'rust' },
    c: { grammar: 'c', lang: 'c' },
    h: { grammar: 'c', lang: 'c' },
    cpp: { grammar: 'cpp', lang: 'cpp' },
    cc: { grammar: 'cpp', lang: 'cpp' },
    cxx: { grammar: 'cpp', lang: 'cpp' },
    hpp: { grammar: 'cpp', lang: 'cpp' },
    hxx: { grammar: 'cpp', lang: 'cpp' },
    cs: { grammar: 'c_sharp', lang: 'csharp' },
    rb: { grammar: 'ruby', lang: 'ruby' },
    php: { grammar: 'php', lang: 'php' }
};

const line = (node) => node.startPosition.row + 1;
const endLine = (node) => node.endPosition.row + 1;
const field = (node, name) => (node ? node.childForFieldName(name) : null);
const textOf = (node) => (node ? node.text : null);

/** Resolve a callee node (identifier / member access / scoped path) to a bare name. */
function calleeName(fn) {
    if (!fn) return null;
    switch (fn.type) {
        case 'identifier':
        case 'field_identifier':
        case 'property_identifier':
        case 'name':
        case 'type_identifier':
        case 'constant':
            return fn.text;
        case 'member_expression': return textOf(field(fn, 'property'));
        case 'selector_expression': return textOf(field(fn, 'field'));
        case 'attribute': return textOf(field(fn, 'attribute'));
        case 'scoped_identifier': return textOf(field(fn, 'name'));
        case 'field_expression': return textOf(field(fn, 'field'));
        case 'member_access_expression': return textOf(field(fn, 'name'));
        default: {
            const nf = field(fn, 'name');
            if (nf) return calleeName(nf);
            return null;
        }
    }
}

/** Walk up ancestors looking for an export wrapper (JS/TS). */
function hasExportAncestor(node, depth = 3) {
    let cur = node.parent;
    let d = 0;
    while (cur && d < depth) {
        if (cur.type === 'export_statement') return true;
        cur = cur.parent;
        d++;
    }
    return false;
}

/** Walk up ancestors to find the nearest container of a given type. */
function ancestorType(node, types) {
    let cur = node.parent;
    while (cur) {
        if (types.has(cur.type)) return cur.type;
        cur = cur.parent;
    }
    return null;
}

/** Resolve nested declarator name for C/C++ (function_declarator → identifier|qualified_identifier). */
function declaratorName(node) {
    let d = field(node, 'declarator');
    let guard = 0;
    while (d && guard++ < 8) {
        if (d.type === 'identifier' || d.type === 'field_identifier') return d.text;
        if (d.type === 'qualified_identifier') return textOf(field(d, 'name')) || d.text;
        const next = field(d, 'declarator');
        if (!next) break;
        d = next;
    }
    return null;
}

function modifierIncludes(node, keyword) {
    for (const child of node.namedChildren) {
        if (!child) continue;
        if ((child.type === 'modifiers' || child.type === 'modifier' || child.type === 'visibility_modifier') &&
            child.text.includes(keyword)) {
            return true;
        }
    }
    return false;
}

const goExported = (name) => !!name && name[0] === name[0].toUpperCase() && name[0] !== name[0].toLowerCase();

// --- Heritage helpers (shared) ---

function jsHeritage(classNode, name, out) {
    const heritage = classNode.namedChildren.find(c => c && c.type === 'class_heritage');
    if (!heritage) return;
    for (const child of heritage.namedChildren) {
        if (!child) continue;
        if (child.type === 'extends_clause') {
            const v = field(child, 'value') || child.namedChildren.find(c => c && c.type !== 'comment');
            if (v) out.push({ childName: name, parentName: calleeName(v) || v.text, type: 'extends' });
        } else if (child.type === 'implements_clause') {
            for (const t of child.namedChildren) {
                if (t && t.type.includes('identifier')) out.push({ childName: name, parentName: t.text, type: 'implements' });
            }
        } else if (child.type.includes('identifier')) {
            // bare `extends B` in plain JS
            out.push({ childName: name, parentName: child.text, type: 'extends' });
        }
    }
}

/**
 * Language configs. Each exposes:
 *   symbol(node, ctx)   → {name,label,startLine,endLine,isExported} | null   (called per named node)
 *   heritage(node, out) → pushes heritage records (called per named node)
 *   callNodes           → [{type, field}]
 *   importOf(node)      → source string | null  (called per named node)
 */
export const LANG_CONFIG = {
    javascript: {
        callNodes: [{ type: 'call_expression', field: 'function' }],
        importOf(node) {
            if (node.type === 'import_statement') return stripQuotes(textOf(field(node, 'source')));
            if (node.type === 'call_expression') {
                const fn = field(node, 'function');
                if (fn && (fn.text === 'require' || fn.type === 'import')) {
                    const arg = node.namedChildren.find(c => c && c.type === 'arguments');
                    const str = arg && arg.namedChildren.find(c => c && c.type === 'string');
                    return str ? stripQuotes(str.text) : null;
                }
            }
            return null;
        },
        heritage(node, out) {
            if (node.type === 'class_declaration') jsHeritage(node, textOf(field(node, 'name')), out);
        },
        symbol(node) {
            switch (node.type) {
                case 'function_declaration':
                case 'generator_function_declaration':
                    return mk(textOf(field(node, 'name')), 'Function', node, hasExportAncestor(node));
                case 'class_declaration':
                    return mk(textOf(field(node, 'name')), 'Class', node, hasExportAncestor(node));
                case 'method_definition':
                    return mk(textOf(field(node, 'name')), 'Method', node, false);
                case 'variable_declarator': {
                    const val = field(node, 'value');
                    if (val && (val.type === 'arrow_function' || val.type === 'function' || val.type === 'function_expression')) {
                        return mk(textOf(field(node, 'name')), 'Function', node, hasExportAncestor(node));
                    }
                    return null;
                }
                default: return null;
            }
        }
    },

    typescript: {
        callNodes: [{ type: 'call_expression', field: 'function' }],
        importOf(node) { return LANG_CONFIG.javascript.importOf(node); },
        heritage(node, out) {
            if (node.type === 'class_declaration') jsHeritage(node, textOf(field(node, 'name')), out);
        },
        symbol(node) {
            switch (node.type) {
                case 'function_declaration':
                case 'generator_function_declaration':
                    return mk(textOf(field(node, 'name')), 'Function', node, hasExportAncestor(node));
                case 'class_declaration':
                    return mk(textOf(field(node, 'name')), 'Class', node, hasExportAncestor(node));
                case 'method_definition':
                case 'method_signature':
                    return mk(textOf(field(node, 'name')), 'Method', node, false);
                case 'interface_declaration':
                    return mk(textOf(field(node, 'name')), 'Interface', node, hasExportAncestor(node));
                case 'type_alias_declaration':
                    return mk(textOf(field(node, 'name')), 'Type', node, hasExportAncestor(node));
                case 'enum_declaration':
                    return mk(textOf(field(node, 'name')), 'Enum', node, hasExportAncestor(node));
                case 'variable_declarator': {
                    const val = field(node, 'value');
                    if (val && (val.type === 'arrow_function' || val.type === 'function' || val.type === 'function_expression')) {
                        return mk(textOf(field(node, 'name')), 'Function', node, hasExportAncestor(node));
                    }
                    return null;
                }
                default: return null;
            }
        }
    },

    python: {
        callNodes: [{ type: 'call', field: 'function' }],
        importOf(node) {
            if (node.type === 'import_from_statement') return textOf(field(node, 'module_name'));
            if (node.type === 'import_statement') return textOf(field(node, 'name'));
            return null;
        },
        heritage(node, out) {
            if (node.type !== 'class_definition') return;
            const name = textOf(field(node, 'name'));
            const supers = field(node, 'superclasses');
            if (!supers) return;
            for (const c of supers.namedChildren) {
                if (c && c.type === 'identifier' && c.text !== 'object') {
                    out.push({ childName: name, parentName: c.text, type: 'extends' });
                }
            }
        },
        symbol(node) {
            if (node.type === 'class_definition') {
                const name = textOf(field(node, 'name'));
                return mk(name, 'Class', node, !!name && !name.startsWith('_'));
            }
            if (node.type === 'function_definition') {
                const name = textOf(field(node, 'name'));
                const inClass = ancestorType(node, new Set(['class_definition']));
                if (inClass) {
                    const exported = !name.startsWith('__') || name === '__init__';
                    return mk(name, 'Method', node, exported);
                }
                return mk(name, 'Function', node, !!name && !name.startsWith('_'));
            }
            return null;
        }
    },

    java: {
        callNodes: [{ type: 'method_invocation', field: 'name' }],
        importOf(node) {
            if (node.type === 'import_declaration') {
                const id = node.namedChildren.find(c => c && (c.type === 'scoped_identifier' || c.type === 'identifier'));
                return id ? id.text : null;
            }
            return null;
        },
        heritage(node, out) {
            if (node.type !== 'class_declaration') return;
            const name = textOf(field(node, 'name'));
            const sc = field(node, 'superclass');
            if (sc) {
                const t = sc.namedChildren.find(c => c && c.type.includes('type'));
                if (t) out.push({ childName: name, parentName: t.text, type: 'extends' });
            }
            const ifaces = field(node, 'interfaces');
            if (ifaces) {
                for (const tl of ifaces.namedChildren) {
                    if (!tl) continue;
                    for (const t of tl.namedChildren) {
                        if (t && t.type.includes('type')) out.push({ childName: name, parentName: t.text, type: 'implements' });
                    }
                }
            }
        },
        symbol(node) {
            switch (node.type) {
                case 'class_declaration': return mk(textOf(field(node, 'name')), 'Class', node, modifierIncludes(node, 'public'));
                case 'interface_declaration': return mk(textOf(field(node, 'name')), 'Interface', node, modifierIncludes(node, 'public'));
                case 'enum_declaration': return mk(textOf(field(node, 'name')), 'Enum', node, modifierIncludes(node, 'public'));
                case 'method_declaration': return mk(textOf(field(node, 'name')), 'Method', node, modifierIncludes(node, 'public'));
                default: return null;
            }
        }
    },

    go: {
        callNodes: [{ type: 'call_expression', field: 'function' }],
        importOf(node) {
            if (node.type === 'import_spec') return stripQuotes(textOf(field(node, 'path')));
            return null;
        },
        heritage() { /* Go has no class inheritance */ },
        symbol(node) {
            if (node.type === 'function_declaration') {
                const name = textOf(field(node, 'name'));
                return mk(name, 'Function', node, goExported(name));
            }
            if (node.type === 'method_declaration') {
                const name = textOf(field(node, 'name'));
                return mk(name, 'Method', node, goExported(name));
            }
            if (node.type === 'type_spec') {
                const name = textOf(field(node, 'name'));
                const t = field(node, 'type');
                if (t && t.type === 'interface_type') return mk(name, 'Interface', node, goExported(name));
                if (t && t.type === 'struct_type') return mk(name, 'Class', node, goExported(name));
            }
            return null;
        }
    },

    rust: {
        callNodes: [{ type: 'call_expression', field: 'function' }],
        importOf() { return null; /* use-decls aren't file paths */ },
        heritage(node, out) {
            if (node.type !== 'impl_item') return;
            const trait = field(node, 'trait');
            const type = field(node, 'type');
            if (trait && type) out.push({ childName: type.text, parentName: trait.text, type: 'implements' });
        },
        symbol(node) {
            const hasPub = node.namedChildren.some(c => c && c.type === 'visibility_modifier');
            switch (node.type) {
                case 'function_item': {
                    const name = textOf(field(node, 'name'));
                    const inImpl = ancestorType(node, new Set(['impl_item', 'trait_item']));
                    return mk(name, inImpl ? 'Method' : 'Function', node, hasPub);
                }
                case 'function_signature_item': return mk(textOf(field(node, 'name')), 'Method', node, hasPub);
                case 'struct_item': return mk(textOf(field(node, 'name')), 'Class', node, hasPub);
                case 'trait_item': return mk(textOf(field(node, 'name')), 'Interface', node, hasPub);
                case 'enum_item': return mk(textOf(field(node, 'name')), 'Enum', node, hasPub);
                default: return null;
            }
        }
    },

    c: {
        callNodes: [{ type: 'call_expression', field: 'function' }],
        importOf() { return null; },
        heritage() {},
        symbol(node) {
            if (node.type === 'function_definition') return mk(declaratorName(node), 'Function', node, false);
            if (node.type === 'struct_specifier' && field(node, 'name')) return mk(textOf(field(node, 'name')), 'Class', node, false);
            return null;
        }
    },

    cpp: {
        callNodes: [{ type: 'call_expression', field: 'function' }],
        importOf() { return null; },
        heritage(node, out) {
            if (node.type !== 'class_specifier' && node.type !== 'struct_specifier') return;
            const name = textOf(field(node, 'name'));
            const base = node.namedChildren.find(c => c && c.type === 'base_class_clause');
            if (!base) return;
            for (const t of base.namedChildren) {
                if (t && t.type === 'type_identifier') out.push({ childName: name, parentName: t.text, type: 'extends' });
            }
        },
        symbol(node) {
            if (node.type === 'function_definition') return mk(declaratorName(node), 'Function', node, false);
            if ((node.type === 'class_specifier' || node.type === 'struct_specifier') && field(node, 'name')) {
                return mk(textOf(field(node, 'name')), 'Class', node, false);
            }
            return null;
        }
    },

    csharp: {
        callNodes: [{ type: 'invocation_expression', field: 'function' }],
        importOf() { return null; },
        heritage(node, out) {
            if (node.type !== 'class_declaration') return;
            const name = textOf(field(node, 'name'));
            const bases = field(node, 'bases');
            if (!bases) return;
            for (const t of bases.namedChildren) {
                if (t && (t.type === 'identifier' || t.type.includes('name') || t.type.includes('type'))) {
                    out.push({ childName: name, parentName: t.text, type: 'extends' });
                }
            }
        },
        symbol(node) {
            switch (node.type) {
                case 'class_declaration':
                case 'struct_declaration': return mk(textOf(field(node, 'name')), 'Class', node, modifierIncludes(node, 'public'));
                case 'interface_declaration': return mk(textOf(field(node, 'name')), 'Interface', node, modifierIncludes(node, 'public'));
                case 'enum_declaration': return mk(textOf(field(node, 'name')), 'Enum', node, modifierIncludes(node, 'public'));
                case 'method_declaration': return mk(textOf(field(node, 'name')), 'Method', node, modifierIncludes(node, 'public'));
                default: return null;
            }
        }
    },

    ruby: {
        callNodes: [{ type: 'call', field: 'method' }, { type: 'command', field: 'method' }],
        importOf(node) {
            if (node.type === 'call' || node.type === 'command') {
                const m = field(node, 'method');
                if (m && (m.text === 'require' || m.text === 'require_relative')) {
                    const args = field(node, 'arguments') || node.namedChildren.find(c => c && c.type === 'argument_list');
                    const str = args && args.namedChildren.find(c => c && c.type === 'string');
                    const sc = str && str.namedChildren.find(c => c && c.type === 'string_content');
                    return sc ? sc.text : (str ? stripQuotes(str.text) : null);
                }
            }
            return null;
        },
        heritage(node, out) {
            if (node.type !== 'class') return;
            const name = textOf(field(node, 'name'));
            const sc = field(node, 'superclass');
            if (sc) {
                const c = sc.namedChildren.find(x => x && (x.type === 'constant' || x.type === 'scope_resolution'));
                if (c) out.push({ childName: name, parentName: c.text, type: 'extends' });
            }
        },
        symbol(node) {
            if (node.type === 'class') return mk(textOf(field(node, 'name')), 'Class', node, true);
            if (node.type === 'module') return mk(textOf(field(node, 'name')), 'Class', node, true);
            if (node.type === 'method' || node.type === 'singleton_method') {
                const name = textOf(field(node, 'name'));
                const inClass = ancestorType(node, new Set(['class', 'module']));
                return mk(name, inClass ? 'Method' : 'Function', node, true);
            }
            return null;
        }
    },

    php: {
        callNodes: [
            { type: 'function_call_expression', field: 'function' },
            { type: 'member_call_expression', field: 'name' },
            { type: 'scoped_call_expression', field: 'name' }
        ],
        importOf() { return null; },
        heritage(node, out) {
            if (node.type !== 'class_declaration') return;
            const name = textOf(field(node, 'name'));
            const base = node.namedChildren.find(c => c && c.type === 'base_clause');
            if (base) {
                for (const t of base.namedChildren) {
                    if (t && t.type === 'name') out.push({ childName: name, parentName: t.text, type: 'extends' });
                }
            }
            const impl = node.namedChildren.find(c => c && c.type === 'class_interface_clause');
            if (impl) {
                for (const t of impl.namedChildren) {
                    if (t && t.type === 'name') out.push({ childName: name, parentName: t.text, type: 'implements' });
                }
            }
        },
        symbol(node) {
            const isPublic = !modifierIncludes(node, 'private') && !modifierIncludes(node, 'protected');
            switch (node.type) {
                case 'function_definition': return mk(textOf(field(node, 'name')), 'Function', node, true);
                case 'method_declaration': return mk(textOf(field(node, 'name')), 'Method', node, isPublic);
                case 'class_declaration':
                case 'trait_declaration': return mk(textOf(field(node, 'name')), 'Class', node, true);
                case 'interface_declaration': return mk(textOf(field(node, 'name')), 'Interface', node, true);
                case 'enum_declaration': return mk(textOf(field(node, 'name')), 'Enum', node, true);
                default: return null;
            }
        }
    }
};

function mk(name, label, node, isExported) {
    if (!name) return null;
    return { name, label, startLine: line(node), endLine: endLine(node), isExported: !!isExported };
}

function stripQuotes(s) {
    if (!s) return null;
    return s.replace(/^['"`]|['"`]$/g, '');
}

export { calleeName };
