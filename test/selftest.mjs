// dsh-sandbox-extra-grants selftest: behavioral assertions against the compiled
// lib/ output. Run: node test/selftest.mjs. All green = exit code 0.
// No external network and no live sandbox: confined argvs are faked per runner
// dialect; the boot case starts a minimal cordis composition in-process.
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const CJK_RE = /[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/
let passed = 0
const failures = []
function ok(name, cond, extra = '') {
  if (cond) passed++
  else failures.push(`${name}${extra ? ` - ${extra}` : ''}`)
}
function eq(name, actual, expected) {
  ok(name, JSON.stringify(actual) === JSON.stringify(expected), `actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`)
}
function throws(name, fn, pattern) {
  try {
    fn()
    ok(name, false, 'expected a throw, none thrown')
  }
  catch (error) {
    ok(name, pattern.test(String(error?.message ?? error)), `actual="${String(error?.message ?? error)}"`)
  }
}

const mod = await import(path.join(PKG, 'lib', 'index.js'))
ok('compiled entry exports the provider class', typeof mod.ExtraGrantsSandboxProvider === 'function')
ok('compiled entry default export is the provider class', mod.default === mod.ExtraGrantsSandboxProvider)
ok('compiled entry: class carries the plugin name (loader display name)', mod.ExtraGrantsSandboxProvider.name === 'dsh-sandbox-extra-grants')
ok('compiled entry: class carries the lifted config schema', mod.ExtraGrantsSandboxProvider.Config !== undefined)
ok('compiled entry exports the pure transform', typeof mod.applyExtraGrants === 'function')
ok('compiled entry exports the entry parser', typeof mod.parseGrantEntry === 'function')
ok('compiled entry exports the grant resolver', typeof mod.resolveGrants === 'function')

// Grant entry parsing and normalization (docker -v path-suffix style).
{
  const { parseGrantEntry, resolveGrants } = mod
  eq('entry: bare path defaults to rw', parseGrantEntry('/x'), { path: '/x', mode: 'rw' })
  eq('entry: explicit :rw', parseGrantEntry('/x:rw'), { path: '/x', mode: 'rw' })
  eq('entry: explicit :ro', parseGrantEntry('/x:ro'), { path: '/x', mode: 'ro' })
  eq('entry: colon-bearing path prefix, suffix on the last colon', parseGrantEntry('/a/b:ro'), { path: '/a/b', mode: 'ro' })
  throws('entry: :w rejected (no dialect expresses write-only)', () => parseGrantEntry('/x:w'), /write-only/)
  throws('entry: :r rejected (docker spelling is :ro)', () => parseGrantEntry('/x:r'), /unknown access-mode suffix/)
  throws('entry: unknown suffix rejected', () => parseGrantEntry('/x:xyz'), /unknown access-mode suffix/)
  throws('entry: unknown mode from a colon-bearing path rejected', () => parseGrantEntry('/a/b:c'), /unknown access-mode suffix/)
  throws('entry: trailing colon (empty suffix) rejected', () => parseGrantEntry('/x:'), /trailing/)
  throws('entry: empty path rejected', () => parseGrantEntry(':rw'), /empty path/)
  throws('entry: relative path rejected', () => parseGrantEntry('rel/x'), /relative path/)
  throws('entry: empty entry rejected', () => parseGrantEntry(''), /non-empty string/)

  eq('resolve: duplicates collapse keeping rw over ro', resolveGrants(['/x:ro', '/x']), [{ path: '/x', mode: 'rw' }])
  eq('resolve: duplicate order reversed still keeps rw', resolveGrants(['/x:rw', '/x:ro']), [{ path: '/x', mode: 'rw' }])
  eq('resolve: duplicate same mode keeps one entry', resolveGrants(['/x:ro', '/x:ro']), [{ path: '/x', mode: 'ro' }])
  eq('resolve: first-seen order preserved', resolveGrants(['/y', '/x:ro', '/z']), [{ path: '/y', mode: 'rw' }, { path: '/x', mode: 'ro' }, { path: '/z', mode: 'rw' }])
  eq('resolve: empty list stays empty', resolveGrants([]), [])
  throws('resolve: one invalid entry in a valid list fails the list', () => resolveGrants(['/ok', '/bad:w']), /write-only/)
}

// The lifted config schema: closed two-mode key set, optional field. The
// schema instance is callable: it validates and returns the resolved config,
// throwing a validation error on bad input.
{
  const schema = mod.ExtraGrantsSandboxProvider.Config
  const parses = (cfg) => {
    try {
      schema(cfg)
      return true
    }
    catch {
      return false
    }
  }
  ok('schema: omitted grants validates', parses({}))
  ok('schema: empty grants map validates', parses({ grants: {} }))
  ok('schema: single-mode key validates', parses({ grants: { 'workspace-write': ['/x'] } }))
  ok('schema: both mode keys validate', parses({ grants: { 'read-only': ['/x:ro'], 'workspace-write': ['/x'] } }))
  ok('schema: unknown mode key is rejected (closed mode set)', !parses({ grants: { 'both': ['/x'] } }))
  ok('schema: non-string grant entry is rejected', !parses({ grants: { 'workspace-write': [42] } }))
  ok('schema: grants as a non-object is rejected', !parses({ grants: '/x' }))
  const resolved = schema({ grants: { 'read-only': ['/x:ro'] } })
  eq('schema: resolution keeps the validated grants', resolved.grants, { 'read-only': ['/x:ro'] })
  ok('schema: omitted grants stays absent in the resolved config', !('grants' in schema({})))

  // The backing provider's schema nested under one optional `backing` field.
  ok('schema: backing field validates (partial)', parses({ backing: { probeTimeoutMs: 1000 } }))
  ok('schema: backing field validates (empty)', parses({ backing: {} }))
  ok('schema: backing + grants together validate', parses({ backing: { probeTimeoutMs: 1000 }, grants: { 'workspace-write': ['/x'] } }))
  ok('schema: omitted backing stays absent in the resolved config', !('backing' in schema({}) && !('backing' in schema({ grants: { 'read-only': ['/x:ro'] } }))))
  const backingResolved = schema({ backing: {} })
  eq('schema: empty backing resolves to the backing framework defaults',
    backingResolved.backing, { runnerCommand: [], runnerFailureSignatures: [], probeTimeoutMs: 5000 })
  const backingPartial = schema({ backing: { probeTimeoutMs: 1000 } })
  eq('schema: partial backing fills the remaining defaults',
    backingPartial.backing, { runnerCommand: [], runnerFailureSignatures: [], probeTimeoutMs: 1000 })
  ok('schema: backing rejects a non-natural probe timeout', !parses({ backing: { probeTimeoutMs: -1 } }))
  ok('schema: backing as a non-object is rejected', !parses({ backing: [1, 2] }))
}

// The pure transform, faking the confined argv per runner dialect.
{
  const { applyExtraGrants } = mod
  const base = { enforcement: 'full', denialSignatures: ['EROFS'], runnerFailureRules: [] }
  const env = { launcher: '/fake/launcher', platform: 'linux' }
  const devRW = { path: '/dev/dri/renderD129', device: true, mode: 'rw' }
  const devRO = { path: '/dev/dri/renderD129', device: true, mode: 'ro' }
  const fileRW = { path: '/var/tmp/probe', device: false, mode: 'rw' }
  const fileRO = { path: '/var/tmp/probe', device: false, mode: 'ro' }
  const logRO = { path: '/var/log/audit', device: false, mode: 'ro' }

  // 1. empty grants: the pure transform adds nothing (deep-equal; it always
  //    returns a fresh copy) and never consults the dialect or platform.
  {
    const argv = ['bwrap', '--ro-bind', '/', '/', '--', 'sh', '-c', 'x']
    eq('empty grants: transform is a deep-equal no-op', applyExtraGrants({ ...base, argv }, ['sh', '-c', 'x'], [], env), { ...base, argv })
    eq('empty grants on a non-linux platform: still a no-op (no grants, no dialect lookup)',
      applyExtraGrants({ ...base, argv }, ['sh', '-c', 'x'], [], { ...env, platform: 'darwin' }), { ...base, argv })
  }

  // 2. bwrap dialect, device node (rw): --dev-bind pair spliced at the separator.
  {
    const original = ['sh', '-c', 'x']
    const argv = ['bwrap', '--ro-bind', '/', '/', '--', ...original]
    eq('bwrap device grant (rw): --dev-bind pair before the separator',
      applyExtraGrants({ ...base, argv }, original, [devRW], env).argv,
      ['bwrap', '--ro-bind', '/', '/', '--dev-bind', '/dev/dri/renderD129', '/dev/dri/renderD129', '--', ...original])
  }

  // 2b. bwrap dialect, device node (ro): bwrap has no read-only device bind.
  throws('bwrap device grant (ro): fails closed (no read-only device bind in bwrap)',
    () => applyExtraGrants({ ...base, argv: ['bwrap', '--ro-bind', '/', '/', '--', 'sh'] }, ['sh'], [devRO], env),
    /no read-only device bind/)

  // 3. bwrap dialect, file: --bind (rw) or --ro-bind (ro) pair.
  {
    const original = ['sh', '-c', 'x']
    const argv = ['bwrap', '--ro-bind', '/', '/', '--', ...original]
    eq('bwrap file grant (rw): --bind pair before the separator',
      applyExtraGrants({ ...base, argv }, original, [fileRW], env).argv,
      ['bwrap', '--ro-bind', '/', '/', '--bind', '/var/tmp/probe', '/var/tmp/probe', '--', ...original])
    eq('bwrap file grant (ro): --ro-bind pair before the separator',
      applyExtraGrants({ ...base, argv }, original, [fileRO], env).argv,
      ['bwrap', '--ro-bind', '/', '/', '--ro-bind', '/var/tmp/probe', '/var/tmp/probe', '--', ...original])
  }

  // 4. configured operator runner: bwrap dialect matched via runnerCommand[0].
  {
    const original = ['sh', '-c', 'x']
    const argv = ['/opt/runner', '--profile', 'strict', '--', ...original]
    eq('operator runner: --dev-bind pair (matched on runnerCommand head)',
      applyExtraGrants({ ...base, argv }, original, [devRW], { ...env, runnerCommandHead: '/opt/runner' }).argv,
      ['/opt/runner', '--profile', 'strict', '--dev-bind', '/dev/dri/renderD129', '/dev/dri/renderD129', '--', ...original])
    throws('operator runner not configured: the same argv is an unknown dialect',
      () => applyExtraGrants({ ...base, argv }, original, [devRW], env),
      /no known grant dialect/)
  }

  // 5. landlock launcher dialect: --ro / --rw flags generated by the framework
  //    grantArgs, read-only grants first, caller order kept within a mode.
  {
    const original = ['sh', '-c', 'x']
    const argv = ['/fake/launcher', '--ro', '/', '--', ...original]
    const out = applyExtraGrants({ ...base, argv }, original, [fileRO, devRW, logRO], env).argv
    eq('landlock: launcher head untouched', out[0], '/fake/launcher')
    const sep = out.indexOf('--')
    const flagOf = (grant) => {
      const i = out.indexOf(grant)
      return i > 0 ? out[i - 1] : null
    }
    ok('landlock: ro file grant carries the --ro flag', flagOf('/var/tmp/probe') === '--ro')
    ok('landlock: ro directory grant carries the --ro flag', flagOf('/var/log/audit') === '--ro')
    ok('landlock: rw device grant carries the --rw flag', flagOf('/dev/dri/renderD129') === '--rw')
    const roIdx = out.indexOf('/var/log/audit')
    const rwIdx = out.indexOf('/dev/dri/renderD129')
    ok('landlock: read-only grants are emitted before read-write grants (grantArgs ordering)', roIdx > 0 && rwIdx > 0 && roIdx < rwIdx)
    ok('landlock: all grants sit between launcher and separator', roIdx < sep && rwIdx < sep)
    eq('landlock: wrapped command untouched', out.slice(sep), ['--', ...original])
  }

  // 6. the wrapped command may carry its own '--': the insertion point is
  //    length-computed, never found by scanning.
  {
    const original = ['npm', 'run', 'x', '--', '--flag']
    const argv = ['bwrap', '--ro-bind', '/', '/', '--', ...original]
    eq('command carrying its own --: grants still land before the framework separator',
      applyExtraGrants({ ...base, argv }, original, [devRW], env).argv,
      ['bwrap', '--ro-bind', '/', '/', '--dev-bind', '/dev/dri/renderD129', '/dev/dri/renderD129', '--', ...original])
  }

  // 7. unknown runner dialect: fail closed.
  throws('unknown runner: fail closed',
    () => applyExtraGrants({ ...base, argv: ['/mystery-runner', '--', 'sh'] }, ['sh'], [devRW], env),
    /no known grant dialect/)

  // 8. confined argv whose shape does not match the length computation: fail closed.
  throws('malformed confined argv (short of the original): fail closed',
    () => applyExtraGrants({ ...base, argv: ['bwrap', '--'] }, ['sh', '-c', 'x'], [devRW], env),
    /does not match the expected shape/)
  throws('malformed confined argv (computed slot is not the separator): fail closed',
    () => applyExtraGrants({ ...base, argv: ['bwrap', 'sh', 'x', '--'] }, ['--'], [devRW], env),
    /does not match the expected shape/)

  // 9. non-Linux platform with grants: fail closed.
  throws('non-linux platform with grants: fail closed',
    () => applyExtraGrants({ ...base, argv: ['/fake/launcher', '--', 'sh'] }, ['sh'], [devRW], { ...env, platform: 'darwin' }),
    /linux only/)
}

// Boot: a minimal cordis composition starts the plugin without a duplicate
// `sandbox` registration, and root-side consumers resolve the decorator.
{
  const cordis = await import('@deepseek-ai/cordis')
  const sbxlocal = await import('@deepseek-ai/dsh-sandbox-local')
  const ctx = new cordis.Context()
  await ctx.plugin(mod.ExtraGrantsSandboxProvider, {})
  const sandbox = ctx.sandbox
  ok('boot: root-side sandbox service is the decorated provider', sandbox instanceof mod.ExtraGrantsSandboxProvider)
  ok('boot: backing provider built (isolated realm registered no duplicate sandbox service)', sandbox?.impl instanceof sbxlocal.LocalSandboxProvider)
}
{ // boot with per-mode grants: entries parse at service start, composition still clean.
  const cordis = await import('@deepseek-ai/cordis')
  const ctx = new cordis.Context()
  await ctx.plugin(mod.ExtraGrantsSandboxProvider, {
    grants: {
      'workspace-write': ['/var/tmp/probe', '/proc:rw'],
      'read-only': ['/var/log/audit:ro'],
    },
  })
  ok('boot with grants: composition starts and the root-side service is the decorator', ctx.sandbox instanceof mod.ExtraGrantsSandboxProvider)
}
{ // boot: the backing pass-through field is consumed by the backing provider.
  const cordis = await import('@deepseek-ai/cordis')
  const ctx = new cordis.Context()
  await ctx.plugin(mod.ExtraGrantsSandboxProvider, {
    backing: { probeTimeoutMs: 500 },
    grants: { 'workspace-write': ['/var/tmp/probe'] },
  })
  ok('boot with backing: composition starts and the root-side service is the decorator', ctx.sandbox instanceof mod.ExtraGrantsSandboxProvider)
}
{ // migration guard: a top-level backing knob is rejected at service start.
  const cordis = await import('@deepseek-ai/cordis')
  const ctx = new cordis.Context()
  let msg = ''
  try {
    await ctx.plugin(mod.ExtraGrantsSandboxProvider, { runnerCommand: ['/opt/runner'] })
  }
  catch (error) {
    msg = String(error?.message ?? error)
  }
  ok('boot with a top-level backing field: rejected with a migration hint', /backing/.test(msg) && /top level/.test(msg))
}
{ // The backing runner-knob coupling is enforced by the backing
  // constructor at service start, so it must survive the pass-through.
  const cordis = await import('@deepseek-ai/cordis')
  const ctx = new cordis.Context()
  let msg = ''
  try {
    await ctx.plugin(mod.ExtraGrantsSandboxProvider, { backing: { runnerFailureSignatures: ['x'] } })
  }
  catch (error) {
    msg = String(error?.message ?? error)
  }
  ok('boot with backing signatures but no runnerCommand: backing coupling rejects at service start', /requires runnerCommand/.test(msg))
}

{ // manifest sanity: the package entry, file list, and peer set match the shipped shape.
  const manifest = JSON.parse(readFileSync(path.join(PKG, 'package.json'), 'utf8'))
  eq('manifest: name', manifest.name, 'dsh-sandbox-extra-grants')
  eq('manifest: version', manifest.version, '0.1.0')
  eq('manifest: module type', manifest.type, 'module')
  ok('manifest: entry', manifest.main === './lib/index.js')
  ok('manifest: exports point at entry + types', manifest.exports['.'].default === './lib/index.js' && manifest.exports['.'].types === './lib/index.d.ts')
  ok('manifest: no runtime dependencies', !('dependencies' in manifest))
  ok('manifest: MIT license declared', manifest.license === 'MIT')
  ok('manifest: license file present', existsSync(path.join(PKG, 'LICENSE')))
  ok(
    'manifest: peer set',
    ['@deepseek-ai/cordis', '@deepseek-ai/dsh-sandbox', '@deepseek-ai/dsh-sandbox-local', '@deepseek-ai/node-addon-system', '@deepseek-ai/schemastery'].every((p) => p in manifest.peerDependencies),
  )
  eq('manifest: no dsh declaration (plain dependency; composition lines are deployment-owned)', manifest.dsh, undefined)
  ok('manifest: no shipped patch file', !existsSync(path.join(PKG, 'cordis.patch.yml')))
  ok('manifest: files entries present', manifest.files.every((f) => existsSync(path.join(PKG, f.replace(/\/$/, '')))))
  ok('manifest: compiled entry present', existsSync(path.join(PKG, 'lib', 'index.js')))
}
{ // strict ASCII gate: every shipped file in the tree (source, tests, build
  // output, docs, config, lockfile) must be pure ASCII. The check is byte-level
  // (any byte > 0x7F fails): non-ASCII UTF-8 codepoints always encode to bytes
  // above 0x7F, so no codepoint-range choice can weaken the gate.
  const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    if (e.name === 'node_modules' || e.name === '.git') return []
    const p = path.join(dir, e.name)
    return e.isDirectory() ? walk(p) : [p]
  })
  for (const p of walk(PKG)) {
    const bad = readFileSync(p).findIndex((b) => b > 0x7f)
    ok(`ascii gate: ${path.relative(PKG, p)} is pure ascii${bad >= 0 ? ` (byte 0x${bad.toString(16)} at offset ${bad})` : ''}`, bad === -1)
  }
}
// selftest hygiene guard
{ // the selftest itself stays self-contained: no dangling pointers to non-shipped material
  // (design-document sections, review findings, version-round labels, machine-specific paths,
  // source line-number pointers, CJK quotes). Test-vector inputs are data, not provenance.
  const raw = readFileSync(path.join(PKG, 'test', 'selftest.mjs'), 'utf8')
  const testSrc = raw.slice(0, raw.indexOf('// selftest hygiene guard'))
  ok('selftest hygiene: no design-doc section pointers', !/design doc|design v\d|spec \u00a7|\u00a7\d/.test(testSrc))
  ok('selftest hygiene: no machine-specific paths', !/\/workspace\//.test(testSrc))
  ok('selftest hygiene: no source line-number pointers', !/L\d+[-\u2013\u2014]L?\d+/.test(testSrc))
  ok('selftest hygiene: no review-round wrappers', !/round-?\d+|review #\d/.test(testSrc))
  ok('selftest hygiene: no project version-round tags', !/\bv\d{2}\b/.test(testSrc))
  ok('selftest hygiene: no CJK characters', !CJK_RE.test(testSrc))
  ok('selftest hygiene: no review finding identifiers', !/R\d{1,2}-[A-Za-z]\w*/.test(testSrc))
  ok('selftest hygiene: no version-round identifiers', !/\bv\d{2}[A-Za-z_]\w*/.test(testSrc))
}

// results
console.log(`selftest: ${passed} passed, ${failures.length} failed`)
for (const f of failures) console.log(`  FAIL: ${f}`)
process.exit(failures.length > 0 ? 1 : 0)
