// Release bookkeeping for fovea: one command to bump the version, one
// command to prove the repo is internally consistent.
//
//   bun scripts/release.mjs check          # version matches CHANGELOG + badge
//   bun scripts/release.mjs bump 0.2.2     # package.json + README + CHANGELOG
//
// A release is only ever shipped through a pull request, so `bump` never
// commits and never pushes: it leaves the tree dirty and prints the branch,
// commit and PR steps for a human (or an agent) to run. The release
// workflow fires when that PR merges.
//
//   1. bun scripts/release.mjs bump 0.2.2
//   2. git switch -c release/0.2.2 && git commit -am "release: 0.2.2" && git push -u origin release/0.2.2
//   3. gh pr create --label release --title "release: 0.2.2" --fill
//   4. merge the PR -> the release workflow tags v0.2.2 and writes the notes
import { readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, "..")

const pkgPath = join(ROOT, "package.json")
const changelogPath = join(ROOT, "CHANGELOG.md")
const readmePath = join(ROOT, "README.md")

const read = (p) => readFileSync(p, "utf8")
const pkg = JSON.parse(read(pkgPath))

const BADGE_RE = /release-v(\d+\.\d+\.\d+)/

function changelogVersions(text) {
  return [...text.matchAll(/^## \[?([\d]+\.[\d]+\.[\d]+)\]?/gm)].map((m) => m[1])
}

function check() {
  const problems = []
  const changelog = read(changelogPath)
  const versions = changelogVersions(changelog)
  const readme = read(readmePath)

  if (!versions.length) problems.push("CHANGELOG.md has no `## [x.y.z]` section")
  else if (versions[0] !== pkg.version)
    problems.push(`package.json is ${pkg.version} but the newest CHANGELOG section is ${versions[0]}`)

  const badge = readme.match(BADGE_RE)
  if (!badge) problems.push("README.md has no release badge")
  else if (badge[1] !== pkg.version)
    problems.push(`README badge says v${badge[1]} but package.json is ${pkg.version}`)

  if (problems.length) {
    console.error("release check failed:")
    for (const p of problems) console.error(`  - ${p}`)
    console.error("\nfix with: bun scripts/release.mjs bump <version>")
    process.exit(1)
  }
  console.log(`release check ok: ${pkg.version} (CHANGELOG + badge agree)`)
}

function bump(target) {
  if (!/^\d+\.\d+\.\d+$/.test(target || ""))
    throw new Error(`bump needs a plain version like 0.2.2, got ${JSON.stringify(target)}`)
  if (target === pkg.version) throw new Error(`${target} is already the current version`)

  const date = new Date().toISOString().slice(0, 10)

  // package.json
  const nextPkg = { ...pkg, version: target }
  writeFileSync(pkgPath, JSON.stringify(nextPkg, null, 2) + "\n")

  // README badge
  const readme = read(readmePath)
  const badge = readme.match(BADGE_RE)
  if (!badge) throw new Error("README.md has no release badge to update")
  writeFileSync(readmePath, readme.replace(BADGE_RE, `release-v${target}`))

  // CHANGELOG: add the section if it is missing, otherwise leave the notes alone
  const changelog = read(changelogPath)
  const versions = changelogVersions(changelog)
  if (!versions.includes(target)) {
    const first = changelog.search(/^## \[?/m)
    if (first === -1) throw new Error("CHANGELOG.md has no section to insert before")
    const section = [
      `## [${target}] — ${date}`,
      "",
      "### Added",
      "",
      "- （待填：这一版对外的变化）",
      "",
      "",
    ].join("\n")
    writeFileSync(changelogPath, changelog.slice(0, first) + section + changelog.slice(first))
  }

  console.log(`bumped to ${target}`)
  console.log("")
  console.log("next:")
  console.log(`  1. edit the ${target} section in CHANGELOG.md (and the README if the behaviour changed)`)
  console.log(`  2. git switch -c release/${target}`)
  console.log(`  3. git commit -am "release: ${target}" && git push -u origin release/${target}`)
  console.log(`  4. gh pr create --label release --title "release: ${target}" --fill`)
  console.log(`  5. merge the PR -> CI runs, then the release workflow tags v${target}`)
}

const [cmd, arg] = process.argv.slice(2)
try {
  if (cmd === "check") check()
  else if (cmd === "bump") bump(arg)
  else {
    console.log("usage: bun scripts/release.mjs <check|bump 0.2.2>")
    process.exit(cmd ? 1 : 0)
  }
} catch (err) {
  console.error(String(err?.message || err))
  process.exit(1)
}
