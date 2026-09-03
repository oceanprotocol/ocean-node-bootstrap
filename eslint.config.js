import js from '@eslint/js'
import globals from 'globals'
import tseslint from 'typescript-eslint'
import security from 'eslint-plugin-security'
import promise from 'eslint-plugin-promise'
// this pulls in eslint-config-prettier, which is why that package is a declared
// devDependency despite never being imported by name (it is an *optional* peer of
// eslint-plugin-prettier, so npm will not reliably install it on its own)
import prettierRecommended from 'eslint-plugin-prettier/recommended'

// Replaces the .eslintrc that extended eslint-config-oceanprotocol. That config is
// pinned to eslint ^8 and cannot follow eslint to flat config, so the preset is
// composed here instead. Mirrors ocean-node's eslint.config.js so both repos are
// linted by the same rule set, with two deliberate corrections that ocean-node
// still owes: `tseslint.configs.eslintRecommended` is extended (see below), and
// `no-unused-vars` is delegated to the @typescript-eslint rule of the same name
// with ocean-node's options. Both only remove false positives on TS-only syntax;
// no rule is stricter here than in ocean-node.
//
// The rule set is held at the severity the old gate actually resolved to, so this
// dependency bump does not double as a lint-debt PR. Rules that eslint 9/10 and the
// newer plugins add on top are switched off rather than fixed here.
export default tseslint.config(
  {
    // only TypeScript is linted - the previous .eslintignore ignored every .js in
    // the tree, which was build output
    ignores: ['**/*.js', '**/*.mjs', '**/*.cjs', 'dist/']
  },
  {
    files: ['**/*.ts'],
    // a stale eslint-disable is a lie about the code, so these are errors rather
    // than warnings: it keeps the directives honest as rules move around
    linterOptions: { reportUnusedDisableDirectives: 'error' },
    extends: [
      js.configs.recommended,
      // parser + plugin wiring only. The old config never pulled in
      // @typescript-eslint's `recommended`, and adopting it here would flag the
      // `any` usage that this bump deliberately leaves alone.
      tseslint.configs.base,
      // `base` wires the parser and plugin but leaves the core rules that
      // TypeScript already enforces switched on, where they misfire on TS-only
      // syntax: `no-redeclare` on overload signatures, `no-undef` on lib types
      // such as RequestInit. Disabling them is `eslintRecommended`'s job, so it
      // has to be extended alongside `base` - without it the config only passes
      // because src/ happens to contain none of those constructs. It also turns on
      // no-var/prefer-const/prefer-rest-params/prefer-spread, which src/ already
      // satisfies, so nothing is switched back off for them.
      tseslint.configs.eslintRecommended,
      security.configs.recommended,
      prettierRecommended
    ],
    // eslint-plugin-promise is registered but not extended: the old config
    // enabled promise/param-names only, not the plugin's recommended set
    plugins: { promise },
    languageOptions: {
      sourceType: 'module',
      globals: {
        ...globals.node,
        ...globals.browser,
        ...globals.mocha,
        ...globals.jest,
        NodeJS: true,
        // kept in step with ocean-node. `no-undef` is off once eslintRecommended
        // is extended, so this is only load-bearing if that rule is ever turned
        // back on - but the two repos are meant to share one rule set
        RequestInit: true
      }
    },
    rules: {
      // from .eslintrc
      'no-empty': ['error', { allowEmptyCatch: true }],
      'prefer-destructuring': ['warn', { object: true, array: false }],
      'no-dupe-class-members': ['warn'],
      'no-useless-constructor': ['warn'],
      'constructor-super': ['warn'],
      'require-await': 'error',
      // the .eslintrc set this to a bare ['error']. Options are ocean-node's, so
      // the two repos share one rule set: `args: 'none'` because a parameter name
      // in an interface method signature, an overload signature or a constructor
      // parameter property is required by the syntax and can never be "used" -
      // `after-used` only produces false positives there; `caughtErrors: 'none'`
      // so eslint 9's change of that default to 'all' does not turn the existing
      // `catch (e)` blocks into new errors.
      //
      // The core rule is delegated to its @typescript-eslint counterpart with the
      // same options: the core rule cannot see TS scopes, so it reports every
      // `enum` member and every `declare global` binding as unused. Same rule,
      // same configuration, TS-aware scope analysis.
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { args: 'none', caughtErrors: 'none', ignoreRestSiblings: true, vars: 'all' }
      ],

      // from eslint-config-standard, via eslint-config-oceanprotocol
      'no-unused-expressions': [
        'error',
        { allowShortCircuit: true, allowTernary: true, allowTaggedTemplates: true }
      ],
      'no-constant-condition': ['error', { checkLoops: false }],
      'promise/param-names': 'error',
      'no-new': 'error',
      'no-self-compare': 'error',
      'no-unmodified-loop-condition': 'error',

      // added to eslint's recommended set after v8 - not part of the old gate
      'no-useless-assignment': 'off',
      'preserve-caught-error': 'off',

      // eslint-config-oceanprotocol explicitly disabled this; it fires on every
      // bracket access
      'security/detect-object-injection': 'off'
    }
  }
)
