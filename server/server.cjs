const { CreateApp } = require('./app.cjs');
const { ReadConfiguration } = require('./config.cjs');
const { CreateGitHubDispatchClient } = require('./github-dispatch-client.cjs');

async function Start()
{
    const config = ReadConfiguration(process.env);
    const dispatchClient = await CreateGitHubDispatchClient(config);
    const app = CreateApp({ config, dispatchClient });
    app.listen(config.port, () =>
    {
        console.log(`GitHub promotion webhook API listening on port ${config.port}.`);
    });
}

Start().catch((error) =>
{
    console.error(error.message);
    process.exitCode = 1;
});
