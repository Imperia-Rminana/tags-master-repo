#!/usr/bin/env bash
set -Eeuo pipefail

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=.github/scripts/release-version.sh
source "$script_dir/release-version.sh"

command -v jq >/dev/null 2>&1 || {
  release_error 'jq is required.'
  exit 1
}

assert_equal() {
  local expected=$1 actual=$2 message=$3
  [[ $actual == "$expected" ]] || {
    release_error "$message Expected '$expected', got '$actual'."
    exit 1
  }
  printf 'PASS: %s\n' "$message"
}

assert_fails() {
  local message=$1
  shift
  if "$@" >/dev/null 2>&1; then
    release_error "$message Expected a failure."
    exit 1
  fi
  printf 'PASS: %s\n' "$message"
}

plan_value() {
  jq -r ".$2" <<< "$1"
}

sha='0123456789abcdef0123456789abcdef01234567'

first_core=$(get_release_plan core 3.2 release/3.2 "$sha" '' '' '')
assert_equal 'core/3.2.0' "$(plan_value "$first_core" tag)" 'Core baseline'
assert_equal '' "$(plan_value "$first_core" previous_tag)" 'First Core release has no previous tag'

next_core=$(get_release_plan core 3.2 release/3.2 "$sha" '' '' '' 'core/3.1.8' 'core/3.2.0' 'core/3.2.2')
assert_equal 'core/3.2.3' "$(plan_value "$next_core" tag)" 'Core patch calculation'
assert_equal 'core/3.2.2' "$(plan_value "$next_core" previous_tag)" 'Core previous tag'

booster=$(get_release_plan booster 1.4 boost/forecast/1.4 "$sha" forecast '' '' 'boost/forecast/1.3.9' 'boost/forecast/1.4.0' 'boost/inventory/9.0.0')
assert_equal 'boost/forecast/1.4.1' "$(plan_value "$booster" tag)" 'Booster patch calculation'
assert_equal 'boost/forecast/1.4.0' "$(plan_value "$booster" previous_tag)" 'Booster tag isolation'

override=$(get_release_plan core 3.2 release/3.2 "$sha" '' 3.2.6 '' 'core/3.2.4')
assert_equal 'core/3.2.6' "$(plan_value "$override" tag)" 'Override calculation'
assert_equal 'true' "$(plan_value "$override" is_override)" 'Override flag'

recovery=$(get_release_plan core 3.2 release/3.2 "$sha" '' '' 'core/3.2.0' 'core/3.1.9' 'core/3.2.0')
assert_equal 'core/3.2.0' "$(plan_value "$recovery" tag)" 'Recovery tag'
assert_equal 'core/3.1.9' "$(plan_value "$recovery" previous_tag)" 'Recovery previous tag'
assert_equal 'true' "$(plan_value "$recovery" is_recovery)" 'Recovery flag'

old_line=$(get_release_plan core 2.4 release/2.4 "$sha" '' '' '' 'core/2.4.0' 'core/3.0.0')
assert_equal 'core/2.4.1' "$(plan_value "$old_line" tag)" 'Old release patch calculation'
assert_equal 'core/2.4.0' "$(plan_value "$old_line" previous_tag)" 'Old release comparison excludes newer lines'

assert_fails 'Core source containment' get_release_plan core 3.2 assembly/3.2 "$sha" '' '' ''
assert_fails 'Booster slug validation' get_release_plan booster 1.0 'boost/Forecast Team/1.0' "$sha" 'Forecast Team' '' ''
assert_fails 'Cross-line override' get_release_plan core 3.2 release/3.2 "$sha" '' 4.0.0 '' 'core/3.2.4'
assert_fails 'Non-increasing override' get_release_plan core 3.2 release/3.2 "$sha" '' 3.2.4 '' 'core/3.2.4'
assert_fails 'Prerelease rejection' get_release_plan core 3.2 release/3.2 "$sha" '' '' '' 'core/3.2.0-rc.1'

