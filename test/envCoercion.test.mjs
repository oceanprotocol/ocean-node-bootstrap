import test, { before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { cleanupHarness, loadBootstrapInternals } from './harness.mjs'

let internals
let warnings

before(async () => {
  internals = await loadBootstrapInternals()
})
after(async () => {
  await cleanupHarness()
})
beforeEach(() => {
  warnings = []
  console.warn = (line) => warnings.push(String(line))
})

const NAME = 'BOOTSTRAP_TEST_VALUE'

function withEnv(value, run) {
  const previous = process.env[NAME]
  if (value === undefined) delete process.env[NAME]
  else process.env[NAME] = value
  try {
    return run()
  } finally {
    if (previous === undefined) delete process.env[NAME]
    else process.env[NAME] = previous
  }
}

test('numeric settings reject values their consumers cannot use', () => {
  // Every consumer is a positive integer - a connection cap, a stream cap, a
  // millisecond budget. `0` mutes the node and `-1` reaches AbortSignal.timeout(-1),
  // and both used to pass straight through.
  for (const rejected of ['0', '-1', '12.7', 'abc', 'NaN', '1e999']) {
    warnings = []
    const value = withEnv(rejected, () => internals.envNumber(NAME, 42))
    assert.equal(value, 42, `"${rejected}" was accepted`)
    assert.equal(warnings.length, 1, `"${rejected}" fell back without warning`)
    assert.ok(
      warnings[0].includes(NAME),
      `warning does not name the setting: ${warnings[0]}`
    )
    assert.ok(
      warnings[0].includes(rejected),
      `warning does not quote the value: ${warnings[0]}`
    )
  }
})

test('numeric settings accept a positive integer unchanged', () => {
  assert.equal(
    withEnv('25', () => internals.envNumber(NAME, 42)),
    25
  )
  assert.equal(
    withEnv('  25  ', () => internals.envNumber(NAME, 42)),
    25
  )
  assert.deepEqual(warnings, [])
})

test('an unset, blank or literally "undefined" setting falls back silently', () => {
  for (const blank of [undefined, '', '   ', 'undefined']) {
    warnings = []
    assert.equal(
      withEnv(blank, () => internals.envNumber(NAME, 42)),
      42
    )
    assert.equal(
      withEnv(blank, () => internals.envString(NAME, 'fallback')),
      'fallback'
    )
    assert.equal(
      withEnv(blank, () => internals.envBoolean(NAME, true)),
      true
    )
    assert.deepEqual(warnings, [], `"${blank}" warned about an absent setting`)
  }
})

test('boolean settings accept the usual spellings and warn on anything else', () => {
  for (const truthy of ['true', 'TRUE', '1', 'yes', 'Yes']) {
    assert.equal(
      withEnv(truthy, () => internals.envBoolean(NAME, false)),
      true,
      truthy
    )
  }
  for (const falsy of ['false', 'FALSE', '0', 'no']) {
    assert.equal(
      withEnv(falsy, () => internals.envBoolean(NAME, true)),
      false,
      falsy
    )
  }
  assert.deepEqual(warnings, [])

  for (const nonsense of ['maybe', 'on', '2']) {
    warnings = []
    assert.equal(
      withEnv(nonsense, () => internals.envBoolean(NAME, true)),
      true,
      nonsense
    )
    assert.equal(warnings.length, 1, `"${nonsense}" fell back without warning`)
  }
})
