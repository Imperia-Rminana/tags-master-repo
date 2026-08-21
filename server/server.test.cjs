const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const test = require('node:test');
const request = require('supertest');

const { CreateApp } = require('./app.cjs');

const HEAD_SHA = '0123456789abcdef0123456789abcdef01234567';
const MERGE_SHA = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const config = {
    webhookSecret: 'webhook-secret',
    parentRepository: 'Imperia-Rminana/tags-slave-repo',
    developmentRepository: 'imperia-scm/tags-slave-repo-fork'
};

function CreateHead(branch, repository = config.developmentRepository)
{
    return { ref: branch, sha: HEAD_SHA, repo: { full_name: repository } };
}

function Sign(body)
{
    return `sha256=${crypto.createHmac('sha256', config.webhookSecret).update(body).digest('hex')}`;
}

function CreatePayload(overrides = {})
{
    return JSON.stringify({
        action: 'closed',
        repository: { full_name: config.parentRepository },
        pull_request: {
            number: 51,
            merged: true,
            merge_commit_sha: MERGE_SHA,
            head: CreateHead('release/2.0'),
            base: { ref: 'production' }
        },
        ...overrides
    });
}

async function PostWebhook(app, body, deliveryId = 'delivery-1', eventName = 'pull_request')
{
    return request(app)
        .post('/api/github/webhooks/pull-requests')
        .set('Content-Type', 'application/json')
        .set('X-GitHub-Event', eventName)
        .set('X-GitHub-Delivery', deliveryId)
        .set('X-Hub-Signature-256', Sign(body))
        .send(body);
}

test('GET /health returns ready status', async () =>
{
    const app = CreateApp({ config, dispatchClient: async () => {} });

    const response = await request(app).get('/health');

    assert.equal(response.status, 200);
    assert.deepEqual(response.body, { status: 'ok' });
});

test('opened candidate dispatches its current head', async () =>
{
    const dispatches = [];
    const app = CreateApp({
        config,
        dispatchClient: async (dispatch) => dispatches.push(dispatch)
    });
    const body = CreatePayload({
        action: 'opened',
        pull_request: {
            number: 51,
            merged: false,
            merge_commit_sha: null,
            head: CreateHead('release/2.0'),
            base: { ref: 'production' }
        }
    });

    const response = await PostWebhook(app, body);

    assert.equal(response.status, 202);
    assert.deepEqual(dispatches, [{
        eventType: 'promotion_candidate_changed',
        parentRepository: config.parentRepository,
        pullRequestNumber: 51,
        headSha: HEAD_SHA,
        action: 'opened',
        deliveryId: 'delivery-1'
    }]);
});

test('edited candidate dispatches validation to revoke an obsolete success', async () =>
{
    const dispatches = [];
    const app = CreateApp({
        config,
        dispatchClient: async (dispatch) => dispatches.push(dispatch)
    });
    const body = CreatePayload({
        action: 'edited',
        pull_request: {
            number: 51,
            merged: false,
            merge_commit_sha: null,
            head: CreateHead('release/2.0'),
            base: { ref: 'production' }
        }
    });

    const response = await PostWebhook(app, body);

    assert.equal(response.status, 202);
    assert.equal(dispatches[0].action, 'edited');
});

test('merged Core dispatches both source and merge SHAs', async () =>
{
    const dispatches = [];
    const app = CreateApp({
        config,
        dispatchClient: async (dispatch) => dispatches.push(dispatch)
    });
    const response = await PostWebhook(app, CreatePayload());

    assert.equal(response.status, 202);
    assert.deepEqual(dispatches, [{
        eventType: 'promotion_merged',
        parentRepository: config.parentRepository,
        pullRequestNumber: 51,
        headSha: HEAD_SHA,
        mergeCommitSha: MERGE_SHA,
        deliveryId: 'delivery-1'
    }]);
});