state_directory=$(mktemp -d)
trap 'rm -rf -- "$state_directory"' EXIT
state_file="$state_directory/release-state.json"
jq -n \
  --arg sourceBranch 'release/3.2' \
  --arg targetSha "$sha" \
  --arg previousSha 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' \
  '{
    schemaVersion: 2,
    sourceBranch: $sourceBranch,
    targetSha: $targetSha,
    reservations: [],
    tags: [
      {name: "core/3.1.9", commitSha: $previousSha},
      {name: "core/3.2.0", commitSha: $targetSha}
    ]
  }' > "$state_file"

resolved_recovery=$(bash "$script_dir/resolve-release.sh" \
  --component core \
  --release-line 3.2 \
  --source-branch release/3.2 \
  --booster-name '' \
  --override-version '' \
  --override-reason '' \
  --state-file "$state_file")
assert_equal 'core/3.2.0' "$(plan_value "$resolved_recovery" tag)" 'API state recovery tag'
assert_equal 'true' "$(plan_value "$resolved_recovery" is_recovery)" 'API state recovery flag'

reserved_state_file="$state_directory/reserved-state.json"
jq -n \
  --arg sourceBranch 'release/3.2' \
  --arg targetSha "$sha" \
  '{
    schemaVersion: 2,
    sourceBranch: $sourceBranch,
    targetSha: $targetSha,
    tags: [{name: "core/3.1.9", commitSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}],
    reservations: [{
      pullRequestNumber: 42,
      url: "https://github.com/example/parent/pull/42",
      state: "open",
      tag: "core/3.2.0",
      sourceBranch: $sourceBranch,
      previousTag: "core/3.1.9",
      isOverride: false,
      overrideReason: ""
    }]
  }' > "$reserved_state_file"
resolved_reservation=$(bash "$script_dir/resolve-release.sh" \
  --component core \
  --release-line 3.2 \
  --source-branch release/3.2 \
  --booster-name '' \
  --override-version '' \
  --override-reason '' \
  --state-file "$reserved_state_file")
assert_equal 'core/3.2.0' "$(plan_value "$resolved_reservation" tag)" 'Open reservation tag reuse'
assert_equal 'core/3.1.9' "$(plan_value "$resolved_reservation" previous_tag)" 'Open reservation previous tag'
assert_equal 'true' "$(plan_value "$resolved_reservation" is_recovery)" 'Open reservation recovery flag'

override_reserved_state_file="$state_directory/override-reserved-state.json"
jq '.reservations[0] += {
  tag: "core/3.2.6",
  isOverride: true,
  overrideReason: "Emergency reserved patch"
}' "$reserved_state_file" > "$override_reserved_state_file"
resolved_override_reservation=$(bash "$script_dir/resolve-release.sh" \
  --component core \
  --release-line 3.2 \
  --source-branch release/3.2 \
  --booster-name '' \
  --override-version '' \
  --override-reason '' \
  --state-file "$override_reserved_state_file")
assert_equal 'core/3.2.6' "$(plan_value "$resolved_override_reservation" tag)" 'Signed override reservation tag reuse'
assert_equal 'Emergency reserved patch' "$(plan_value "$resolved_override_reservation" override_reason)" 'Signed override reservation reason reuse'

merged_state_file="$state_directory/merged-state.json"
jq '.reservations[0].state = "merged_pending"' "$reserved_state_file" > "$merged_state_file"
assert_fails 'Merged reservation blocks another candidate' bash "$script_dir/resolve-release.sh" \
  --component core \
  --release-line 3.2 \
  --source-branch release/3.2 \
  --booster-name '' \
  --override-version '' \
  --override-reason '' \
  --state-file "$merged_state_file"

duplicate_state_file="$state_directory/duplicate-state.json"
jq '.reservations += [.reservations[0]]' "$reserved_state_file" > "$duplicate_state_file"
assert_fails 'Duplicate active reservations are rejected' bash "$script_dir/resolve-release.sh" \
  --component core \
  --release-line 3.2 \
  --source-branch release/3.2 \
  --booster-name '' \
  --override-version '' \
  --override-reason '' \
  --state-file "$duplicate_state_file"

assert_fails 'API state branch validation' bash "$script_dir/resolve-release.sh" \
  --component core \
  --release-line 3.2 \
  --source-branch release/3.2 \
  --booster-name '' \
  --override-version '' \
  --override-reason '' \
  --state-file /dev/null

printf 'Release version tests passed.\n'
