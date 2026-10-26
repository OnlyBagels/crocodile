#!/usr/bin/env bash
# Applies the repository's security settings with the GitHub CLI, as the
# owner. Safe to run repeatedly. Some settings only exist for public
# repositories (on the free plan): run it once before making the repository
# public, then again right after.
#
#   gh auth login                      # as the repository owner
#   bash .github/repo-settings.sh      # or: bash .github/repo-settings.sh owner/repo
set -uo pipefail

REPO="${1:-pwalda/crocodile}"
failed=0

step() { printf '\n== %s\n' "$1"; }
# api METHOD PATH [gh api args...]: reports instead of stopping on failure.
api() {
  local method=$1 path=$2
  shift 2
  if out=$(gh api -X "$method" "repos/$REPO$path" "$@" 2>&1); then
    echo "   ok: $method $path"
  else
    echo "   FAILED: $method $path"
    echo "$out" | sed 's/^/     /' | head -5
    failed=1
  fi
}
json() { api "$1" "$2" --input -; }

gh auth status >/dev/null 2>&1 || { echo "Run 'gh auth login' first."; exit 1; }
private=$(gh api "repos/$REPO" --jq .private) || exit 1
echo "Repository $REPO ($([ "$private" = true ] && echo private || echo public))"

step 'General: no wiki or projects, tidy branches, merge commits or squash'
api PATCH '' -F has_wiki=false -F has_projects=false -F delete_branch_on_merge=true \
  -F allow_merge_commit=true -F allow_squash_merge=true -F allow_rebase_merge=false \
  -F allow_auto_merge=false -F allow_update_branch=true

step 'Dependabot alerts and security updates'
api PUT /vulnerability-alerts
api PUT /automated-security-fixes

step 'Actions: read-only token, no PR approvals by Actions'
json PUT /actions/permissions/workflow <<'EOF'
{ "default_workflow_permissions": "read", "can_approve_pull_request_reviews": false }
EOF

step 'Actions: only GitHub, verified and listed actions, pinned to a commit'
json PUT /actions/permissions <<'EOF'
{ "enabled": true, "allowed_actions": "selected" }
EOF
# A newer option; if GitHub doesn't know it yet, the rest still applies.
json PUT /actions/permissions <<'EOF'
{ "enabled": true, "allowed_actions": "selected", "sha_pinning_required": true }
EOF
json PUT /actions/permissions/selected-actions <<'EOF'
{
  "github_owned_allowed": true,
  "verified_allowed": true,
  "patterns_allowed": ["pnpm/action-setup@*", "contributor-assistant/github-action@*"]
}
EOF

step 'Actions: workflows from outside contributors wait for approval'
json PUT /actions/permissions/fork-pr-contributor-approval <<'EOF'
{ "approval_policy": "all_external_contributors" }
EOF

if [ "$private" = true ]; then
  cat <<'EOF'

== Not yet: secret scanning, push protection, private vulnerability
   reporting and the branch and tag rulesets need a public repository on
   the free plan. Make the repository public, then run this script again.
EOF
else
  step 'Secret scanning with push protection'
  json PATCH '' <<'EOF'
{
  "security_and_analysis": {
    "secret_scanning": { "status": "enabled" },
    "secret_scanning_push_protection": { "status": "enabled" }
  }
}
EOF

  step 'Private vulnerability reporting (see .github/SECURITY.md)'
  api PUT /private-vulnerability-reporting

  step 'Rulesets for main: green CI for everyone, a reviewed PR unless an admin merges it'
  ruleset() {
    local name=$1 body id
    body=$(cat)
    id=$(gh api "repos/$REPO/rulesets" --jq ".[] | select(.name == \"$name\") | .id" 2>/dev/null)
    if [ -n "$id" ]; then json PUT "/rulesets/$id" <<<"$body"; else json POST /rulesets <<<"$body"; fi
  }
  # A bypass applies to every rule in its ruleset, so the review rule gets its own:
  # the admin (the sole maintainer, who can't approve their own PRs) may merge a PR
  # without an approval, but never skips CI, and can't push to main directly.
  ruleset main <<'EOF'
{
  "name": "main",
  "target": "branch",
  "enforcement": "active",
  "conditions": { "ref_name": { "include": ["~DEFAULT_BRANCH"], "exclude": [] } },
  "bypass_actors": [],
  "rules": [
    { "type": "deletion" },
    { "type": "non_fast_forward" },
    {
      "type": "required_status_checks",
      "parameters": {
        "strict_required_status_checks_policy": false,
        "do_not_enforce_on_create": false,
        "required_status_checks": [
          { "context": "Typecheck, lint and tests" },
          { "context": "Electron end-to-end (packaged)" },
          { "context": "Desktop build (ubuntu-latest)" },
          { "context": "Desktop build (windows-latest)" },
          { "context": "Desktop build (macos-latest)" },
          { "context": "Server bundles" },
          { "context": "Analyze (javascript-typescript)" },
          { "context": "Analyze (actions)" },
          { "context": "cla" }
        ]
      }
    }
  ]
}
EOF

  ruleset 'main: reviews' <<'EOF'
{
  "name": "main: reviews",
  "target": "branch",
  "enforcement": "active",
  "conditions": { "ref_name": { "include": ["~DEFAULT_BRANCH"], "exclude": [] } },
  "bypass_actors": [{ "actor_id": 5, "actor_type": "RepositoryRole", "bypass_mode": "pull_request" }],
  "rules": [
    {
      "type": "pull_request",
      "parameters": {
        "required_approving_review_count": 1,
        "dismiss_stale_reviews_on_push": true,
        "require_code_owner_review": true,
        "require_last_push_approval": false,
        "required_review_thread_resolution": true,
        "require_extra_approval_for_unattributed_changes": true,
        "required_reviewers": [],
        "allowed_merge_methods": ["merge", "squash"]
      }
    }
  ]
}
EOF

  # Two rulesets: a bypass applies to every rule in its ruleset, so the admin
  # exception for creating tags must not share one with update and deletion.
  step 'Ruleset for release tags (v*, beta-v*): only admins create them'
  ruleset 'release tags: creation' <<'EOF'
{
  "name": "release tags: creation",
  "target": "tag",
  "enforcement": "active",
  "conditions": { "ref_name": { "include": ["refs/tags/v*", "refs/tags/beta-v*"], "exclude": [] } },
  "bypass_actors": [{ "actor_id": 5, "actor_type": "RepositoryRole", "bypass_mode": "always" }],
  "rules": [{ "type": "creation" }]
}
EOF

  step 'Ruleset for release tags: nobody moves or deletes them, admins included'
  ruleset 'release tags: immutable' <<'EOF'
{
  "name": "release tags: immutable",
  "target": "tag",
  "enforcement": "active",
  "conditions": { "ref_name": { "include": ["refs/tags/v*", "refs/tags/beta-v*"], "exclude": [] } },
  "bypass_actors": [],
  "rules": [{ "type": "update" }, { "type": "deletion" }]
}
EOF
fi

echo
if [ "$failed" = 0 ]; then echo 'All settings applied.'; else echo 'Some settings failed; see above.'; fi
exit "$failed"
