const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const test = require('node:test');
const request = require('supertest');

const { CreateApp } = require('./app.cjs');

const config = {
    webhookSecret: 'webhook-secret',
    parentRepository: 'Imperia-Rminana/tags-slave-repo'
};

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
            head: { ref: 'promotion/core/2.0.0' },
            base: { ref: 'production' }
        },
        ...overrides
    });
}

test('GET /health returns ready status', async () =>
{
    const app = CreateApp({ config, dispatchClient: async () => {} });

    const response = await request(app).get('/health');

    assert.equal(response.status, 200);
    assert.deepEqual(response.body, { status: 'ok' });
});

test('valid Core webhook dispatches the raw merge identity', async () =>
{
    const dispatches = [];
    const app = CreateApp({
        config,
        dispatchClient: async (dispatch) => dispatches.push(dispatch)
    });
    const body = CreatePayload();

    const response = await request(app)
        .post('/api/github/webhooks/pull-requests')
        .set('Content-Type', 'application/json')
        .set('X-GitHub-Event', 'pull_request')
        .set('X-GitHub-Delivery', 'delivery-1')
        .set('X-Hub-Signature-256', Sign(body))
        .send(body);

    assert.equal(response.status, 202);
    assert.deepEqual(dispatches, [{
        parentRepository: config.parentRepository,
        pullRequestNumber: 51,
        deliveryId: 'delivery-1'
    }]);
});

test('valid Booster webhook dispatches only when branch and release line agree', async () =>
{
    const dispatches = [];
    const app = CreateApp({
        config,
        dispatchClient: async (dispatch) => dispatches.push(dispatch)
    });
    const body = CreatePayload({
        pull_request: {
            number: 52,
            merged: true,
            head: { ref: 'promotion/boost/demo/2.0.1' },
            base: { ref: 'boost/demo/2.0' }
        }
    });

    const response = await request(app)
        .post('/api/github/webhooks/pull-requests')
        .set('Content-Type', 'application/json')
        .set('X-GitHub-Event', 'pull_request')
        .set('X-GitHub-Delivery', 'delivery-2')
        .set('X-Hub-Signature-256', Sign(body))
        .send(body);

    assert.equal(response.status, 202);
    assert.equal(dispatches.length, 1);
});

test('invalid HMAC is rejected before JSON parsing', async () =>
{
    const app = CreateApp({
        config,
        dispatchClient: async () => assert.fail('dispatch must not run')
    });

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

    const response = await request(app)
        .post('/api/github/webhooks/pull-requests')
        .set('Content-Type', 'application/json')
        .set('X-GitHub-Event', 'issues')
        .set('X-GitHub-Delivery', 'delivery-4')
        .set('X-Hub-Signature-256', Sign(body))
        .send(body);

    assert.equal(response.status, 204);
});

test('authenticated malformed JSON returns bad request', async () =>
{
    const app = CreateApp({ config, dispatchClient: async () => assert.fail() });
    const body = '{';

    const response = await request(app)
        .post('/api/github/webhooks/pull-requests')
        .set('Content-Type', 'application/json')
        .set('X-GitHub-Event', 'pull_request')
        .set('X-GitHub-Delivery', 'delivery-5')
        .set('X-Hub-Signature-256', Sign(body))
        .send(body);

    assert.equal(response.status, 400);
});

test('GitHub dispatch failure returns bad gateway', async () =>
{
    const app = CreateApp({
        config,
        dispatchClient: async () => { throw new Error('GitHub unavailable'); }
    });
    const body = CreatePayload();

    const response = await request(app)
        .post('/api/github/webhooks/pull-requests')
        .set('Content-Type', 'application/json')
        .set('X-GitHub-Event', 'pull_request')
        .set('X-GitHub-Delivery', 'delivery-6')
        .set('X-Hub-Signature-256', Sign(body))
        .send(body);

    assert.equal(response.status, 502);
});
