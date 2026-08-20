function ReadConfiguration(environment)
{
    const requiredNames = [
        'GITHUB_WEBHOOK_SECRET',
        'GITHUB_PAT',
        'MANAGEMENT_REPOSITORY',
        'PARENT_REPOSITORY',
        'DEVELOPMENT_REPOSITORY',
        'DEVELOPMENT_TRUNK_BRANCH'
    ];
    for (const name of requiredNames)
    {
        if (!environment[name])
        {
            throw new Error(`Environment variable ${name} is required.`);
        }
    }

    const port = Number(environment.PORT || '3000');
    if (!Number.isSafeInteger(port) || port < 1 || port > 65535)
    {
        throw new Error('PORT must be an integer between 1 and 65535.');
    }

    return {
        port,
        webhookSecret: environment.GITHUB_WEBHOOK_SECRET,
        githubPat: environment.GITHUB_PAT,
        managementRepository: environment.MANAGEMENT_REPOSITORY,
        parentRepository: environment.PARENT_REPOSITORY,
        developmentRepository: environment.DEVELOPMENT_REPOSITORY,
        developmentTrunkBranch: environment.DEVELOPMENT_TRUNK_BRANCH
    };
}

module.exports.ReadConfiguration = ReadConfiguration;
