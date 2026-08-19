#!/usr/bin/env bash

# Shared release-version calculation. Callers are expected to enable strict mode.

release_error() {
  printf 'error: %s\n' "$1" >&2
  return 1
}

test_release_line() {
  [[ ${1-} =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]]
}

test_booster_name() {
  [[ ${1-} =~ ^[a-z0-9][a-z0-9-]*$ ]]
}

get_release_plan() {
  local component=${1-}
  local release_line=${2-}
  local source_branch=${3-}
  local target_sha=${4-}
  local booster_name=${5-}
  local override_version=${6-}
  local existing_tag_at_target=${7-}
  shift 7 || return 1
  local -a tags=("$@")

  test_release_line "$release_line" || {
    release_error "Release line '$release_line' must match X.Y without leading zeroes."
    return 1
  }
  [[ $target_sha =~ ^[0-9a-f]{40}$ ]] || {
    release_error "Target SHA '$target_sha' is not a full Git commit SHA."
    return 1
  }

  local expected_branch tag_prefix display_name
  case "$component" in
    core)
      [[ -z $booster_name ]] || {
        release_error 'Booster name must be empty for a Core release.'
        return 1
      }
      expected_branch="release/$release_line"
      tag_prefix='core/'
      display_name='Core'
      ;;
    booster)
      test_booster_name "$booster_name" || {
        release_error "Booster name '$booster_name' must be a lowercase ASCII slug."
        return 1
      }
      expected_branch="boost/$booster_name/$release_line"
      tag_prefix="boost/$booster_name/"
      display_name="Booster $booster_name"
      ;;
    *)
      release_error "Component '$component' must be core or booster."
      return 1
      ;;
  esac

  [[ $source_branch == "$expected_branch" ]] || {
    release_error "Source branch '$source_branch' must be exactly '$expected_branch'."
    return 1
  }

  local semver_regex='^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$'
  local tag version_part major minor patch
  local -a versioned_records=()
  for tag in "${tags[@]}"; do
    [[ -n $tag ]] || continue
    if [[ $tag == "$tag_prefix"* ]]; then
      version_part=${tag#"$tag_prefix"}
      [[ $version_part =~ $semver_regex ]] || {
        release_error "Tag '$tag' uses the component namespace but is not a supported final SemVer tag."
        return 1
      }
      major=${BASH_REMATCH[1]}
      minor=${BASH_REMATCH[2]}
      patch=${BASH_REMATCH[3]}
      versioned_records+=("$major $minor $patch $tag")
    fi
  done

  local -a sorted_records=()
  if ((${#versioned_records[@]} > 0)); then
    mapfile -t sorted_records < <(printf '%s\n' "${versioned_records[@]}" | sort -n -k1,1 -k2,2 -k3,3)
  fi

  local line_major=${release_line%%.*}
  local line_minor=${release_line#*.}
  local last_patch=-1
  local record record_tag
  for record in "${sorted_records[@]}"; do
    read -r major minor patch record_tag <<< "$record"
    if ((major == line_major && minor == line_minor && patch > last_patch)); then
      last_patch=$patch
    fi
  done

  local calculated_version is_override=false is_recovery=false
  if [[ -n $existing_tag_at_target ]]; then
    local found_existing=false existing_major existing_minor existing_patch
    for record in "${sorted_records[@]}"; do
      read -r major minor patch record_tag <<< "$record"
      if [[ $record_tag == "$existing_tag_at_target" ]]; then
        found_existing=true
        existing_major=$major
        existing_minor=$minor
        existing_patch=$patch
        break
      fi
    done
    [[ $found_existing == true ]] || {
      release_error "Recovery tag '$existing_tag_at_target' is not a valid existing tag for this component."
      return 1
    }
    ((existing_major == line_major && existing_minor == line_minor)) || {
      release_error "Recovery tag '$existing_tag_at_target' does not belong to release line '$release_line'."
      return 1
    }
    calculated_version="$existing_major.$existing_minor.$existing_patch"
    [[ -z $override_version || $override_version == "$calculated_version" ]] || {
      release_error "Override version '$override_version' conflicts with recovery tag '$existing_tag_at_target'."
      return 1
    }
    [[ -z $override_version ]] || is_override=true
    is_recovery=true
  elif [[ -n $override_version ]]; then
    [[ $override_version =~ $semver_regex ]] || {
      release_error "Override version '$override_version' must be a final SemVer X.Y.Z."
      return 1
    }
    major=${BASH_REMATCH[1]}
    minor=${BASH_REMATCH[2]}
    patch=${BASH_REMATCH[3]}
    ((major == line_major && minor == line_minor)) || {
      release_error "Override version '$override_version' must stay on release line '$release_line'."
      return 1
    }
    ((patch > last_patch)) || {
      release_error "Override patch '$patch' must be greater than the current patch '$last_patch'."
      return 1
    }
    calculated_version=$override_version
    is_override=true
  else
    calculated_version="$release_line.$((last_patch + 1))"
  fi

  local candidate_tag="$tag_prefix$calculated_version"
  if [[ $is_recovery == false ]]; then
    for tag in "${tags[@]}"; do
      [[ $tag != "$candidate_tag" ]] || {
        release_error "Candidate tag '$candidate_tag' already exists."
        return 1
      }
    done
  fi

  IFS=. read -r major minor patch <<< "$calculated_version"
  local previous_tag=''
  local previous_major=-1 previous_minor=-1 previous_patch=-1
  for record in "${sorted_records[@]}"; do
    local record_major record_minor record_patch
    read -r record_major record_minor record_patch record_tag <<< "$record"
    if ((record_major < major ||
      (record_major == major && record_minor < minor) ||
      (record_major == major && record_minor == minor && record_patch < patch))); then
      if ((record_major > previous_major ||
        (record_major == previous_major && record_minor > previous_minor) ||
        (record_major == previous_major && record_minor == previous_minor && record_patch > previous_patch))); then
        previous_major=$record_major
        previous_minor=$record_minor
        previous_patch=$record_patch
        previous_tag=$record_tag
      fi
    fi
  done

  jq -cn \
    --arg component "$component" \
    --arg display_name "$display_name" \
    --arg source_branch "$source_branch" \
    --arg release_line "$release_line" \
    --arg version "$calculated_version" \
    --arg tag "$candidate_tag" \
    --arg previous_tag "$previous_tag" \
    --arg target_sha "$target_sha" \
    --argjson is_override "$is_override" \
    --argjson is_recovery "$is_recovery" \
    '{
      component: $component,
      display_name: $display_name,
      source_branch: $source_branch,
      release_line: $release_line,
      version: $version,
      tag: $tag,
      previous_tag: $previous_tag,
      target_sha: $target_sha,
      is_override: $is_override,
      is_recovery: $is_recovery
    }'
}

