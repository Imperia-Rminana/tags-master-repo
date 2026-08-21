const { ValidateSignature } = require('./signature.cjs');

const CORE_PATTERN = /^release\/(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;
const BOOSTER_PATTERN =
    /^boost\/([a-z0-9][a-z0-9-]*)\/(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;
const SHA_PATTERN = /^[0-9a-f]{40}$/;

function IsPromotionPair(headBranch, baseBranch)
{
    if (CORE_PATTERN.test(headBranch))
    {
        return baseBranch === 'production';
    }

    return BOOSTER_PATTERN.test(headBranch) && baseBranch === headBranch;
}

function ReadObject(value, propertyName)
{
    if (!value || typeof value !== 'object' || Array.isArray(value))
    {
        throw new SyntaxError(`${propertyName} must be an object.`);
    }

    return value;
}

function ReadString(value, propertyName)
{
    if (typeof value !== 'string' || !value.trim())
    {
        throw new SyntaxError(`${propertyName} must be a non-empty string.`);
    }

    return value;
}

function ReadPullRequestEvent(payload)
{
    const event = ReadObject(JSON.parse(payload.toString('utf8')), 'payload');
    const repository = ReadObject(event.repository, 'repository');
    const pullRequest = ReadObject(event.pull_request, 'pull_request');
    const head = ReadObject(pullRequest.head, 'pull_request.head');
    const headRepository = ReadObject(head.repo, 'pull_request.head.repo');
    const base = ReadObject(pullRequest.base, 'pull_request.base');
    const pullRequestNumber = pullRequest.number;
    if (!Number.isSafeInteger(pullRequestNumber) || pullRequestNumber < 1)
    {
        throw new SyntaxError('pull_request.number must be a positive integer.');
    }
    if (typeof pullRequest.merged !== 'boolean')
    {
        throw new SyntaxError('pull_request.merged must be a boolean.');
    }

    const parsed = {
        action: ReadString(event.action, 'action'),
        repository: ReadString(repository.full_name, 'repository.full_name'),
        pullRequestNumber,
        merged: pullRequest.merged,
        mergeCommitSha: pullRequest.merge_commit_sha,
        headBranch: ReadString(head.ref, 'pull_request.head.ref'),
        headSha: ReadString(head.sha, 'pull_request.head.sha'),
        headRepository: ReadString(
            headRepository.full_name,
            'pull_request.head.repo.full_name'
        ),
        baseBranch: ReadString(base.ref, 'pull_request.base.ref')
    };
    if (!SHA_PATTERN.test(parsed.headSha))
    {
        throw new SyntaxError('pull_request.head.sha must be a commit SHA.');
    }

    return parsed;
}

async function HandleWebhook(parameters)
{
    const { config, dispatchClient, payload, eventName, deliveryId, signature } = parameters;
    if (!ValidateSignature(payload, signature, config.webhookSecret))
    {
        return { status: 401 };
    }
    if (eventName !== 'pull_request')
    {
        return { status: 204 };
    }
    if (!deliveryId)
    {
        throw new SyntaxError('Webhook delivery identity is required.');
    }

    const event = ReadPullRequestEvent(payload);
    if (event.repository !== config.parentRepository ||
        event.headRepository !== config.developmentRepository ||
        !IsPromotionPair(event.headBranch, event.baseBranch))
    {
        return { status: 204 };
    }

    if (['opened', 'reopened', 'synchronize', 'edited'].includes(event.action))
    {
        await dispatchClient({
            eventType: 'promotion_candidate_changed',
            parentRepository: config.parentRepository,
            pullRequestNumber: event.pullRequestNumber,
            headSha: event.headSha,
            action: event.action,
            deliveryId
        });
        return { status: 202 };
    }
    if (event.action !== 'closed' || !event.merged)
    {
        return { status: 204 };
    }
    if (typeof event.mergeCommitSha !== 'string' || !SHA_PATTERN.test(event.mergeCommitSha))
    {
        throw new SyntaxError('pull_request.merge_commit_sha must be a commit SHA.');
    }

    await dispatchClient({
        eventType: 'promotion_merged',
        parentRepository: config.parentRepository,
        pullRequestNumber: event.pullRequestNumber,
        headSha: event.headSha,
        mergeCommitSha: event.mergeCommitSha,
        deliveryId
    });
    return { status: 202 };
}

module.exports.HandleWebhook = HandleWebhook;
module.exports.IsPromotionPair = IsPromotionPair;
module.exports.ReadPullRequestEvent = ReadPullRequestEvent;
