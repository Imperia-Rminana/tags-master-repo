# Cross-repository promotion laboratory

This repository is the active Management side of the release-promotion laboratory.
All workflows, scripts, secrets, webhook code and workflow runs live here.

- Development fork: `imperia-scm/tags-slave-repo-fork`, trunk `main`.
- Parent repository: `Imperia-Rminana/tags-slave-repo`, release branch `production`.
- Management repository: `Imperia-Rminana/tags-master-repo`.

Nothing is installed in the Development fork or parent repository. The parent only
needs the GitHub webhook configured in its repository settings.

## GitHub configuration

1. Add one classic PAT with `repo` scope as repository secret
   `SCP_STUDIO_DEVELOPMENT_PAT` in this repository.
2. Create the `release` and `release-override` Environments. Reviewers are optional in
   the laboratory.
3. Create `Imperia-Rminana/tags-slave-repo:production` once from its current `main`.
4. Require merge commits for promotion and reintegration pull requests. Do not squash
   or rebase them.
5. Push the workflows to this repository's default `main` branch.

## Local verification

```bash
npm ci
npm test
npm run test:coverage
```

Use Core and Booster release line `2.0` to avoid the existing `1.0` laboratory tags.
The expected snapshots are `promotion/core/2.0.0` and
`promotion/boost/demo/2.0.0`.

## Webhook relay configuration

Copy `.env.example` to `.env`, generate a strong random `GITHUB_WEBHOOK_SECRET`, and
set the classic PAT in `GITHUB_PAT`. Do not commit `.env`.

Run without containers for development:

```bash
npm start
curl --fail http://127.0.0.1:3000/health
```

The API validates the raw `X-Hub-Signature-256` HMAC, accepts only valid merged
promotion pull requests, and uses Octokit to emit `repository_dispatch` with event type
`promotion_merged` to this repository.

## Container deployment

The API is private to the Compose network. Container Nginx is the only service bound to
the host, and it listens only on `127.0.0.1:${WEBHOOK_BIND_PORT}`.

```bash
docker compose config
docker compose build webhook-api
docker compose up -d
curl --fail http://127.0.0.1:7796/health
docker compose logs -f webhook-api webhook-nginx
```

Install `deploy/host-nginx.conf.example` under `/etc/nginx/sites-enabled`, replacing the
example domain and port. Then validate and reload:

```bash
sudo nginx -t
sudo systemctl reload nginx
curl --fail https://YOUR_WEBHOOK_DOMAIN/health
```

Request the initial certificate with Certbot before enabling certificate paths if the
host has not issued it yet. To update, pull the desired revision and run
`docker compose build webhook-api && docker compose up -d`. To roll back, check out the
previous revision and repeat that command.

## Parent webhook

Configure this only in **Settings -> Webhooks** of
`Imperia-Rminana/tags-slave-repo`:

- Payload URL: `https://YOUR_WEBHOOK_DOMAIN/api/github/webhooks/pull-requests`
- Content type: `application/json`
- Secret: the exact `GITHUB_WEBHOOK_SECRET` value
- Events: **Pull requests** only
- Active: enabled

The webhook does not require code in the parent. A successful relevant delivery returns
`202`; an authenticated irrelevant delivery returns `204`.

## End-to-end sequence

1. Create and push `release/2.0` in the Development fork.
2. Run **Release Core** dry, then real. Verify the Development tag/release, immutable
   snapshot and PR to parent `production`.
3. Merge the parent PR with a merge commit. Verify automatic finalization creates the
   same annotated tag at the parent merge commit, opens `production -> fork/main`, and
   deletes the snapshot.
4. Create and push `boost/demo/2.0`; run the same Booster sequence. The missing parent
   `boost/demo/2.0` branch is created from parent `production`.
5. Redeliver both webhooks and manually run **Finalize merged promotion** for both PR
   numbers. No duplicate tag or pull request should be created.

## Test evidence

Record the Core and Booster workflow-run URLs and both promotion/reintegration pull
request URLs here after the remote acceptance run.
