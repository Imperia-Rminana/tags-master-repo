#!/usr/bin/env bash
set -Eeuo pipefail

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=.github/scripts/release-version.sh
source "$script_dir/release-version.sh"

component=''
release_line=''
source_branch=''
booster_name=''
override_version=''
override_reason=''
state_file=''
github_output=${GITHUB_OUTPUT-}

while (($# > 0)); do
  case "$1" in
    --component) component=${2-}; shift 2 ;;
    --release-line) release_line=${2-}; shift 2 ;;
    --source-branch) source_branch=${2-}; shift 2 ;;
    --booster-name) booster_name=${2-}; shift 2 ;;
    --override-version) override_version=${2-}; shift 2 ;;
    --override-reason) override_reason=${2-}; shift 2 ;;
    --state-file) state_file=${2-}; shift 2 ;;
    --github-output) github_output=${2-}; shift 2 ;;
    *) release_error "Unknown argument '$1'."; exit 2 ;;
  esac
done

command -v jq >/dev/null 2>&1 || {
  release_error 'jq is required.'
  exit 1
}

[[ -n $component && -n $release_line && -n $source_branch ]] || {
  release_error 'Component, release line and source branch are required.'
  exit 2
}
[[ -n $state_file && -f $state_file ]] || {
  release_error 'A readable release state file is required.'
  exit 2
}

test_release_line "$release_line" || {
  release_error "Release line '$release_line' must match X.Y without leading zeroes."
  exit 1
}
case "$component" in
  core)
    [[ -z $booster_name ]] || {
      release_error 'Booster name must be empty for a Core release.'
      exit 1
    }
    expected_branch="release/$release_line"
    ;;
  booster)
    test_booster_name "$booster_name" || {
      release_error "Booster name '$booster_name' must be a lowercase ASCII slug."
      exit 1
    }
    expected_branch="boost/$booster_name/$release_line"
    ;;
  *)
    release_error "Component '$component' must be core or booster."
    exit 1
    ;;
esac
[[ $source_branch == "$expected_branch" ]] || {
  release_error "Source branch '$source_branch' must be exactly '$expected_branch'."
  exit 1
}

override_version=$(printf '%s' "$override_version" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')
override_reason=$(printf '%s' "$override_reason" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')
if [[ -n $override_version && -z $override_reason ]] || [[ -z $override_version && -n $override_reason ]]; then
  release_error 'Override version and override reason must either both be set or both be empty.'
  exit 1
fi

state_schema=$(jq -r '.schemaVersion // empty' "$state_file") || {
  release_error 'Could not read the release state file.'
  exit 1
}
[[ $state_schema == 2 ]] || {
  release_error "Release state schema '$state_schema' is not supported."
  exit 1
}
state_source_branch=$(jq -r '.sourceBranch // empty' "$state_file")
[[ $state_source_branch == "$source_branch" ]] || {
  release_error "Release state branch '$state_source_branch' does not match '$source_branch'."
  exit 1
}
target_sha=$(jq -r '.targetSha // empty' "$state_file")
[[ $target_sha =~ ^[0-9a-f]{40}$ ]] || {
  release_error "Release state target SHA '$target_sha' is invalid."
  exit 1
}
jq -e '.tags | type == "array" and all(.[]; (.name | type == "string") and (.commitSha | test("^[0-9a-f]{40}$")))' \
  "$state_file" >/dev/null || {
  release_error 'Release state tags are invalid.'
  exit 1
}
jq -e '.reservations | type == "array" and all(.[];
  (.pullRequestNumber | type == "number") and
  (.url | type == "string") and
  (.state == "open" or .state == "merged_pending") and
  (.tag | type == "string") and
  (.sourceBranch | type == "string") and
  (.previousTag | type == "string") and
  (.isOverride | type == "boolean") and
  (.overrideReason | type == "string"))' "$state_file" >/dev/null || {
  release_error 'Release state reservations are invalid.'
  exit 1
}
mapfile -t tags < <(jq -r '.tags[].name' "$state_file")
line_tag_regex=''
if [[ $component == core ]]; then
  line_tag_regex="^core/${release_line//./\\.}\\.(0|[1-9][0-9]*)$"
else
  line_tag_regex="^boost/$booster_name/${release_line//./\\.}\\.(0|[1-9][0-9]*)$"
fi

