const assert = require('node:assert/strict');
const test = require('node:test');

const { CreateDispatchParameters } = require('./github-dispatch-client.cjs');

const config = { managementRepository: 'Imperia-Rminana/tags-master-repo' };
const baseDispatch = {
    parentRepository: 'Imperia-Rminana/tags-slave-repo',
    pullRequestNumber: 51,
    headSha: '0123456789abcdef0123456789abcdef01234567',
    deliveryId: 'delivery-1'
};

test('CreateDispatchParameters creates candidate and merged contracts', () =>
{
    assert.deepEqual(CreateDispatchParameters(config, {
        ...baseDispatch,
        eventType: 'promotion_candidate_changed',
        action: 'synchronize'
    }), {
        owner: 'Imperia-Rminana',
        repo: 'tags-master-repo',
        event_type: 'promotion_candidate_changed',
        client_payload: {
            parent_repository: 'Imperia-Rminana/tags-slave-repo',
            pull_request_number: 51,
            head_sha: baseDispatch.headSha,
            delivery_id: 'delivery-1',
            action: 'synchronize'
        }
    });
    assert.deepEqual(CreateDispatchParameters(config, {
        ...baseDispatch,
        eventType: 'promotion_merged',
        mergeCommitSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
    }).client_payload.merge_commit_sha, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
});

test('CreateDispatchParameters rejects invalid repositories and events', () =>
{
    assert.throws(
        () => CreateDispatchParameters({ managementRepository: 'invalid' }, baseDispatch),
        /owner\/repository/
    );
    assert.throws(
        () => CreateDispatchParameters(config, { ...baseDispatch, eventType: 'unknown' }),
        /Unsupported/
    );
});
