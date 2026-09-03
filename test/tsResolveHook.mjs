/**
 * A module-resolution hook for Node's native type stripping.
 *
 * The source imports its own modules with `.js` specifiers (the TypeScript output
 * convention) even though the files on disk are `.ts`. Node 24 strips types from
 * `.ts`/`.mts` files it loads, but it does NOT remap a `.js` specifier to a sibling
 * `.ts` file, so the whole `src/telemetry/*` dependency chain fails to resolve when
 * the harness imports the real source. This hook fills that gap: whenever a `.js`
 * specifier has no `.js` file but a `.ts` sibling exists, it resolves to the `.ts`.
 */
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

export async function resolve(specifier, context, nextResolve) {
  if (specifier.endsWith('.js')) {
    const tsSpecifier = specifier.slice(0, -3) + '.ts'
    try {
      const resolved = await nextResolve(tsSpecifier, context)
      if (existsSync(fileURLToPath(resolved.url))) {
        return resolved
      }
    } catch {
      // No `.ts` sibling - fall through to the default `.js` resolution below.
    }
  }
  return nextResolve(specifier, context)
}