reservation_count=$(jq --arg sourceBranch "$source_branch" \
  '[.reservations[] | select(.sourceBranch == $sourceBranch)] | length' "$state_file")
if ((reservation_count > 1)); then
  release_error "More than one active reservation exists for '$source_branch'."
  exit 1
fi
if ((reservation_count == 1)); then
  reservation_state=$(jq -r --arg sourceBranch "$source_branch" \
    '.reservations[] | select(.sourceBranch == $sourceBranch) | .state' "$state_file")
  reservation_url=$(jq -r --arg sourceBranch "$source_branch" \
    '.reservations[] | select(.sourceBranch == $sourceBranch) | .url' "$state_file")
  if [[ $reservation_state == merged_pending ]]; then
    release_error "Release reservation '$reservation_url' was merged and must be finalized before another candidate can be created."
    exit 1
  fi

  reserved_tag=$(jq -r --arg sourceBranch "$source_branch" \
    '.reservations[] | select(.sourceBranch == $sourceBranch) | .tag' "$state_file")
  reserved_previous_tag=$(jq -r --arg sourceBranch "$source_branch" \
    '.reservations[] | select(.sourceBranch == $sourceBranch) | .previousTag' "$state_file")
  reserved_is_override=$(jq -r --arg sourceBranch "$source_branch" \
    '.reservations[] | select(.sourceBranch == $sourceBranch) | .isOverride' "$state_file")
  reserved_override_reason=$(jq -r --arg sourceBranch "$source_branch" \
    '.reservations[] | select(.sourceBranch == $sourceBranch) | .overrideReason' "$state_file")

  if [[ ! $reserved_tag =~ $line_tag_regex ]]; then
    release_error "Reserved tag '$reserved_tag' does not belong to '$source_branch'."
    exit 1
  fi
  if [[ -n $override_version ]]; then
    expected_override_tag="core/$override_version"
    [[ $component == booster ]] && expected_override_tag="boost/$booster_name/$override_version"
    [[ $reserved_tag == "$expected_override_tag" && $reserved_is_override == true && $reserved_override_reason == "$override_reason" ]] || {
      release_error 'Override inputs do not match the existing signed reservation.'
      exit 1
    }
  fi

  display_name='Core'
  [[ $component == booster ]] && display_name="Booster $booster_name"
  reserved_version=${reserved_tag##*/}
  plan=$(jq -n \
    --arg display_name "$display_name" \
    --arg version "$reserved_version" \
    --arg tag "$reserved_tag" \
    --arg previous_tag "$reserved_previous_tag" \
    --arg target_sha "$target_sha" \
    --arg override_reason "$reserved_override_reason" \
    --argjson is_override "$reserved_is_override" \
    '{
      display_name: $display_name,
      version: $version,
      tag: $tag,
      previous_tag: $previous_tag,
      target_sha: $target_sha,
      is_override: $is_override,
      is_recovery: true,
      override_reason: $override_reason
    }')

  if [[ -n $github_output ]]; then
    while IFS='=' read -r key value; do
      printf '%s=%s\n' "$key" "$value" >> "$github_output"
    done < <(jq -r 'to_entries[] | "\(.key)=\(.value)"' <<< "$plan")
  fi
  jq . <<< "$plan"
  exit 0
fi

existing_tag_at_target=''
existing_patch=-1
while IFS=$'\t' read -r tag tag_commit; do
  if [[ $tag =~ $line_tag_regex ]]; then
    patch_at_target=${BASH_REMATCH[1]}
    if [[ $tag_commit == "$target_sha" ]] && ((patch_at_target > existing_patch)); then
      existing_patch=$patch_at_target
      existing_tag_at_target=$tag
    fi
  fi
done < <(jq -r '.tags[] | [.name, .commitSha] | @tsv' "$state_file")

plan=$(get_release_plan \
  "$component" \
  "$release_line" \
  "$source_branch" \
  "$target_sha" \
  "$booster_name" \
  "$override_version" \
  "$existing_tag_at_target" \
  "${tags[@]}")
plan=$(jq --arg override_reason "$override_reason" \
  '. + {override_reason: $override_reason}' <<< "$plan")

if [[ -n $github_output ]]; then
  while IFS='=' read -r key value; do
    printf '%s=%s\n' "$key" "$value" >> "$github_output"
  done < <(jq -r 'to_entries[] | "\(.key)=\(.value)"' <<< "$plan")
fi

jq . <<< "$plan"
