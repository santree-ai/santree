#!/usr/bin/env bash
# Assert what the signed app's trust model rests on, on the BUILT bundle:
#
#   verify-bundle-signatures.sh <path/to/santree.app> <TeamID>
#
# - the app is signed as `com.santree.desktop` (the identifier the server holds
#   its peer to), and the bundled santree-server as `com.santree.server`;
# - both carry a valid signature whose Team ID is the expected one AND the one
#   baked into the binary (`SANTREE_TEAM_ID`: the server serves only a peer of
#   that team, the app only a server of it), and have the hardened runtime on;
# - neither the app's main binary nor the server carries an entitlement that
#   would let an agent running as the same user inject code into it. The server
#   admits only santree.app and the app only that server; both checks are
#   worthless if either process can be debugged, so this is load-bearing and is
#   asserted on the shipped bytes, not on the config that was meant to produce
#   them;
# - the bundled santree-hook (which every agent's hooks run) is signed by the same
#   team with the hardened runtime, under whatever identifier codesign gave it
#   (it is not pinned: nothing in the app checks it), and carries the same
#   forbidden-entitlement bar;
# - all of that holds for EVERY architecture slice of a universal binary, not
#   just the one the machine that runs this happens to load.
#
# Run by release.yml after the build; runnable by hand on any signed bundle.
set -euo pipefail

app=${1:?usage: verify-bundle-signatures.sh <santree.app> <TeamID>}
team=${2:?usage: verify-bundle-signatures.sh <santree.app> <TeamID>}

fail() {
  echo "::error::$*"
  exit 1
}

server="$app/Contents/Resources/santree-server"
main="$app/Contents/MacOS/santree"
hook="$app/Contents/Resources/santree-hook"
test -x "$hook" || fail "$hook is missing or not executable"
test -x "$server" || fail "$server is missing or not executable"
test -x "$main" || fail "$main is missing or not executable"
[[ $team =~ ^[A-Z0-9]{10}$ ]] || fail "expected Team ID '$team' is not a 10-character Team ID"

codesign --verify --strict --verbose=2 "$server"
codesign --verify --strict --verbose=2 "$hook"
codesign --verify --strict --verbose=2 "$app"

# `codesign -d` writes to stderr. `field <name> <path> [arch]`: one field of the
# signature of `path`, of its `arch` slice when given.
field() {
  local out
  if [ -n "${3:-}" ]; then
    out=$(codesign -dv --verbose=4 --arch "$3" "$2" 2>&1)
  else
    out=$(codesign -dv --verbose=4 "$2" 2>&1)
  fi
  awk -v k="$1" 'index($0, k "=") == 1 { print substr($0, length(k) + 2); exit }' <<< "$out"
}

# The flags of the CodeDirectory, as the list inside the parentheses, of one
# slice: `flags=0x12000(library-validation,runtime)` -> `library-validation,runtime`.
code_flags() {
  codesign -dv --verbose=4 --arch "$2" "$1" 2>&1 \
    | sed -n 's/^CodeDirectory .*flags=0x[0-9a-fA-F]*(\([^)]*\)).*/\1/p' | head -n 1
}

# The bundle's own identifier is what the server's peer check names.
app_id=$(field Identifier "$app")
[ "$app_id" = com.santree.desktop ] || fail "the app's identifier is '$app_id', expected com.santree.desktop"
id=$(field Identifier "$server")
[ "$id" = com.santree.server ] || fail "server identifier is '$id', expected com.santree.server"

app_team=$(field TeamIdentifier "$app")
main_team=$(field TeamIdentifier "$main")
server_team=$(field TeamIdentifier "$server")
[ "$app_team" = "$team" ] || fail "the app's TeamIdentifier is '$app_team', expected $team"
[ "$main_team" = "$team" ] || fail "the app binary's TeamIdentifier is '$main_team', expected $team"
[ "$server_team" = "$team" ] || fail "the server's TeamIdentifier is '$server_team', expected $team"
hook_team=$(field TeamIdentifier "$hook")
[ "$hook_team" = "$team" ] || fail "the hook's TeamIdentifier is '$hook_team', expected $team"

slices_checked=0
for bin in "$main" "$server" "$hook"; do
  # `lipo -archs` names every slice of a universal binary and the one of a thin
  # one; a file it can't read isn't a Mach-O.
  archs=$(lipo -archs "$bin") || fail "$bin is not a Mach-O file"
  [ -n "$archs" ] || fail "$bin has no architecture slices"
  for arch in $archs; do
    flags=$(code_flags "$bin" "$arch")
    [[ ",$flags," == *,runtime,* ]] || fail "$bin ($arch) is not signed with the hardened runtime (flags: '$flags')"
    slice_team=$(field TeamIdentifier "$bin" "$arch")
    [ "$slice_team" = "$team" ] || fail "$bin ($arch) has TeamIdentifier '$slice_team', expected $team"
    # `-` prints the entitlements, if any; a binary without them prints nothing
    # past the `Executable=` line.
    ents=$(codesign -d --arch "$arch" --entitlements - "$bin" 2>&1)
    for key in com.apple.security.get-task-allow \
      com.apple.security.cs.disable-library-validation \
      com.apple.security.cs.allow-dyld-environment-variables; do
      if grep -qF "$key" <<< "$ents"; then
        fail "$bin ($arch) carries the $key entitlement"
      fi
    done
    slices_checked=$((slices_checked + 1))
  done
done

# The server refuses every peer unless its own signature matches the Team ID it
# was built with, and the app expects the same of the server: a build that baked
# nothing (or something else) would ship one that never serves — or, unset, one
# that fails open to uid-only. `strings` rather than a debug verb: nothing to add
# to the binary. Each slice is looked at on its own, so a universal binary
# can't carry the team in one architecture and not the other.
# (Not `grep -q`: it would close the pipe early and, under pipefail, fail the check.)
scratch=$(mktemp -d)
trap 'rm -rf "$scratch"' EXIT
for bin in "$main" "$server"; do
  name=$(basename "$bin")
  n=$(lipo -archs "$bin" | wc -w | tr -d ' ')
  for arch in $(lipo -archs "$bin"); do
    if [ "$n" -gt 1 ]; then
      slice="$scratch/$name-$arch"
      lipo "$bin" -thin "$arch" -output "$slice"
    else
      slice=$bin
    fi
    strings "$slice" | grep -F "$team" > /dev/null \
      || fail "$bin ($arch) does not contain the baked Team ID $team"
  done
done

echo "verify-bundle-signatures: app $app_id, server $id, team $team, $slices_checked slice(s) hardened-runtime with no injectable entitlements, team baked in both binaries"
