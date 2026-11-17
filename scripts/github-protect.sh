#!/bin/bash
# Locks down the GitHub repository for outside contributions. Safe to run again: it updates what is there.
#   scripts/github-protect.sh [owner/repo]     (default: the repository of this checkout's origin)
#
# main: no deletion, no force push, changes only through a pull request with the code owner's approval (after the last
# push) and green checks (test, guard). Repository admins (the maintainer) bypass all of it, so she can still push to
# main directly. Actions: read-only token, no approving pull requests, outside contributors' runs wait for approval,
# only GitHub's own actions and pnpm/action-setup may run. Security: secret scanning with push protection, Dependabot
# alerts, private vulnerability reporting.
#
# Rulesets on a private repository need a paid plan; on a public one they are free. Needs `gh` logged in as an admin.
set -uo pipefail
REPO="${1:-$(gh repo view --json nameWithOwner --jq .nameWithOwner)}"
say() { printf '%s\n' "$*"; }
failed=0
# step "what" cmd...: runs one setting, says whether it took.
step() { local what="$1"; shift; if out=$("$@" 2>&1 >/dev/null); then say "ok    $what"; else say "FAIL  $what: ${out##*gh: }"; failed=1; fi; }

# ---------- main ----------
ruleset=$(cat <<'JSON'
{
  "name": "main",
  "target": "branch",
  "enforcement": "active",
  "conditions": { "ref_name": { "include": ["~DEFAULT_BRANCH"], "exclude": [] } },
  "bypass_actors": [ { "actor_id": 5, "actor_type": "RepositoryRole", "bypass_mode": "always" } ],
  "rules": [
    { "type": "deletion" },
    { "type": "non_fast_forward" },
    { "type": "pull_request", "parameters": {
        "required_approving_review_count": 1,
        "dismiss_stale_reviews_on_push": true,
        "require_code_owner_review": true,
        "require_last_push_approval": true,
        "required_review_thread_resolution": true,
        "allowed_merge_methods": ["squash"] } },
    { "type": "required_status_checks", "parameters": {
        "strict_required_status_checks_policy": true,
        "required_status_checks": [ { "context": "test" }, { "context": "guard" } ] } }
  ]
}
JSON
)
id=$(gh api "repos/$REPO/rulesets" --jq '.[] | select(.name == "main") | .id' 2>/dev/null || true)
put_ruleset() { gh api -X "$1" "$2" --input - <<<"$ruleset"; }
if [[ "$id" =~ ^[0-9]+$ ]]; then step "ruleset main (updated)" put_ruleset PUT "repos/$REPO/rulesets/$id"
else step "ruleset main (created)" put_ruleset POST "repos/$REPO/rulesets"; fi

# ---------- Actions ----------
selected() { gh api -X PUT "repos/$REPO/actions/permissions/selected-actions" --input - <<'JSON'
{ "github_owned_allowed": true, "verified_allowed": false, "patterns_allowed": ["pnpm/action-setup@*"] }
JSON
}
step "actions: only selected actions may run" gh api -X PUT "repos/$REPO/actions/permissions" -F enabled=true -f allowed_actions=selected
step "actions: GitHub's own actions and pnpm/action-setup" selected
step "actions: read-only token, cannot approve pull requests" gh api -X PUT "repos/$REPO/actions/permissions/workflow" -f default_workflow_permissions=read -F can_approve_pull_request_reviews=false
step "actions: every outside contributor's run waits for approval" gh api -X PUT "repos/$REPO/actions/permissions/fork-pr-contributor-approval" -f approval_policy=all_external_contributors

# ---------- repository settings ----------
step "repo: squash merges only, branches deleted after merge, no wiki" gh api -X PATCH "repos/$REPO" -F delete_branch_on_merge=true -F allow_merge_commit=false -F allow_rebase_merge=false -F allow_squash_merge=true -F has_wiki=false
scanning() { gh api -X PATCH "repos/$REPO" --input - <<'JSON'
{ "security_and_analysis": { "secret_scanning": { "status": "enabled" }, "secret_scanning_push_protection": { "status": "enabled" } } }
JSON
}
step "security: secret scanning with push protection" scanning
step "security: Dependabot alerts" gh api -X PUT "repos/$REPO/vulnerability-alerts"
step "security: private vulnerability reporting" gh api -X PUT "repos/$REPO/private-vulnerability-reporting"

[ "$failed" = 0 ] || say "Some settings did not take. Rulesets, outside-contributor approval, secret scanning and private reporting need a public repository (or a paid plan); run this again after publishing."
exit "$failed"
