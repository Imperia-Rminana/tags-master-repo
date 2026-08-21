function CreateDispatchParameters(config, dispatch)
{
    const [owner, repository] = config.managementRepository.split('/');
    if (!owner || !repository)
    {
        throw new Error('MANAGEMENT_REPOSITORY must use owner/repository format.');
    }

    const clientPayload = {
        parent_repository: dispatch.parentRepository,
        pull_request_number: dispatch.pullRequestNumber,
        head_sha: dispatch.headSha,
        delivery_id: dispatch.deliveryId
    };
    if (dispatch.eventType === 'promotion_candidate_changed')
    {
        clientPayload.action = dispatch.action;
    }
    else if (dispatch.eventType === 'promotion_merged')
    {
        clientPayload.merge_commit_sha = dispatch.mergeCommitSha;
    }
    else
    {
        throw new Error(`Unsupported repository dispatch event '${dispatch.eventType}'.`);
    }

    return {
        owner,
        repo: repository,
        event_type: dispatch.eventType,
        client_payload: clientPayload
    };
}

async function CreateGitHubDispatchClient(config)
{
    const { Octokit } = await import('@octokit/rest');
    const octokit = new Octokit({ auth: config.githubPat });

    return async (dispatch) =>
    {
        await octokit.rest.repos.createDispatchEvent(
            CreateDispatchParameters(config, dispatch)
        );
    };
}

module.exports.CreateDispatchParameters = CreateDispatchParameters;
module.exports.CreateGitHubDispatchClient = CreateGitHubDispatchClient;
