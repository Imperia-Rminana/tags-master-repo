# Cross-repository promotion laboratory

This repository is the Management side of the release laboratory:

- Development fork: `imperia-scm/tags-slave-repo-fork`, trunk `main`;
- parent: `Imperia-Rminana/tags-slave-repo`, production branch `production`;
- Management: `Imperia-Rminana/tags-master-repo`.

Nothing is installed in the fork or parent. The parent only contains branches,
rulesets and the GitHub webhook configured in repository settings.

Each schema-v2 candidate marker is HMAC-signed for its concrete parent pull-request
number. Copying a valid marker to a different PR is therefore rejected.

## GitHub configuration

1. Add repository secrets `SCP_STUDIO_DEVELOPMENT_PAT` and
   `SCP_PROMOTION_CONTRACT_SECRET` to `tags-master-repo`. The latter must be a random
   value of at least 32 bytes.
2. Create `release` and `release-override` Environments.
3. Ensure `tags-slave-repo:production` exists from its current `main`.
4. Add strict rulesets for `production` and `boost/**/*` requiring
   `scp-management/release-candidate`.
5. Permit merge commits only and renew reviews after new pushes.
6. Push these workflows to the Management repository default branch.

## Local verification

```bash
npm ci
npm test
npm run test:coverage
actionlint .github/workflows/*.yml
docker compose config --quiet
git diff --check
```

## Webhook relay

Copy `.env.example` to `.env`, set a strong `GITHUB_WEBHOOK_SECRET` and place the same
classic PAT in `GITHUB_PAT`. No additional server variable is required for the signed
candidate contract.

```bash
npm start
curl --fail http://127.0.0.1:3000/health
```

The API validates the raw `X-Hub-Signature-256` HMAC and emits:

- `promotion_candidate_changed` for `opened`, `reopened`, `synchronize` and `edited`;
- `promotion_merged` for `closed + merged`.

Authenticated incomplete payloads return `400`; closed unmerged promotions return
`204` and release their version through the absence of an active PR reservation.

## Container deployment

The API remains private to the Compose network. Container Nginx is bound only to
`127.0.0.1:${WEBHOOK_BIND_PORT}`.

```bash
docker compose config
docker compose build webhook-api
docker compose up -d
curl --fail http://127.0.0.1:7796/health
docker compose logs -f webhook-api webhook-nginx
```

Install `deploy/host-nginx.conf.example` under `/etc/nginx/sites-enabled` using the
already-issued host certificate and configured domain. Validate and reload with:

```bash
sudo nginx -t
sudo systemctl reload nginx
curl --fail https://YOUR_WEBHOOK_DOMAIN/health
```

## Parent webhook

Verify the existing webhook in `Imperia-Rminana/tags-slave-repo`:

- URL: `https://YOUR_WEBHOOK_DOMAIN/api/github/webhooks/pull-requests`;
- content type: `application/json`;
- secret: exact `GITHUB_WEBHOOK_SECRET` value;
- event: **Pull requests**;
- active: enabled.

It does not need recreation because Pull requests already includes all required
actions.

## End-to-end acceptance

1. Create and push fork `release/5.0`.
2. Run **Release Core** dry, then real; verify a direct signed PR to parent production.
3. Push another commit and verify the old required status no longer permits merging.
4. Create and resolve a conflict with production; wait for the new exact-SHA build.
5. Merge with a merge commit. Verify the fork tag, GitHub Release and metadata point to
   the last included source commit; verify the parent tag points to the merge commit;
   verify `production -> fork/main` reintegration.
6. Repeat with `boost/demo/5.0`; verify a missing parent Booster branch is created from
   production.
7. Redeliver candidate and merge webhooks and run both recovery workflows manually.
8. Confirm no new `promotion/*` branches were created. Historical snapshots are not
   deleted automatically.

Record workflow, candidate PR and reintegration PR URLs after the remote acceptance
run.
