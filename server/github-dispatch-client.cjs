async function CreateGitHubDispatchClient(config)
{
    const { Octokit } = await import('@octokit/rest');
    const octokit = new Octokit({ auth: config.githubPat });
    const [owner, repository] = config.managementRepository.split('/');
    if (!owner || !repository)
    {
        throw new Error('MANAGEMENT_REPOSITORY must use owner/repository format.');
    }

    return async (dispatch) =>
    {
        await octokit.rest.repos.createDispatchEvent({
            owner,
            repo: repository,
            event_type: 'promotion_merged',
            client_payload: {
                parent_repository: dispatch.parentRepository,
                pull_request_number: dispatch.pullRequestNumber,
                delivery_id: dispatch.deliveryId
            }
        });
    };
}

module.exports.CreateGitHubDispatchClient = CreateGitHubDispatchClient;