test('valid Booster candidate requires identical direct head and base branches', async () =>
{
    const dispatches = [];
    const app = CreateApp({
        config,
        dispatchClient: async (dispatch) => dispatches.push(dispatch)
    });
    const body = CreatePayload({
        action: 'synchronize',
        pull_request: {
            number: 52,
            merged: false,
            merge_commit_sha: null,
            head: CreateHead('boost/demo/2.0'),
            base: { ref: 'boost/demo/2.0' }
        }
    });

    const response = await PostWebhook(app, body, 'delivery-2');

    assert.equal(response.status, 202);
    assert.equal(dispatches[0].action, 'synchronize');
});

test('closed unmerged promotion releases its reservation without dispatching', async () =>
{
    const app = CreateApp({ config, dispatchClient: async () => assert.fail() });
    const body = CreatePayload({
        action: 'closed',
        pull_request: {
            number: 51,
            merged: false,
            merge_commit_sha: null,
            head: CreateHead('release/2.0'),
            base: { ref: 'production' }
        }
    });

    const response = await PostWebhook(app, body);

    assert.equal(response.status, 204);
});

test('pull requests from another Development repository are ignored', async () =>
{
    const app = CreateApp({ config, dispatchClient: async () => assert.fail() });
    const body = CreatePayload({
        action: 'opened',
        pull_request: {
            number: 51,
            merged: false,
            merge_commit_sha: null,
            head: CreateHead('release/2.0', 'other/fork'),
            base: { ref: 'production' }
        }
    });

    const response = await PostWebhook(app, body, 'delivery-other-fork');

    assert.equal(response.status, 204);
});

test('invalid HMAC is rejected before JSON parsing', async () =>
{
    const app = CreateApp({ config, dispatchClient: async () => assert.fail() });

    const response = await request(app)
        .post('/api/github/webhooks/pull-requests')
        .set('Content-Type', 'application/json')
        .set('X-GitHub-Event', 'pull_request')
        .set('X-GitHub-Delivery', 'delivery-3')
        .set('X-Hub-Signature-256', 'sha256=invalid')
        .send('not-json');

    assert.equal(response.status, 401);
});

test('authenticated irrelevant event returns no content', async () =>
{
    const app = CreateApp({ config, dispatchClient: async () => assert.fail() });
    const body = CreatePayload();

    const response = await PostWebhook(app, body, 'delivery-4', 'issues');

    assert.equal(response.status, 204);
});

test('authenticated malformed or incomplete JSON returns bad request', async () =>
{
    const app = CreateApp({ config, dispatchClient: async () => assert.fail() });
    for (const body of ['{', '{}', '{"action":"opened","repository":{},"pull_request":{}}'])
    {
        const response = await PostWebhook(app, body, 'delivery-5');
        assert.equal(response.status, 400);
    }
});

test('missing delivery and invalid merge identity return bad request', async () =>
{
    const app = CreateApp({ config, dispatchClient: async () => assert.fail() });
    const missingDelivery = await PostWebhook(app, CreatePayload(), '');
    assert.equal(missingDelivery.status, 400);

    const invalidMergeBody = CreatePayload({
        pull_request: {
            number: 51,
            merged: true,
            merge_commit_sha: 'invalid',
            head: CreateHead('release/2.0'),
            base: { ref: 'production' }
        }
    });
    const invalidMerge = await PostWebhook(app, invalidMergeBody, 'delivery-invalid');
    assert.equal(invalidMerge.status, 400);
});

test('payloads larger than one MiB are rejected', async () =>
{
    const app = CreateApp({ config, dispatchClient: async () => assert.fail() });
    const body = JSON.stringify({ padding: 'x'.repeat(1024 * 1024) });
    const response = await PostWebhook(app, body, 'delivery-large');

    assert.equal(response.status, 413);
});

test('GitHub dispatch failure returns bad gateway', async () =>
{
    const app = CreateApp({
        config,
        dispatchClient: async () => { throw new Error('GitHub unavailable'); }
    });

    const response = await PostWebhook(app, CreatePayload(), 'delivery-6');

    assert.equal(response.status, 502);
});
